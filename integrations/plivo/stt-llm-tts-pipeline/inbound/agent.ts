/**
 * Inbound voice agent — Inworld cascaded STT → Router/LLM → TTS.
 *
 * Caller audio (Plivo μ-law) → STT; on each final transcript, stream the LLM,
 * synthesize TTS per sentence, and pace it back to Plivo. The Inworld clients
 * live in inworld.ts; telephony in index.ts; this is the turn/state machine
 * (barge-in, end_call, history).
 */
import WebSocket from "ws";
import { config } from "./config.js";
import { InworldSTT, streamLLM, synthesize, type InworldConfig, type Message } from "./inworld.js";

const PLIVO_RATE = 8000;
const PLIVO_CHUNK_SIZE = 160;                    // 20 ms of μ-law @ 8 kHz
const END_OF_UTTERANCE_MS = 800;                 // silence after a final transcript = turn complete
const GREETING = "Hello! How can I help you today?";

const CFG: InworldConfig = {
  apiKey: config.inworldApiKey,
  llmModel: config.llmModel,
  sttModel: config.sttModel,
  ttsModel: config.ttsModel,
  voice: config.voice,
  ttsSampleRate: config.ttsSampleRate,
  plivoRate: PLIVO_RATE,
  language: "en-US",
};

/** Sample tool (OpenAI format) — every example ships one so devs can extend it. */
const END_CALL_TOOL = {
  type: "function",
  function: {
    name: "end_call",
    description: "End the phone call after saying a brief goodbye, when the caller is done.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  },
};

const SENTENCE_SEGMENTER = new Intl.Segmenter("en", { granularity: "sentence" });
const LIST_MARKER = /^\s*(?:\d+[.)]|[-*•])\s*$/; // a bare "1." / "-" Intl.Segmenter splits off on its own

/**
 * Split a streaming buffer into complete sentences to synthesize, keeping the
 * trailing fragment as `rest`. Intl.Segmenter avoids false splits on "Dr."/"$4.50".
 */
function splitSentences(buf: string): { speak: string[]; rest: string } {
  const parts = [...SENTENCE_SEGMENTER.segment(buf)].map((s) => s.segment);
  if (parts.length <= 1) return { speak: [], rest: buf };
  const rest = parts.pop() ?? "";
  const speak: string[] = [];
  let carry = "";
  for (const p of parts) {
    if (LIST_MARKER.test(p)) { carry += p; continue; } // fold markers into the next sentence
    const s = (carry + p).trim();
    if (s) speak.push(s);
    carry = "";
  }
  return { speak, rest: carry + rest };
}

export interface AgentOptions {
  plivoWs: WebSocket;
  callId: string;
  streamId: string;
  fromNumber?: string;
  systemPrompt?: string;
  hangup?: () => Promise<void> | void;
}

/** Run one call; resolves when it ends (STT/Plivo socket closes or the agent hangs up). */
export function runAgent(opts: AgentOptions): Promise<void> {
  const { plivoWs, callId, streamId, hangup } = opts;
  const log = (stage: string, msg: string) => console.log(`[${callId}] [${stage}] ${msg}`);

  let prompt = opts.systemPrompt || config.systemPrompt;
  if (opts.fromNumber) prompt += `\n\n## Call Context\n- Caller: ${opts.fromNumber}\n- Call ID: ${callId}`;
  const history: Message[] = [{ role: "system", content: prompt }];
  const stt = new InworldSTT(CFG);

  let running = true;
  let processing = false;
  let outBuffer = Buffer.alloc(0);
  let txTimer: ReturnType<typeof setInterval> | null = null;
  let activeAbort: AbortController | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingTranscript = "";
  let pendingTurn: string | null = null;
  let resolveRun: (() => void) | null = null;

  // end_call: hang up once the farewell has played
  let pendingHangup = false;
  let hangupSilenceTicks = 0;
  let hangupArmedAt = 0;
  let hungUp = false;

  const isSpeaking = () => outBuffer.length > 0;

  function sendChunk(chunk: Buffer): void {
    if (plivoWs.readyState !== WebSocket.OPEN || !streamId) return;
    plivoWs.send(JSON.stringify({
      event: "playAudio",
      media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: chunk.toString("base64") },
    }));
  }

  /** Synthesize one segment and queue it; swallow a transient TTS failure, propagate AbortError. */
  async function trySpeak(text: string, signal?: AbortSignal): Promise<boolean> {
    if (!text.trim()) return false;
    try { outBuffer = Buffer.concat([outBuffer, await synthesize(CFG, text, signal)]); return true; }
    catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      log("tts", `skipped: ${(err as Error).message}`);
      return false;
    }
  }

  async function greet(): Promise<void> {
    if (await trySpeak(GREETING)) history.push({ role: "assistant", content: GREETING });
    else console.error(`[${callId}] [tts] greeting failed — check the Inworld TTS scope/format`);
  }

  async function handleTurn(transcript: string): Promise<void> {
    if (processing) { pendingTurn = transcript; return; } // queue; latest wins
    processing = true;
    log("turn", `user: ${transcript}`);
    history.push({ role: "user", content: transcript });

    const abort = new AbortController();
    activeAbort = abort;
    let full = "";
    let sentence = "";
    let spoke = false;
    const toolCalls: { name: string; args: string }[] = [];
    try {
      for await (const chunk of streamLLM(CFG, history, [END_CALL_TOOL], abort.signal)) {
        if (chunk.type === "tool_call") { toolCalls.push(chunk); continue; }
        full += chunk.text;
        sentence += chunk.text;
        const { speak, rest } = splitSentences(sentence);
        for (const s of speak) if (await trySpeak(s, abort.signal)) spoke = true;
        sentence = rest;
      }
      if (sentence.trim() && await trySpeak(sentence.trim(), abort.signal)) spoke = true;
      // end_call with no spoken content → synthesize a goodbye so we don't hang up on silence.
      if (toolCalls.some((tc) => tc.name === "end_call") && !spoke) await trySpeak("Thanks for calling. Goodbye!", abort.signal);
      for (const tc of toolCalls) if (tc.name === "end_call") armHangup(tc.args);
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // barge-in; finally still runs
      console.error(`[${callId}] [turn] error: ${(err as Error).message}`);
      await trySpeak("Sorry, I ran into a problem. Could you say that again?");
    } finally {
      if (full.trim()) history.push({ role: "assistant", content: full }); // record even a partial reply
      processing = false;
      activeAbort = null;
      if (pendingTurn && !pendingHangup) { const next = pendingTurn; pendingTurn = null; void handleTurn(next); }
      else pendingTurn = null;
    }
  }

  function armHangup(argsJson: string): void {
    let reason = "";
    try { reason = String(JSON.parse(argsJson || "{}").reason || ""); } catch { /* keep "" */ }
    pendingHangup = true;
    hangupArmedAt = Date.now();
    log("end_call", reason || "requested");
  }

  function bargeIn(): void {
    log("barge-in", "user interrupted");
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    pendingTranscript = "";
    pendingTurn = null; // drop a turn queued mid-processing — the caller has taken the floor
    // Caller re-engaged — cancel any armed end_call hangup so we don't drop them.
    if (pendingHangup && !hungUp) { pendingHangup = false; hangupSilenceTicks = 0; hangupArmedAt = 0; }
    outBuffer = Buffer.alloc(0);
    activeAbort?.abort();
    if (plivoWs.readyState === WebSocket.OPEN) plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: streamId }));
  }

  /** Hang up once. Falls back to closing the media stream if hangup is missing/fails. */
  function doHangup(): void {
    if (hungUp) return;
    hungUp = true;
    if (!hangup) { try { plivoWs.close(); } catch { /* noop */ } return; }
    Promise.resolve(hangup()).catch((err) => {
      console.error(`[${callId}] [end_call] hangup failed: ${(err as Error).message}`);
      try { plivoWs.close(); } catch { /* noop */ }
    });
  }

  function finish(): void {
    if (!running) return;
    running = false;
    if (silenceTimer) clearTimeout(silenceTimer);
    if (txTimer) { clearInterval(txTimer); txTimer = null; }
    activeAbort?.abort();
    stt.close();
    try { if (plivoWs.readyState === WebSocket.OPEN) plivoWs.close(); } catch { /* noop */ }
    log("session", "ended");
    resolveRun?.();
    resolveRun = null;
  }

  function onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "media" && msg.media?.payload) stt.sendCallerAudio(msg.media.payload);
    else if (msg.event === "stop") finish();
  }

  // STT events
  stt.on("ready", () => void greet());
  stt.on("transcript", (text, isFinal) => {
    if (isSpeaking()) bargeIn();           // caller spoke while audio was queued
    if (!isFinal) return;
    pendingTranscript = (pendingTranscript + " " + text).trim();
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      const utterance = pendingTranscript;
      pendingTranscript = "";
      if (utterance) void handleTurn(utterance);
    }, END_OF_UTTERANCE_MS);
  });
  stt.on("closed", () => finish());

  return new Promise<void>((resolve) => {
    resolveRun = resolve;
    plivoWs.on("message", onPlivoMessage);
    plivoWs.on("close", finish);
    plivoWs.on("error", finish);

    // Paced sender (one 20 ms frame/tick) so barge-in can drop un-played audio; also drives the hangup.
    txTimer = setInterval(() => {
      if (outBuffer.length >= PLIVO_CHUNK_SIZE) {
        sendChunk(outBuffer.subarray(0, PLIVO_CHUNK_SIZE));
        outBuffer = outBuffer.subarray(PLIVO_CHUNK_SIZE);
      } else if (outBuffer.length > 0 && !processing) {
        sendChunk(outBuffer);
        outBuffer = Buffer.alloc(0);
      }

      if (pendingHangup && !hungUp) {
        if (Date.now() - hangupArmedAt > 12000) doHangup();                      // stall backstop
        else if (!processing && outBuffer.length === 0) { if (++hangupSilenceTicks >= 30) doHangup(); }
        else hangupSilenceTicks = 0;
      }
    }, 20);

    stt.connect();
  });
}
