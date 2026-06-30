/**
 * Inbound voice agent — Inworld cascaded STT → Router/LLM → TTS.
 *
 * Orchestrates one call: caller audio (Plivo μ-law) → STT; on each final
 * transcript, stream the LLM, synthesize TTS per sentence, and pace it back to
 * Plivo. The Inworld clients live in inworld.ts; telephony in server.ts; this
 * file is the turn/state machine (barge-in, end_call, history).
 */
import WebSocket from "ws";
import { config } from "./config.js";
import { InworldSTT, streamLLM, synthesize, type InworldConfig, type Message, type SttHandlers } from "./inworld.js";

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

interface AgentOptions {
  plivoWs: WebSocket;
  callId: string;
  streamId: string;
  fromNumber?: string;
  systemPrompt?: string;
  hangup?: () => Promise<void> | void;
}

class InworldCascadedAgent implements SttHandlers {
  private readonly stt: InworldSTT;
  private readonly history: Message[];

  private running = false;
  private processing = false;
  private outBuffer = Buffer.alloc(0);
  private txTimer: ReturnType<typeof setInterval> | null = null;
  private activeAbort: AbortController | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTranscript = "";
  private pendingTurn: string | null = null;
  private resolveDone: (() => void) | null = null;

  // end_call: hang up once the farewell has played
  private pendingHangup = false;
  private hangupSilenceTicks = 0;
  private hangupArmedAt = 0;
  private hungUp = false;

  constructor(private readonly opts: AgentOptions) {
    let prompt = opts.systemPrompt || config.systemPrompt;
    if (opts.fromNumber) prompt += `\n\n## Call Context\n- Caller: ${opts.fromNumber}\n- Call ID: ${opts.callId}`;
    this.history = [{ role: "system", content: prompt }];
    this.stt = new InworldSTT(CFG, this);
  }

  private log(stage: string, msg: string): void { console.log(`[${this.opts.callId}] [${stage}] ${msg}`); }

  run(): Promise<void> {
    this.running = true;
    return new Promise((resolve) => {
      this.resolveDone = resolve;
      this.startTxPump();
      this.stt.connect(() => void this.greet());
      this.opts.plivoWs.on("message", (d: Buffer) => this.onPlivoMessage(d));
      this.opts.plivoWs.on("close", () => this.finish());
      this.opts.plivoWs.on("error", () => this.finish());
    });
  }

  // ── STT events (SttHandlers) ──────────────────────────────────────────────
  onTranscript(text: string, isFinal: boolean): void {
    if (this.isSpeaking()) this.bargeIn(); // caller spoke while audio was queued
    if (!isFinal) return;
    this.pendingTranscript = (this.pendingTranscript + " " + text).trim();
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      const utterance = this.pendingTranscript;
      this.pendingTranscript = "";
      if (utterance) void this.handleTurn(utterance);
    }, END_OF_UTTERANCE_MS);
  }
  onClose(): void { this.finish(); }

  private onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "media" && msg.media?.payload) this.stt.sendCallerAudio(msg.media.payload);
    else if (msg.event === "stop") this.finish();
  }

  /** Speak the opening line and record it; a failure here is a fatal config signal. */
  private async greet(): Promise<void> {
    if (await this.trySpeak(GREETING)) this.history.push({ role: "assistant", content: GREETING });
    else console.error(`[${this.opts.callId}] [tts] greeting failed — check the Inworld TTS scope/format`);
  }

  // ── turn: LLM stream → per-sentence TTS → Plivo ───────────────────────────
  private async handleTurn(transcript: string): Promise<void> {
    if (this.processing) { this.pendingTurn = transcript; return; } // queue; latest wins
    this.processing = true;
    this.log("turn", `user: ${transcript}`);
    this.history.push({ role: "user", content: transcript });

    const abort = new AbortController();
    this.activeAbort = abort;
    let full = "";
    let sentence = "";
    let spoke = false;
    const toolCalls: { id: string; name: string; args: string }[] = [];
    try {
      for await (const chunk of streamLLM(CFG, this.history, [END_CALL_TOOL], abort.signal)) {
        if (chunk.type === "tool_call") { toolCalls.push(chunk); continue; }
        full += chunk.text;
        sentence += chunk.text;
        const { speak, rest } = splitSentences(sentence);
        for (const s of speak) if (await this.trySpeak(s, abort.signal)) spoke = true;
        sentence = rest;
      }
      if (sentence.trim() && await this.trySpeak(sentence.trim(), abort.signal)) spoke = true;
      // end_call with no spoken content → synthesize a goodbye so we don't hang up on silence.
      if (toolCalls.some((tc) => tc.name === "end_call") && !spoke) await this.trySpeak("Thanks for calling. Goodbye!", abort.signal);
      for (const tc of toolCalls) this.handleToolCall(tc.name, tc.args);
    } catch (err) {
      if ((err as Error).name === "AbortError") return; // barge-in; handled in finally
      console.error(`[${this.opts.callId}] [turn] error: ${(err as Error).message}`);
      await this.trySpeak("Sorry, I ran into a problem. Could you say that again?");
    } finally {
      if (full.trim()) this.history.push({ role: "assistant", content: full }); // record even a partial reply
      this.processing = false;
      this.activeAbort = null;
      if (this.pendingTurn && !this.pendingHangup) { const next = this.pendingTurn; this.pendingTurn = null; void this.handleTurn(next); }
      else this.pendingTurn = null;
    }
  }

  /** Synthesize one segment and queue it; swallow a transient TTS failure, propagate AbortError. */
  private async trySpeak(text: string, signal?: AbortSignal): Promise<boolean> {
    if (!text.trim()) return false;
    try { this.outBuffer = Buffer.concat([this.outBuffer, await synthesize(CFG, text, signal)]); return true; }
    catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      this.log("tts", `skipped: ${(err as Error).message}`);
      return false;
    }
  }

  private isSpeaking(): boolean { return this.outBuffer.length > 0; }

  /** Paced sender (one 20 ms frame/tick) so barge-in can drop un-played audio; also drives the hangup. */
  private startTxPump(): void {
    this.txTimer = setInterval(() => {
      if (this.outBuffer.length >= PLIVO_CHUNK_SIZE) {
        this.sendChunkToPlivo(this.outBuffer.subarray(0, PLIVO_CHUNK_SIZE));
        this.outBuffer = this.outBuffer.subarray(PLIVO_CHUNK_SIZE);
      } else if (this.outBuffer.length > 0 && !this.processing) {
        this.sendChunkToPlivo(this.outBuffer);
        this.outBuffer = Buffer.alloc(0);
      }

      if (this.pendingHangup && !this.hungUp) {
        if (Date.now() - this.hangupArmedAt > 12000) this.doHangup();                      // stall backstop
        else if (!this.processing && this.outBuffer.length === 0) { if (++this.hangupSilenceTicks >= 30) this.doHangup(); }
        else this.hangupSilenceTicks = 0;
      }
    }, 20);
  }

  private sendChunkToPlivo(chunk: Buffer): void {
    if (this.opts.plivoWs.readyState !== WebSocket.OPEN || !this.opts.streamId) return;
    this.opts.plivoWs.send(JSON.stringify({
      event: "playAudio",
      media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: chunk.toString("base64") },
    }));
  }

  private bargeIn(): void {
    this.log("barge-in", "user interrupted");
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.pendingTranscript = "";
    // Caller re-engaged — cancel any armed end_call hangup so we don't drop them.
    if (this.pendingHangup && !this.hungUp) { this.pendingHangup = false; this.hangupSilenceTicks = 0; this.hangupArmedAt = 0; }
    this.outBuffer = Buffer.alloc(0);
    this.activeAbort?.abort();
    if (this.opts.plivoWs.readyState === WebSocket.OPEN) {
      this.opts.plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: this.opts.streamId }));
    }
  }

  private handleToolCall(name: string, argsJson: string): void {
    if (name !== "end_call") return;
    let reason = "";
    try { reason = String(JSON.parse(argsJson || "{}").reason || ""); } catch { /* keep "" */ }
    this.pendingHangup = true;
    this.hangupArmedAt = Date.now();
    this.log("end_call", reason || "requested");
  }

  /** Hang up once. Falls back to closing the media stream if hangup is missing/fails. */
  private doHangup(): void {
    if (this.hungUp) return;
    this.hungUp = true;
    if (!this.opts.hangup) { try { this.opts.plivoWs.close(); } catch { /* noop */ } return; }
    Promise.resolve(this.opts.hangup()).catch((err) => {
      console.error(`[${this.opts.callId}] [end_call] hangup failed: ${(err as Error).message}`);
      try { this.opts.plivoWs.close(); } catch { /* noop */ }
    });
  }

  /** Single teardown path: clears timers, aborts, closes both sockets, resolves run(). */
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.txTimer) { clearInterval(this.txTimer); this.txTimer = null; }
    this.activeAbort?.abort();
    this.stt.close();
    try { if (this.opts.plivoWs.readyState === WebSocket.OPEN) this.opts.plivoWs.close(); } catch { /* noop */ }
    this.log("session", "ended");
    this.resolveDone?.();
  }
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  await new InworldCascadedAgent(opts).run();
}
