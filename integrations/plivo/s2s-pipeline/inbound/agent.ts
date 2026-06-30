/**
 * Inbound voice agent — Inworld Realtime (speech-to-speech).
 *
 * Bridges caller audio (Plivo) to the Inworld Realtime client and paces the
 * agent's audio back. Audio is G.711 μ-law @ 8 kHz on both legs, so it passes
 * through untouched. Telephony lives in index.ts; the Inworld protocol in
 * inworld.ts; this is the call state machine (barge-in + end_call).
 */
import WebSocket from "ws";
import { config } from "./config.js";
import { InworldRealtime } from "./inworld.js";

const PLIVO_CHUNK_SIZE = 160; // 20 ms of μ-law @ 8 kHz

/** Sample tool the model can call to hang up — every example ships one so devs can extend it. */
const END_CALL_TOOL = {
  type: "function",
  name: "end_call",
  description: "End the phone call after saying a brief goodbye, when the caller is done.",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "Why the call is ending." } },
    required: ["reason"],
  },
};

export interface AgentOptions {
  plivoWs: WebSocket;
  callId: string;
  streamId: string;
  fromNumber?: string;
  systemPrompt?: string;
  /** Hang up the live call (telephony lives in index.ts; the agent just asks). */
  hangup?: () => Promise<void> | void;
}

/** Run one call; resolves when it ends (either socket closes or the agent hangs up). */
export function runAgent(opts: AgentOptions): Promise<void> {
  const { plivoWs, callId, streamId, hangup } = opts;
  const log = (stage: string, msg: string) => console.log(`[${callId}] [${stage}] ${msg}`);

  let outBuffer = Buffer.alloc(0);
  let responseGenerating = false;
  let running = true;
  let txTimer: ReturnType<typeof setInterval> | null = null;

  // end_call: hang up once the farewell has actually played
  let pendingHangup = false;
  let farewellStarted = false;
  let hangupSilenceTicks = 0;
  let hangupArmedAt = 0;
  let hungUp = false;

  let instructions = opts.systemPrompt || config.systemPrompt;
  if (opts.fromNumber) instructions += `\n\n## Call Context\n- Caller: ${opts.fromNumber}\n- Call ID: ${callId}`;
  const inworld = new InworldRealtime(`voice-${callId}`, instructions, [END_CALL_TOOL]);

  const isSpeaking = () => responseGenerating || outBuffer.length > 0;

  function sendChunk(chunk: Buffer): void {
    if (plivoWs.readyState !== WebSocket.OPEN || !streamId) return;
    plivoWs.send(JSON.stringify({
      event: "playAudio",
      media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: chunk.toString("base64") },
    }));
  }

  function bargeIn(): void {
    log("barge-in", "user interrupted");
    responseGenerating = false;
    // Caller re-engaged — cancel any armed end_call hangup so we don't drop them.
    if (pendingHangup && !hungUp) { pendingHangup = false; farewellStarted = false; hangupSilenceTicks = 0; hangupArmedAt = 0; }
    outBuffer = Buffer.alloc(0);
    if (plivoWs.readyState === WebSocket.OPEN) plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: streamId }));
    inworld.cancelResponse();
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

  /** Single teardown path: stops the pump, closes both sockets, resolves run(). */
  let resolveRun: (() => void) | null = null;
  function finish(): void {
    if (!running) return;
    running = false;
    if (txTimer) { clearInterval(txTimer); txTimer = null; }
    log("session", "ended");
    inworld.close();
    try { if (plivoWs.readyState === WebSocket.OPEN) plivoWs.close(); } catch { /* noop */ }
    resolveRun?.();
    resolveRun = null;
  }

  function onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "media" && msg.media?.payload) inworld.appendAudio(msg.media.payload); // μ-law passthrough
    else if (msg.event === "stop") finish();
  }

  // Inworld events
  inworld.on("ready", () => inworld.greet());
  inworld.on("audio", (audioB64) => {
    responseGenerating = true;
    if (pendingHangup) farewellStarted = true; // the goodbye is now playing
    if (audioB64) outBuffer = Buffer.concat([outBuffer, Buffer.from(audioB64, "base64")]);
  });
  inworld.on("responseDone", () => { responseGenerating = false; });
  inworld.on("userTranscript", (text) => log("user", text));
  inworld.on("speechStarted", () => { if (isSpeaking()) bargeIn(); });
  inworld.on("toolCall", (toolCallId, name, argsJson) => {
    if (name !== "end_call") return;
    let reason = "";
    try { reason = String(JSON.parse(argsJson || "{}").reason || ""); } catch { /* keep "" */ }
    inworld.sendToolResult(toolCallId, { ok: true });        // let the model voice a closing line
    pendingHangup = true;
    hangupArmedAt = Date.now();
    if (isSpeaking()) farewellStarted = true;                // goodbye said in the same turn as the tool call
    log("end_call", reason || "requested");
  });
  inworld.on("closed", () => finish());

  return new Promise<void>((resolve) => {
    resolveRun = resolve;
    plivoWs.on("message", onPlivoMessage);
    plivoWs.on("close", finish);
    plivoWs.on("error", finish);

    // Paced sender — one 20 ms frame/tick — so a barge-in can drop un-played
    // audio; also drives the end_call hangup once the farewell has played.
    txTimer = setInterval(() => {
      if (outBuffer.length >= PLIVO_CHUNK_SIZE) {
        sendChunk(outBuffer.subarray(0, PLIVO_CHUNK_SIZE));
        outBuffer = outBuffer.subarray(PLIVO_CHUNK_SIZE);
      } else if (outBuffer.length > 0 && !responseGenerating) {
        sendChunk(outBuffer);
        outBuffer = Buffer.alloc(0);
      }

      if (pendingHangup && !hungUp) {
        if (Date.now() - hangupArmedAt > 12000) doHangup();                  // stall backstop
        else if (farewellStarted && !isSpeaking()) { if (++hangupSilenceTicks >= 30) doHangup(); }
        else hangupSilenceTicks = 0;
      }
    }, 20);

    inworld.connect();
  });
}
