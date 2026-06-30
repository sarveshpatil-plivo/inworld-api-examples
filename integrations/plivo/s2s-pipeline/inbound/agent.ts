/**
 * Inbound voice agent — Inworld Realtime (speech-to-speech).
 *
 * Orchestrates one call: bridges caller audio (Plivo) to the Inworld Realtime
 * client and paces the agent's audio back. Audio is G.711 μ-law @ 8 kHz on both
 * legs, so it passes through untouched. Telephony lives in server.ts; the Inworld
 * protocol lives in inworld.ts; this file is the call state machine.
 */
import WebSocket from "ws";
import { config } from "./config.js";
import { InworldRealtime, type RealtimeHandlers } from "./inworld.js";

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

interface AgentOptions {
  plivoWs: WebSocket;
  callId: string;
  streamId: string;
  fromNumber?: string;
  systemPrompt?: string;
  /** Hang up the live call (telephony lives in server.ts; the agent just asks). */
  hangup?: () => Promise<void> | void;
}

class InworldS2SAgent implements RealtimeHandlers {
  private readonly inworld: InworldRealtime;
  private running = false;
  private responseGenerating = false;
  private outBuffer = Buffer.alloc(0);
  private txTimer: ReturnType<typeof setInterval> | null = null;
  private resolveRun: (() => void) | null = null;

  // end_call: hang up once the farewell has actually played
  private pendingHangup = false;
  private farewellStarted = false;
  private hangupSilenceTicks = 0;
  private hangupArmedAt = 0;
  private hungUp = false;

  private turns = 0;
  private bargeIns = 0;

  constructor(private readonly opts: AgentOptions) {
    let instructions = opts.systemPrompt || config.systemPrompt;
    if (opts.fromNumber) instructions += `\n\n## Call Context\n- Caller: ${opts.fromNumber}\n- Call ID: ${opts.callId}`;
    this.inworld = new InworldRealtime(
      { apiKey: config.inworldApiKey, sessionId: `voice-${opts.callId}`, instructions,
        llmModel: config.llmModel, sttModel: config.sttModel, ttsModel: config.ttsModel,
        voice: config.voice, vadEagerness: config.vadEagerness, tools: [END_CALL_TOOL] },
      this,
    );
  }

  private log(stage: string, msg: string): void { console.log(`[${this.opts.callId}] [${stage}] ${msg}`); }

  run(): Promise<void> {
    this.running = true;
    return new Promise((resolve) => {
      this.resolveRun = resolve;
      this.startTxPump();
      this.inworld.connect();
      this.opts.plivoWs.on("message", (d: Buffer) => this.onPlivoMessage(d));
      this.opts.plivoWs.on("close", () => this.finish());
      this.opts.plivoWs.on("error", () => this.finish());
    });
  }

  // ── Inworld events (RealtimeHandlers) ─────────────────────────────────────
  onReady(): void { this.inworld.greet(); }
  onAudioDelta(audioB64: string): void {
    this.responseGenerating = true;
    if (this.pendingHangup) this.farewellStarted = true; // the goodbye is now playing
    if (audioB64) this.outBuffer = Buffer.concat([this.outBuffer, Buffer.from(audioB64, "base64")]);
  }
  onResponseDone(): void { this.responseGenerating = false; this.turns += 1; }
  onUserTranscript(text: string): void { this.log("user", text); }
  onSpeechStarted(): void { if (this.isSpeaking()) this.bargeIn(); }
  onToolCall(callId: string, name: string, argsJson: string): void {
    if (name !== "end_call") return;
    let reason = "";
    try { reason = String(JSON.parse(argsJson || "{}").reason || ""); } catch { /* keep "" */ }
    this.inworld.sendToolResult(callId, { ok: true }); // let the model voice a closing line
    this.pendingHangup = true;
    this.hangupArmedAt = Date.now();
    if (this.isSpeaking()) this.farewellStarted = true; // goodbye said in the same turn as the tool call
    this.log("end_call", reason || "requested");
  }
  onClose(): void { this.finish(); }

  // ── Plivo caller audio → Inworld ──────────────────────────────────────────
  private onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "media" && msg.media?.payload) this.inworld.appendAudio(msg.media.payload); // μ-law passthrough
    else if (msg.event === "stop") this.finish();
  }

  /** True while the agent is generating audio or still has audio queued to play. */
  private isSpeaking(): boolean { return this.responseGenerating || this.outBuffer.length > 0; }

  /**
   * Paced sender — one 20 ms frame per tick. Inworld emits faster than real time;
   * pacing keeps un-played audio here in outBuffer, where a barge-in can drop it.
   * Also drives the end_call hangup once the farewell has played.
   */
  private startTxPump(): void {
    this.txTimer = setInterval(() => {
      if (this.outBuffer.length >= PLIVO_CHUNK_SIZE) {
        this.sendChunkToPlivo(this.outBuffer.subarray(0, PLIVO_CHUNK_SIZE));
        this.outBuffer = this.outBuffer.subarray(PLIVO_CHUNK_SIZE);
      } else if (this.outBuffer.length > 0 && !this.responseGenerating) {
        this.sendChunkToPlivo(this.outBuffer);
        this.outBuffer = Buffer.alloc(0);
      }

      if (this.pendingHangup && !this.hungUp) {
        if (Date.now() - this.hangupArmedAt > 12000) this.doHangup();                 // stall backstop
        else if (this.farewellStarted && !this.isSpeaking()) { if (++this.hangupSilenceTicks >= 30) this.doHangup(); }
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
    this.bargeIns += 1;
    this.responseGenerating = false;
    // Caller re-engaged — cancel any armed end_call hangup so we don't drop them.
    if (this.pendingHangup && !this.hungUp) {
      this.pendingHangup = false; this.farewellStarted = false; this.hangupSilenceTicks = 0; this.hangupArmedAt = 0;
    }
    this.outBuffer = Buffer.alloc(0);
    if (this.opts.plivoWs.readyState === WebSocket.OPEN) {
      this.opts.plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: this.opts.streamId }));
    }
    this.inworld.cancelResponse();
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

  /** Single teardown path: clears the pump, closes both sockets, resolves run(). */
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    if (this.txTimer) { clearInterval(this.txTimer); this.txTimer = null; }
    this.log("session", `ended: ${this.turns} turns, ${this.bargeIns} barge-ins`);
    this.inworld.close();
    try { if (this.opts.plivoWs.readyState === WebSocket.OPEN) this.opts.plivoWs.close(); } catch { /* noop */ }
    this.resolveRun?.();
    this.resolveRun = null;
  }
}

/** Public entry point — the server calls this once a Plivo stream has started. */
export async function runAgent(opts: AgentOptions): Promise<void> {
  await new InworldS2SAgent(opts).run();
}
