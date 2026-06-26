/**
 * Inbound voice agent — Inworld Realtime (speech-to-speech) engine.
 *
 * One WebSocket to the Inworld Realtime API handles STT + LLM + TTS. Audio is
 * G.711 μ-law @ 8 kHz on both the Plivo and Inworld legs, so it passes through
 * with no transcoding.
 *
 * The agent owns pipeline orchestration and the call state machine. It runs
 * three logical streams concurrently:
 *   plivo_rx  — caller audio in  → forwarded to Inworld
 *   inworld_rx — Inworld events  → audio queued for the caller, barge-in, etc.
 *   plivo_tx  — queued audio out → chunked to 160-byte (20ms) playAudio frames
 *
 * `runAgent()` wraps the class for the server to call once a Plivo stream starts.
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";

// ── Config (agent owns API keys, model/voice names, API URLs) ───────────────
const INWORLD_API_KEY = process.env.INWORLD_API_KEY || "";
const INWORLD_MODEL = "openai/gpt-4.1-mini";
const INWORLD_VOICE = "Sarah";
const INWORLD_TTS_MODEL = "inworld-tts-2";
const INWORLD_STT_MODEL = "inworld/inworld-stt-1";
// Overridable so the agent can be pointed at a proxy/staging endpoint (and at a
// local fake in the behavioral test). Defaults to the production Realtime API.
const INWORLD_REALTIME_URL =
  process.env.INWORLD_REALTIME_URL || "wss://api.inworld.ai/api/v1/realtime/session";
/** semantic_vad eagerness (low | medium | high | auto): higher = quicker to detect
 *  the caller speaking → snappier barge-in. */
const INWORLD_VAD_EAGERNESS = "high";

/** 160 bytes = exactly 20ms of 8 kHz mono μ-law. */
const PLIVO_CHUNK_SIZE = 160;

/**
 * Sample tool the model can call to hang up the call. Registered in
 * `session.update`; invoked via a `response.function_call_arguments.done` event.
 * See https://docs.inworld.ai/realtime/usage/using-realtime-models
 */
const END_CALL_TOOL = {
  type: "function",
  name: "end_call",
  description:
    "End the phone call. Call this only after saying a brief goodbye, when the " +
    "caller indicates they are done or their request is fully resolved.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Short reason for ending, e.g. 'caller said goodbye'." },
    },
    required: ["reason"],
  },
};

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  readFileSync(new URL("./system_prompt.md", import.meta.url), "utf-8").trim();

interface AgentOptions {
  plivoWs: WebSocket;
  callId: string;
  streamId: string;
  fromNumber?: string;
  toNumber?: string;
  systemPrompt?: string;
  /** Hang up the live call (telephony lives in server.ts; the agent just asks). */
  hangup?: () => Promise<void> | void;
}

/**
 * Manages one voice conversation between Plivo and the Inworld Realtime API.
 *
 * State machine:
 *   idle → connecting → greeting → listening ⇄ speaking
 *                                      ↑__________| (barge-in)
 * `isSpeaking()` gates barge-in: a user-speech event only interrupts/clears
 * playback while the agent is actually talking (generating or still draining
 * queued audio) — this is what prevents the bot from cutting itself off.
 */
class InworldS2SAgent {
  private readonly plivoWs: WebSocket;
  private readonly callId: string;
  private readonly streamId: string;
  private readonly fromNumber: string;
  private readonly systemPrompt: string;
  private readonly hangup?: () => Promise<void> | void;

  private inworld: WebSocket | null = null;
  private running = false;
  private responseGenerating = false;
  private outBuffer = Buffer.alloc(0);
  private txTimer: ReturnType<typeof setInterval> | null = null;
  private resolveRun: (() => void) | null = null;

  // end_call: hang up once the farewell has finished playing
  private pendingHangup = false;
  private farewellStarted = false;
  private hangupSilenceTicks = 0;
  private hangupArmedAt = 0;
  private hungUp = false;

  // metrics
  private turns = 0;
  private bargeIns = 0;

  constructor(opts: AgentOptions) {
    this.plivoWs = opts.plivoWs;
    this.callId = opts.callId;
    this.streamId = opts.streamId;
    this.fromNumber = opts.fromNumber || "";
    this.systemPrompt = opts.systemPrompt || SYSTEM_PROMPT;
    this.hangup = opts.hangup;
  }

  private log(stage: string, msg: string): void {
    console.log(`[${this.callId}] [${stage}] ${msg}`);
  }

  /** Run the session; resolves when the call (either socket) ends. */
  async run(): Promise<void> {
    this.running = true;
    await new Promise<void>((resolve) => {
      this.resolveRun = resolve;
      // `key` here is a per-session correlation id, NOT the API key — the key
      // is sent in the Authorization header below.
      const url = `${INWORLD_REALTIME_URL}?key=voice-${this.callId}&protocol=realtime`;
      const inworld = new WebSocket(url, {
        headers: { Authorization: `Basic ${INWORLD_API_KEY}` },
      });
      this.inworld = inworld;
      this.startTxPump();

      inworld.on("open", () => this.log("session", "Connected to Inworld Realtime API"));
      inworld.on("message", (data: Buffer) => this.onInworldMessage(data));
      inworld.on("error", (err) => {
        console.error(`[${this.callId}] [inworld_rx] socket error: ${(err as Error).message}`);
        this.finish(); // don't rely on a 'close' always following 'error'
      });
      inworld.on("close", () => this.finish());
      inworld.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => { console.error(`[${this.callId}] [session] Inworld HTTP ${res.statusCode}: ${body}`); this.finish(); });
        res.on("error", () => this.finish());
      });

      this.plivoWs.on("message", (data: Buffer) => this.onPlivoMessage(data));
      this.plivoWs.on("close", () => { this.log("plivo_rx", "Plivo WebSocket closed"); this.finish(); });
      this.plivoWs.on("error", (err) => {
        console.error(`[${this.callId}] [plivo_rx] socket error: ${(err as Error).message}`);
        this.finish();
      });
    });
  }

  /**
   * Single teardown path: clears the tx pump, closes BOTH sockets, resolves
   * run(). Idempotent (guarded on `running`). Every termination — Plivo stop,
   * socket error/close, Inworld error frame — must route through here, or the
   * 20ms pump timer leaks and the other leg is left open on a silent line.
   */
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    if (this.txTimer) { clearInterval(this.txTimer); this.txTimer = null; }
    this.log("session", `ended: ${this.turns} turns, ${this.bargeIns} barge-ins`);
    try { this.inworld?.close(); } catch { /* noop */ }
    try { if (this.plivoWs.readyState === WebSocket.OPEN) this.plivoWs.close(); } catch { /* noop */ }
    this.resolveRun?.();
    this.resolveRun = null;
  }

  // ── plivo_rx: caller audio → Inworld ──────────────────────────────────────
  private onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); }
    catch { this.log("plivo_rx", `dropped unparseable frame: ${data.toString().slice(0, 120)}`); return; }

    switch (msg.event) {
      case "media":
        if (msg.media?.payload) {
          // μ-law passthrough — forward straight to Inworld.
          this.sendToInworld({ type: "input_audio_buffer.append", audio: msg.media.payload });
        }
        break;
      case "stop":
        this.log("plivo_rx", "Plivo stop event");
        this.finish(); // single teardown path — clears the pump, closes both legs
        break;
    }
  }

  // ── inworld_rx: Inworld events → caller audio / barge-in ──────────────────
  private onInworldMessage(data: Buffer): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); }
    catch { console.error(`[${this.callId}] [inworld_rx] dropped unparseable frame: ${data.toString().slice(0, 120)}`); return; }

    switch (msg.type) {
      case "session.created":
        this.log("inworld_rx", "session.created → configuring");
        this.sendSessionConfig();
        break;

      case "session.updated":
        this.log("inworld_rx", "session.updated → greeting");
        // Seed a first turn so the agent greets the caller.
        this.sendToInworld({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: "The call just connected. Greet the caller." }] },
        });
        this.sendToInworld({ type: "response.create" });
        break;

      // Inworld has shipped both the long and short event names across
      // versions (its own example handles both) — accept either.
      case "response.audio.delta":
      case "response.output_audio.delta":
        this.responseGenerating = true;
        if (this.pendingHangup) this.farewellStarted = true; // the goodbye is now playing
        this.enqueueAudio(msg.delta as string);
        break;

      case "response.audio.done":
      case "response.output_audio.done":
        // tail is drained by the paced tx pump; nothing to flush here
        break;

      case "response.done":
        // generation finished, but playback (outBuffer) may still be draining
        this.responseGenerating = false;
        this.turns += 1;
        break;

      case "response.function_call_arguments.done":
        // The model invoked a tool. arguments arrives as a JSON string.
        this.onFunctionCall(
          msg.call_id as string,
          msg.name as string,
          msg.arguments as string,
        );
        break;

      case "input_audio_buffer.speech_started":
        // Barge-in while audio is still generating OR queued for playback.
        if (this.isSpeaking()) this.triggerBargeIn();
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) this.log("inworld_rx", `user: ${msg.transcript as string}`);
        break;

      case "error":
        // A session-level error frame leaves the agent unable to make progress
        // (e.g. a rejected session.update means session.updated never arrives).
        // Tear down rather than leave the caller on a silent open line.
        console.error(`[${this.callId}] [inworld_rx] error frame — ending call: ${JSON.stringify(msg.error)}`);
        this.finish();
        break;
    }
  }

  // ── plivo_tx: paced 160-byte (20ms) playAudio frames ──────────────────────

  /** True while the agent is generating audio or still has audio queued to play. */
  private isSpeaking(): boolean {
    return this.responseGenerating || this.outBuffer.length > 0;
  }

  /** Append synthesized audio; the paced tx pump drains it to Plivo. */
  private enqueueAudio(base64Audio: string): void {
    if (!base64Audio) return;
    this.outBuffer = Buffer.concat([this.outBuffer, Buffer.from(base64Audio, "base64")]);
  }

  /**
   * Paced sender — one 20ms frame per tick. Inworld emits audio faster than real
   * time, so without pacing the whole response lands in Plivo's buffer and a
   * barge-in can't stop it. Pacing keeps the un-played audio here in outBuffer,
   * where barge-in drops it instantly.
   */
  private startTxPump(): void {
    this.txTimer = setInterval(() => {
      if (this.outBuffer.length >= PLIVO_CHUNK_SIZE) {
        this.sendChunkToPlivo(this.outBuffer.subarray(0, PLIVO_CHUNK_SIZE));
        this.outBuffer = this.outBuffer.subarray(PLIVO_CHUNK_SIZE);
      } else if (this.outBuffer.length > 0 && !this.responseGenerating) {
        this.sendChunkToPlivo(this.outBuffer); // flush final sub-frame
        this.outBuffer = Buffer.alloc(0);
      }

      // end_call: hang up once the farewell has actually started and then
      // drained (~600ms of silence) — the farewellStarted guard avoids cutting
      // off (or hanging up before) a goodbye that hasn't begun yet. The absolute
      // backstop guarantees we never leave the call open if that response stalls
      // or never completes.
      if (this.pendingHangup && !this.hungUp) {
        if (Date.now() - this.hangupArmedAt > 5000) {
          this.doHangup(); // backstop
        } else if (this.farewellStarted && !this.isSpeaking()) {
          if (++this.hangupSilenceTicks >= 30) this.doHangup();
        } else {
          this.hangupSilenceTicks = 0;
        }
      }
    }, 20);
  }

  private sendChunkToPlivo(chunk: Buffer): void {
    if (this.plivoWs.readyState !== WebSocket.OPEN || !this.streamId) return;
    this.plivoWs.send(JSON.stringify({
      event: "playAudio",
      media: {
        contentType: "audio/x-mulaw",
        sampleRate: 8000,
        payload: chunk.toString("base64"),
      },
    }));
  }

  private triggerBargeIn(): void {
    this.log("barge-in", "user interrupted — clearing playback");
    this.bargeIns += 1;
    this.responseGenerating = false;
    this.outBuffer = Buffer.alloc(0);
    if (this.plivoWs.readyState === WebSocket.OPEN) {
      this.plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: this.streamId }));
    }
    this.sendToInworld({ type: "response.cancel" });
  }

  /**
   * Handle a model tool call. Returns the result to Inworld (so the protocol is
   * complete and the model can voice a closing line), then arms the hangup —
   * `doHangup` fires once the farewell audio has drained (see the tx pump).
   */
  private onFunctionCall(callId: string, name: string, argsJson: string): void {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson || "{}"); } catch { /* keep {} */ }
    this.log("tool", `${name}(${argsJson})`);

    if (name === "end_call") {
      // Return the result item, then let the model speak a closing line.
      // (Inworld docs use `function_call_output` + `output`; the API-reference
      //  page shows `function_call_result` + `content` — output is the
      //  OpenAI-realtime-compatible shape, which Inworld follows.)
      this.sendToInworld({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true }) },
      });
      this.sendToInworld({ type: "response.create" });
      this.pendingHangup = true;
      this.hangupArmedAt = Date.now();
      this.log("end_call", `requested (${(args.reason as string) || "no reason"})`);
    }
  }

  /**
   * Hang up the live call once (idempotent). Telephony lives in server.ts, so we
   * call the injected hangup. If it's missing or fails, fall back to closing the
   * Plivo socket (→ finish()) so the caller is never left on a silent open line.
   */
  private doHangup(): void {
    if (this.hungUp) return;
    this.hungUp = true;
    if (!this.hangup) {
      console.warn(`[${this.callId}] [end_call] no hangup handler — closing the media stream to drop the call`);
      try { this.plivoWs.close(); } catch { /* noop */ }
      return;
    }
    this.log("end_call", "farewell played — hanging up");
    Promise.resolve(this.hangup()).catch((err) => {
      console.error(`[${this.callId}] [end_call] hangup failed, closing media stream: ${(err as Error).message}`);
      try { this.plivoWs.close(); } catch { /* noop */ }
    });
  }

  private sendSessionConfig(): void {
    let instructions = this.systemPrompt;
    if (this.fromNumber) instructions += `\n\n## Call Context\n- Caller: ${this.fromNumber}\n- Call ID: ${this.callId}`;
    this.sendToInworld({
      type: "session.update",
      session: {
        type: "realtime",
        model: INWORLD_MODEL,
        instructions,
        output_modalities: ["audio", "text"],
        tools: [END_CALL_TOOL],
        tool_choice: "auto",
        audio: {
          input: {
            format: "g711_ulaw",
            transcription: { model: INWORLD_STT_MODEL },
            turn_detection: {
              type: "semantic_vad",
              eagerness: INWORLD_VAD_EAGERNESS,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { format: "g711_ulaw", model: INWORLD_TTS_MODEL, voice: INWORLD_VOICE },
        },
      },
    });
  }

  private sendToInworld(msg: object): void {
    if (this.inworld?.readyState === WebSocket.OPEN) { this.inworld.send(JSON.stringify(msg)); return; }
    const type = (msg as { type?: string }).type;
    // Don't spam on per-frame caller audio during a close race; surface control msgs.
    if (type !== "input_audio_buffer.append") {
      this.log("inworld_tx", `dropped ${type ?? "msg"} — Inworld socket not open`);
    }
  }
}

/** Public entry point — the server calls this once a Plivo stream has started. */
export async function runAgent(opts: AgentOptions): Promise<void> {
  await new InworldS2SAgent(opts).run();
}
