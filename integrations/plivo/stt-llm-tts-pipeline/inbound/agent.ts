/**
 * Inbound voice agent — Inworld cascaded STT → LLM(Router) → TTS pipeline.
 *
 * Three Inworld services wired in sequence (each independently swappable):
 *   STT  — wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional (LINEAR16)
 *   LLM  — POST https://api.inworld.ai/v1/chat/completions (OpenAI-compatible SSE)
 *   TTS  — POST https://api.inworld.ai/tts/v1/voice (JSON audioContent → μ-law for Plivo)
 *
 * Audio: Plivo μ-law 8k → PCM16 for STT; TTS PCM → μ-law 8k for Plivo (utils.ts).
 * STT is sent LINEAR16 @ 8kHz; TTS is requested as PCM @ TTS_SAMPLE_RATE (default
 * 8kHz) and resampled to 8kHz before μ-law — adjust the env if your Inworld
 * account expects a different STT rate or TTS output encoding.
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { ulawToPcm, pcmToUlaw, resamplePcm16 } from "../utils.js";

// ── Config (agent owns API keys, models, voices, URLs) ──────────────────────
const INWORLD_API_KEY = process.env.INWORLD_API_KEY || "";
const INWORLD_LLM_MODEL = "openai/gpt-4.1-mini";
const INWORLD_STT_MODEL = "inworld/inworld-stt-1";
const INWORLD_TTS_MODEL = "inworld-tts-2";
const INWORLD_VOICE = "Sarah";

const STT_URL = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
const LLM_URL = "https://api.inworld.ai/v1/chat/completions";
const TTS_URL = "https://api.inworld.ai/tts/v1/voice";
const AUTH = `Basic ${INWORLD_API_KEY}`;

const PLIVO_SAMPLE_RATE = 8000;
const PLIVO_CHUNK_SIZE = 160; // 20ms @ 8kHz μ-law
/** TTS output sample rate we request as PCM; resampled to 8k before μ-law. */
const TTS_SAMPLE_RATE = 8000;
/** Silence after a final transcript before we treat the turn as complete. */
const END_OF_UTTERANCE_MS = 800;

/**
 * Sample tool the model can call to hang up. Router /chat/completions uses the
 * OpenAI tool format (name/description/parameters nested under `function`).
 */
const END_CALL_TOOL = {
  type: "function",
  function: {
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
  },
};

/** A streamed LLM chunk: either spoken text or a tool invocation. */
type LlmChunk =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: string };

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  readFileSync(new URL("./system_prompt.md", import.meta.url), "utf-8").trim();

interface Message { role: "system" | "user" | "assistant"; content: string; }
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

class InworldCascadedAgent {
  private readonly plivoWs: WebSocket;
  private readonly callId: string;
  private readonly streamId: string;
  private readonly hangup?: () => Promise<void> | void;

  private stt: WebSocket | null = null;
  private running = false;
  private processing = false;
  private outBuffer = Buffer.alloc(0);
  private txTimer: ReturnType<typeof setInterval> | null = null;
  private history: Message[];
  private activeAbort: AbortController | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private pendingTranscript = "";
  private pendingTurn: string | null = null;
  private resolveDone: (() => void) | null = null;

  // end_call: hang up once the farewell has finished playing
  private pendingHangup = false;
  private hangupSilenceTicks = 0;
  private hungUp = false;

  constructor(opts: AgentOptions) {
    this.plivoWs = opts.plivoWs;
    this.callId = opts.callId;
    this.streamId = opts.streamId;
    this.hangup = opts.hangup;
    let prompt = opts.systemPrompt || SYSTEM_PROMPT;
    if (opts.fromNumber) prompt += `\n\n## Call Context\n- Caller: ${opts.fromNumber}\n- Call ID: ${opts.callId}`;
    this.history = [{ role: "system", content: prompt }];
  }

  private log(stage: string, msg: string): void {
    console.log(`[${this.callId}] [${stage}] ${msg}`);
  }

  async run(): Promise<void> {
    this.running = true;
    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;

      const stt = new WebSocket(STT_URL, { headers: { Authorization: AUTH } });
      this.stt = stt;
      this.startTxPump();

      stt.on("open", () => {
        this.log("stt", "connected → configuring");
        this.sttSend({
          transcribeConfig: {
            modelId: INWORLD_STT_MODEL,
            audioEncoding: "LINEAR16",
            sampleRateHertz: PLIVO_SAMPLE_RATE,
            numberOfChannels: 1,
            language: "en-US",
          },
        });
        // Greet the caller once STT is ready.
        void this.speak("Hello! How can I help you today?");
      });
      stt.on("message", (data: Buffer) => this.onSttMessage(data));
      stt.on("error", (err) => {
        console.error(`[${this.callId}] [stt] socket error: ${(err as Error).message}`);
        this.finish(); // STT is the only input path — a dead socket means a dead call
      });
      stt.on("close", () => this.finish());
      stt.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => { console.error(`[${this.callId}] [stt] Inworld HTTP ${res.statusCode}: ${body}`); this.finish(); });
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

  private finish(): void {
    if (!this.running) return;
    this.running = false;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.txTimer) { clearInterval(this.txTimer); this.txTimer = null; }
    this.activeAbort?.abort();
    try { this.stt?.close(); } catch { /* noop */ }
    this.log("session", "ended");
    this.resolveDone?.();
  }

  // ── plivo_rx: caller μ-law → PCM16 → STT ──────────────────────────────────
  private onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "media" && msg.media?.payload) {
      const pcm = ulawToPcm(Buffer.from(msg.media.payload, "base64"));
      this.sttSend({ audioChunk: { content: pcm.toString("base64") } });
    } else if (msg.event === "stop") {
      this.log("plivo_rx", "Plivo stop event");
      this.finish();
    }
  }

  // ── stt_rx: transcripts → barge-in / turn handling ────────────────────────
  private onSttMessage(data: Buffer): void {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.error) { console.error(`[${this.callId}] [stt] error frame: ${JSON.stringify(msg.error)}`); return; }
    const t = msg?.result?.transcription;
    const text: string = t?.transcript || "";
    if (!text) return;

    // Any caller speech while audio is still queued for playback → barge-in.
    if (this.isSpeaking()) this.bargeIn();

    if (t.isFinal) {
      this.pendingTranscript = (this.pendingTranscript + " " + text).trim();
      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        const utterance = this.pendingTranscript;
        this.pendingTranscript = "";
        if (utterance) void this.handleTurn(utterance);
      }, END_OF_UTTERANCE_MS);
    }
  }

  // ── turn: LLM stream → per-sentence TTS → Plivo ───────────────────────────
  private async handleTurn(transcript: string): Promise<void> {
    // A turn already running: don't drop the new utterance — queue it (latest
    // wins) and run it when the current turn finishes.
    if (this.processing) { this.pendingTurn = transcript; return; }
    this.processing = true;
    // NOTE: barge-in is gated on isSpeaking() (outBuffer non-empty), which only
    // becomes true once TTS audio is actually queued — so trailing STT transcripts
    // of the user's just-finished utterance (arriving before any audio) don't
    // self-cancel the reply. The 800ms silence debounce also helps.
    this.log("turn", `user: ${transcript}`);
    this.history.push({ role: "user", content: transcript });

    const abort = new AbortController();
    this.activeAbort = abort;
    let full = "";
    let sentence = "";
    const toolCalls: { id: string; name: string; args: string }[] = [];
    try {
      for await (const chunk of this.streamLLM(this.history, abort.signal)) {
        if (chunk.type === "tool_call") { toolCalls.push(chunk); continue; }
        full += chunk.text;
        sentence += chunk.text;
        const m = sentence.match(/^(.+?[.!?])\s+/);
        if (m) {
          sentence = sentence.slice(m[0].length);
          await this.speak(m[1], abort.signal);
        }
      }
      if (sentence.trim()) await this.speak(sentence.trim(), abort.signal);
      this.history.push({ role: "assistant", content: full });
      for (const tc of toolCalls) this.handleToolCall(tc.name, tc.args);
    } catch (err) {
      if ((err as Error).name === "AbortError") this.log("turn", "cancelled (barge-in)");
      else this.log("turn", `error: ${(err as Error).message}`);
    } finally {
      this.processing = false;
      this.activeAbort = null;
      if (this.pendingTurn) {
        const next = this.pendingTurn;
        this.pendingTurn = null;
        void this.handleTurn(next);
      }
    }
  }

  private async *streamLLM(messages: Message[], signal: AbortSignal): AsyncGenerator<LlmChunk> {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: INWORLD_LLM_MODEL, messages, stream: true,
        tools: [END_CALL_TOOL], tool_choice: "auto",
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Router ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Router: no response body");
    const decoder = new TextDecoder();
    let buf = "";
    // Tool calls stream as fragments (id+name in the first delta, arguments in
    // pieces); accumulate by index and emit once the stream ends.
    const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
    const flushTools = function* (): Generator<LlmChunk> {
      for (const tc of Object.values(toolAcc)) {
        if (tc.name) yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") { yield* flushTools(); return; }
        try {
          const delta = JSON.parse(data)?.choices?.[0]?.delta;
          if (delta?.content) yield { type: "text", text: delta.content as string };
          for (const tc of delta?.tool_calls ?? []) {
            const i: number = tc.index ?? 0;
            const acc = (toolAcc[i] ||= { id: "", name: "", args: "" });
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        } catch { /* ignore keepalive/partial */ }
      }
    }
    yield* flushTools();
  }

  /** Synthesize text via TTS and stream the audio to Plivo. */
  private async speak(text: string, signal?: AbortSignal): Promise<void> {
    this.log("tts", `speaking: ${text.slice(0, 60)}`);
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: INWORLD_VOICE,
        model_id: INWORLD_TTS_MODEL,
        audio_config: { audio_encoding: "LINEAR16", sample_rate_hertz: TTS_SAMPLE_RATE },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Inworld TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    // Inworld TTS returns JSON: { audioContent: <base64 LINEAR16> } (sometimes with a WAV header).
    const result = (await res.json()) as { audioContent?: string };
    if (!result.audioContent) throw new Error("Inworld TTS: no audioContent in response");
    let pcm: Uint8Array = Buffer.from(result.audioContent, "base64");
    if (pcm.length > 44 && Buffer.from(pcm.subarray(0, 4)).toString("ascii") === "RIFF") {
      pcm = pcm.subarray(44); // strip WAV header → raw PCM16
    }
    const out =
      TTS_SAMPLE_RATE !== PLIVO_SAMPLE_RATE
        ? resamplePcm16(pcm, TTS_SAMPLE_RATE, PLIVO_SAMPLE_RATE)
        : pcm;
    this.enqueueAudio(pcmToUlaw(out));
  }

  // ── plivo_tx: paced 160-byte (20ms) playAudio frames ──────────────────────

  /** True while there's still synthesized audio queued to play. */
  private isSpeaking(): boolean {
    return this.outBuffer.length > 0;
  }

  /** Append synthesized audio; the paced tx pump drains it to Plivo. */
  private enqueueAudio(ulaw: Buffer): void {
    this.outBuffer = Buffer.concat([this.outBuffer, ulaw]);
  }

  /**
   * Paced sender — one 20ms frame per tick. TTS returns whole sentences far
   * faster than real time; without pacing the whole reply lands in Plivo's
   * buffer and a barge-in can't stop it. Pacing keeps un-played audio in
   * outBuffer, where barge-in drops it instantly.
   */
  private startTxPump(): void {
    this.txTimer = setInterval(() => {
      if (this.outBuffer.length >= PLIVO_CHUNK_SIZE) {
        this.sendChunkToPlivo(this.outBuffer.subarray(0, PLIVO_CHUNK_SIZE));
        this.outBuffer = this.outBuffer.subarray(PLIVO_CHUNK_SIZE);
      } else if (this.outBuffer.length > 0 && !this.processing) {
        this.sendChunkToPlivo(this.outBuffer); // flush final sub-frame after the turn
        this.outBuffer = Buffer.alloc(0);
      }

      // end_call: hang up after the farewell finishes (~600ms idle). The grace
      // window rides over gaps between sentences so we don't cut the goodbye off.
      if (this.pendingHangup && !this.hungUp) {
        if (!this.processing && this.outBuffer.length === 0) {
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
      media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: chunk.toString("base64") },
    }));
  }

  private bargeIn(): void {
    this.log("barge-in", "user interrupted — clearing playback");
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.outBuffer = Buffer.alloc(0);
    this.activeAbort?.abort();
    if (this.plivoWs.readyState === WebSocket.OPEN) {
      this.plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: this.streamId }));
    }
  }

  /**
   * Handle a model tool call. The spoken reply (e.g. the goodbye) already
   * streamed as content this turn, so for the terminal `end_call` we just arm
   * the hangup — `doHangup` fires once the audio has drained (see the tx pump).
   */
  private handleToolCall(name: string, argsJson: string): void {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson || "{}"); } catch { /* keep {} */ }
    this.log("tool", `${name}(${argsJson})`);
    if (name === "end_call") {
      this.pendingHangup = true;
      this.log("end_call", `requested (${(args.reason as string) || "no reason"})`);
    }
  }

  /** Hang up the live call once (idempotent). Telephony lives in server.ts. */
  private doHangup(): void {
    if (this.hungUp) return;
    this.hungUp = true;
    if (!this.hangup) { this.log("end_call", "no hangup handler — leaving call open"); return; }
    this.log("end_call", "farewell played — hanging up");
    Promise.resolve(this.hangup()).catch((err) =>
      console.error(`[${this.callId}] [end_call] hangup failed: ${(err as Error).message}`));
  }

  private sttSend(msg: object): void {
    if (this.stt?.readyState === WebSocket.OPEN) this.stt.send(JSON.stringify(msg));
  }
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  await new InworldCascadedAgent(opts).run();
}
