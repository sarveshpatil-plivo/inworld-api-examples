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
 * `run_agent()` wraps the class for the server to call once a Plivo stream starts.
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";

// ── Config (agent owns API keys, model/voice names, API URLs) ───────────────
const INWORLD_API_KEY = process.env.INWORLD_API_KEY || "";
const INWORLD_MODEL = process.env.INWORLD_MODEL || "openai/gpt-4.1-mini";
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Sarah";
const INWORLD_TTS_MODEL = process.env.INWORLD_TTS_MODEL || "inworld-tts-2";
const INWORLD_STT_MODEL =
  process.env.INWORLD_STT_MODEL || "assemblyai/universal-streaming-multilingual";
const INWORLD_REALTIME_URL = "wss://api.inworld.ai/api/v1/realtime/session";

/** 160 bytes = exactly 20ms of 8 kHz mono μ-law. */
const PLIVO_CHUNK_SIZE = 160;

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
}

/**
 * Manages one voice conversation between Plivo and the Inworld Realtime API.
 *
 * State machine:
 *   idle → connecting → greeting → listening ⇄ speaking
 *                                      ↑__________| (barge-in)
 * `agentSpeaking` gates barge-in: a user-speech event only interrupts/clears
 * playback while the agent is actually talking — this is what prevents the bot
 * from cutting itself off.
 */
class InworldS2SAgent {
  private readonly plivoWs: WebSocket;
  private readonly callId: string;
  private readonly streamId: string;
  private readonly fromNumber: string;
  private readonly systemPrompt: string;

  private inworld: WebSocket | null = null;
  private running = false;
  private agentSpeaking = false;
  private outBuffer = Buffer.alloc(0);

  // metrics
  private turns = 0;
  private bargeIns = 0;

  constructor(opts: AgentOptions) {
    this.plivoWs = opts.plivoWs;
    this.callId = opts.callId;
    this.streamId = opts.streamId;
    this.fromNumber = opts.fromNumber || "";
    this.systemPrompt = opts.systemPrompt || SYSTEM_PROMPT;
  }

  private log(stage: string, msg: string): void {
    console.log(`[${this.callId}] [${stage}] ${msg}`);
  }

  /** Run the session; resolves when the call (either socket) ends. */
  async run(): Promise<void> {
    this.running = true;
    await new Promise<void>((resolve) => {
      const url = `${INWORLD_REALTIME_URL}?key=voice-${this.callId}&protocol=realtime`;
      const inworld = new WebSocket(url, {
        headers: { Authorization: `Basic ${INWORLD_API_KEY}` },
      });
      this.inworld = inworld;

      const finish = () => {
        if (!this.running) return;
        this.running = false;
        this.log("session", `ended: ${this.turns} turns, ${this.bargeIns} barge-ins`);
        try { inworld.close(); } catch { /* noop */ }
        resolve();
      };

      inworld.on("open", () => this.log("session", "Connected to Inworld Realtime API"));
      inworld.on("message", (data: Buffer) => this.onInworldMessage(data));
      inworld.on("error", (err) => {
        console.error(`[${this.callId}] [inworld_rx] socket error: ${(err as Error).message}`);
        finish(); // don't rely on a 'close' always following 'error'
      });
      inworld.on("close", finish);
      inworld.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => { console.error(`[${this.callId}] [session] Inworld HTTP ${res.statusCode}: ${body}`); finish(); });
        res.on("error", () => finish());
      });

      // plivo_rx + stop handling
      this.plivoWs.on("message", (data: Buffer) => this.onPlivoMessage(data));
      this.plivoWs.on("close", () => { this.log("plivo_rx", "Plivo WebSocket closed"); finish(); });
      this.plivoWs.on("error", (err) => {
        console.error(`[${this.callId}] [plivo_rx] socket error: ${(err as Error).message}`);
        finish();
      });
    });
  }

  // ── plivo_rx: caller audio → Inworld ──────────────────────────────────────
  private onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.event) {
      case "media":
        if (msg.media?.payload) {
          // μ-law passthrough — forward straight to Inworld.
          this.sendToInworld({ type: "input_audio_buffer.append", audio: msg.media.payload });
        }
        break;
      case "stop":
        this.log("plivo_rx", "Plivo stop event");
        this.running = false;
        try { this.inworld?.close(); } catch { /* noop */ }
        break;
    }
  }

  // ── inworld_rx: Inworld events → caller audio / barge-in ──────────────────
  private onInworldMessage(data: Buffer): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data.toString()); } catch { return; }

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
        this.agentSpeaking = true;
        this.enqueueAudio(msg.delta as string);
        break;

      case "response.audio.done":
      case "response.output_audio.done":
        this.flushRemainder();
        break;

      case "response.done":
        this.agentSpeaking = false;
        this.turns += 1;
        break;

      case "input_audio_buffer.speech_started":
        // Barge-in: only act while the agent is actually speaking.
        if (this.agentSpeaking) this.triggerBargeIn();
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (msg.transcript) this.log("inworld_rx", `user: ${msg.transcript as string}`);
        break;

      case "error":
        console.error(`[${this.callId}] [inworld_rx] error frame: ${JSON.stringify(msg.error)}`);
        break;
    }
  }

  // ── plivo_tx: queued audio → 160-byte (20ms) playAudio frames ─────────────
  private enqueueAudio(base64Audio: string): void {
    if (!base64Audio) return;
    this.outBuffer = Buffer.concat([this.outBuffer, Buffer.from(base64Audio, "base64")]);
    while (this.outBuffer.length >= PLIVO_CHUNK_SIZE) {
      this.sendChunkToPlivo(this.outBuffer.subarray(0, PLIVO_CHUNK_SIZE));
      this.outBuffer = this.outBuffer.subarray(PLIVO_CHUNK_SIZE);
    }
  }

  private flushRemainder(): void {
    if (this.outBuffer.length > 0) {
      this.sendChunkToPlivo(this.outBuffer);
      this.outBuffer = Buffer.alloc(0);
    }
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
    this.agentSpeaking = false;
    this.outBuffer = Buffer.alloc(0);
    if (this.plivoWs.readyState === WebSocket.OPEN) {
      this.plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: this.streamId }));
    }
    this.sendToInworld({ type: "response.cancel" });
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
        audio: {
          input: {
            format: "g711_ulaw",
            transcription: { model: INWORLD_STT_MODEL },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "auto",
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
    if (this.inworld?.readyState === WebSocket.OPEN) this.inworld.send(JSON.stringify(msg));
  }
}

/** Public entry point — the server calls this once a Plivo stream has started. */
export async function runAgent(opts: AgentOptions): Promise<void> {
  await new InworldS2SAgent(opts).run();
}
