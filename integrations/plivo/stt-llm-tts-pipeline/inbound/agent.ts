/**
 * Inbound voice agent — Inworld cascaded STT → LLM(Router) → TTS pipeline.
 *
 * Three Inworld services wired in sequence (each independently swappable):
 *   STT  — wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional (LINEAR16)
 *   LLM  — POST https://api.inworld.ai/v1/chat/completions (OpenAI-compatible SSE)
 *   TTS  — POST https://api.inworld.ai/tts/v1/voice:stream (PCM → μ-law for Plivo)
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
const INWORLD_LLM_MODEL = process.env.INWORLD_MODEL || "openai/gpt-4.1-mini";
const INWORLD_STT_MODEL = process.env.INWORLD_STT_MODEL || "inworld/inworld-stt-1";
const INWORLD_TTS_MODEL = process.env.INWORLD_TTS_MODEL || "inworld-tts-2";
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Sarah";

const STT_URL = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
const LLM_URL = "https://api.inworld.ai/v1/chat/completions";
const TTS_URL = "https://api.inworld.ai/tts/v1/voice:stream";
const AUTH = `Basic ${INWORLD_API_KEY}`;

const PLIVO_SAMPLE_RATE = 8000;
const PLIVO_CHUNK_SIZE = 160; // 20ms @ 8kHz μ-law
/** TTS output sample rate we request as PCM; resampled to 8k before μ-law. */
const TTS_SAMPLE_RATE = parseInt(process.env.TTS_SAMPLE_RATE || "8000", 10);
/** Silence after a final transcript before we treat the turn as complete. */
const END_OF_UTTERANCE_MS = 800;

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
}

class InworldCascadedAgent {
  private readonly plivoWs: WebSocket;
  private readonly callId: string;
  private readonly streamId: string;

  private stt: WebSocket | null = null;
  private running = false;
  private agentSpeaking = false;
  private processing = false;
  private outBuffer = Buffer.alloc(0);
  private history: Message[];
  private activeAbort: AbortController | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private pendingTranscript = "";
  private pendingTurn: string | null = null;
  private resolveDone: (() => void) | null = null;

  constructor(opts: AgentOptions) {
    this.plivoWs = opts.plivoWs;
    this.callId = opts.callId;
    this.streamId = opts.streamId;
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

    // Any caller speech while the agent is talking → barge-in.
    if (this.agentSpeaking) this.bargeIn();

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
    // NOTE: agentSpeaking is NOT set here. It flips true only once audio is
    // actually sent to Plivo (sendChunkToPlivo). Setting it at turn start would
    // make trailing STT transcripts of the user's just-finished utterance look
    // like a barge-in and abort the reply before it begins. The 800ms silence
    // debounce + "audio started" gating keeps barge-in tied to real interruptions.
    this.log("turn", `user: ${transcript}`);
    this.history.push({ role: "user", content: transcript });

    const abort = new AbortController();
    this.activeAbort = abort;
    let full = "";
    let sentence = "";
    try {
      for await (const token of this.streamLLM(this.history, abort.signal)) {
        full += token;
        sentence += token;
        const m = sentence.match(/^(.+?[.!?])\s+/);
        if (m) {
          sentence = sentence.slice(m[0].length);
          await this.speak(m[1], abort.signal);
        }
      }
      if (sentence.trim()) await this.speak(sentence.trim(), abort.signal);
      this.history.push({ role: "assistant", content: full });
    } catch (err) {
      if ((err as Error).name === "AbortError") this.log("turn", "cancelled (barge-in)");
      else this.log("turn", `error: ${(err as Error).message}`);
    } finally {
      this.processing = false;
      this.activeAbort = null;
      this.agentSpeaking = false;
      if (this.pendingTurn) {
        const next = this.pendingTurn;
        this.pendingTurn = null;
        void this.handleTurn(next);
      }
    }
  }

  private async *streamLLM(messages: Message[], signal: AbortSignal): AsyncGenerator<string> {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ model: INWORLD_LLM_MODEL, messages, stream: true }),
      signal,
    });
    if (!res.ok) throw new Error(`Router ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Router: no response body");
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const content = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (content) yield content as string;
        } catch { /* ignore keepalive/partial */ }
      }
    }
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
        audio_config: { audio_encoding: "PCM", sample_rate_hertz: TTS_SAMPLE_RATE },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const raw = new Uint8Array(await res.arrayBuffer());
    if (raw.length % 2 !== 0) console.warn(`[${this.callId}] [tts] odd byte count (${raw.length}) — output may not be PCM16 as assumed`);
    const pcm =
      TTS_SAMPLE_RATE !== PLIVO_SAMPLE_RATE
        ? resamplePcm16(raw, TTS_SAMPLE_RATE, PLIVO_SAMPLE_RATE)
        : raw;
    this.enqueueAudio(pcmToUlaw(pcm));
    this.flushRemainder();
  }

  // ── plivo_tx: μ-law → 160-byte (20ms) playAudio frames ────────────────────
  private enqueueAudio(ulaw: Buffer): void {
    this.outBuffer = Buffer.concat([this.outBuffer, ulaw]);
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
    // Audio is actively going to the caller → now barge-in should react to new speech.
    this.agentSpeaking = true;
    this.plivoWs.send(JSON.stringify({
      event: "playAudio",
      media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: chunk.toString("base64") },
    }));
  }

  private bargeIn(): void {
    this.log("barge-in", "user interrupted — clearing playback");
    this.agentSpeaking = false;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.outBuffer = Buffer.alloc(0);
    this.activeAbort?.abort();
    if (this.plivoWs.readyState === WebSocket.OPEN) {
      this.plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: this.streamId }));
    }
  }

  private sttSend(msg: object): void {
    if (this.stt?.readyState === WebSocket.OPEN) this.stt.send(JSON.stringify(msg));
  }
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  await new InworldCascadedAgent(opts).run();
}
