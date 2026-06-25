/**
 * Inbound voice agent — Inworld TTS spotlight.
 *
 * Full speech-to-speech pipeline over Plivo, where TTS is Inworld's and the
 * other two stages use different providers:
 *   STT  — Deepgram  (wss://api.deepgram.com/v1/listen, LINEAR16 8k)
 *   LLM  — Google Gemini  (v1beta streamGenerateContent, SSE)
 *   TTS  — Inworld TTS  (POST https://api.inworld.ai/tts/v1/voice:stream, PCM)
 *
 * Audio: Plivo μ-law 8k → PCM16 for Deepgram; Inworld TTS returns PCM, which is
 * resampled to 8k and encoded to μ-law for Plivo.
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { ulawToPcm, pcmToUlaw, resamplePcm16 } from "../utils.js";

// ── Config ──────────────────────────────────────────────────────────────────
const INWORLD_API_KEY = process.env.INWORLD_API_KEY || "";
const INWORLD_TTS_MODEL = process.env.INWORLD_TTS_MODEL || "inworld-tts-2";
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Sarah";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-2-phonecall";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const DEEPGRAM_URL =
  `wss://api.deepgram.com/v1/listen?model=${DEEPGRAM_MODEL}` +
  `&encoding=linear16&sample_rate=8000&channels=1&punctuate=true&interim_results=false`;
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;
const TTS_URL = "https://api.inworld.ai/tts/v1/voice:stream";

const PLIVO_SAMPLE_RATE = 8000;
const PLIVO_CHUNK_SIZE = 160; // 20ms @ 8kHz μ-law
/** PCM sample rate requested from Inworld TTS; resampled to 8k before μ-law. */
const TTS_SAMPLE_RATE = parseInt(process.env.TTS_SAMPLE_RATE || "8000", 10);

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  readFileSync(new URL("./system_prompt.md", import.meta.url), "utf-8").trim();

interface GeminiContent { role: "user" | "model"; parts: { text: string }[]; }
interface AgentOptions {
  plivoWs: WebSocket;
  callId: string;
  streamId: string;
  fromNumber?: string;
  toNumber?: string;
  systemPrompt?: string;
}

class InworldTtsAgent {
  private readonly plivoWs: WebSocket;
  private readonly callId: string;
  private readonly streamId: string;

  private stt: WebSocket | null = null;
  private running = false;
  private agentSpeaking = false;
  private processing = false;
  private outBuffer = Buffer.alloc(0);
  private readonly systemText: string;
  private history: GeminiContent[] = [];
  private activeAbort: AbortController | null = null;
  private pendingTurn: string | null = null;
  private resolveDone: (() => void) | null = null;

  constructor(opts: AgentOptions) {
    this.plivoWs = opts.plivoWs;
    this.callId = opts.callId;
    this.streamId = opts.streamId;
    let prompt = opts.systemPrompt || SYSTEM_PROMPT;
    if (opts.fromNumber) prompt += `\n\n## Call Context\n- Caller: ${opts.fromNumber}\n- Call ID: ${opts.callId}`;
    this.systemText = prompt;
  }

  private log(stage: string, msg: string): void {
    console.log(`[${this.callId}] [${stage}] ${msg}`);
  }

  async run(): Promise<void> {
    this.running = true;
    await new Promise<void>((resolve) => {
      this.resolveDone = resolve;

      const stt = new WebSocket(DEEPGRAM_URL, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
      this.stt = stt;

      stt.on("open", () => {
        this.log("stt", "connected to Deepgram");
        void this.speak("Hello! How can I help you today?");
      });
      stt.on("message", (data: Buffer) => this.onDeepgramMessage(data));
      stt.on("error", (err) => {
        console.error(`[${this.callId}] [stt] socket error: ${(err as Error).message}`);
        this.finish();
      });
      stt.on("close", () => this.finish());
      stt.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => { console.error(`[${this.callId}] [stt] Deepgram HTTP ${res.statusCode}: ${body}`); this.finish(); });
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
    this.activeAbort?.abort();
    try { this.stt?.close(); } catch { /* noop */ }
    this.log("session", "ended");
    this.resolveDone?.();
  }

  // ── plivo_rx: caller μ-law → PCM16 → Deepgram (binary frames) ─────────────
  private onPlivoMessage(data: Buffer): void {
    let msg: { event?: string; media?: { payload?: string } };
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.event === "media" && msg.media?.payload) {
      const pcm = ulawToPcm(Buffer.from(msg.media.payload, "base64"));
      if (this.stt?.readyState === WebSocket.OPEN) this.stt.send(pcm);
    } else if (msg.event === "stop") {
      this.log("plivo_rx", "Plivo stop event");
      this.finish();
    }
  }

  // ── deepgram_rx: final transcripts → turns / barge-in ─────────────────────
  private onDeepgramMessage(data: Buffer): void {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.type !== "Results") return;
    const transcript: string = msg?.channel?.alternatives?.[0]?.transcript || "";
    if (!transcript.trim()) return;

    if (this.agentSpeaking) this.bargeIn();
    void this.handleTurn(transcript.trim());
  }

  // ── turn: Gemini LLM stream → per-sentence Inworld TTS → Plivo ────────────
  private async handleTurn(transcript: string): Promise<void> {
    if (this.processing) { this.pendingTurn = transcript; return; }
    this.processing = true;
    this.log("turn", `user: ${transcript}`);
    this.history.push({ role: "user", parts: [{ text: transcript }] });

    const abort = new AbortController();
    this.activeAbort = abort;
    let full = "";
    let sentence = "";
    try {
      for await (const token of this.streamLLM(abort.signal)) {
        full += token;
        sentence += token;
        const m = sentence.match(/^(.+?[.!?])\s+/);
        if (m) {
          sentence = sentence.slice(m[0].length);
          await this.speak(m[1], abort.signal);
        }
      }
      if (sentence.trim()) await this.speak(sentence.trim(), abort.signal);
      this.history.push({ role: "model", parts: [{ text: full }] });
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

  private async *streamLLM(signal: AbortSignal): AsyncGenerator<string> {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: this.systemText }] },
        contents: this.history,
        generationConfig: { temperature: 0.7, maxOutputTokens: 256 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Gemini: no response body");
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const text = JSON.parse(data)?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text as string;
        } catch { /* ignore partial */ }
      }
    }
  }

  /** Synthesize via Inworld TTS (PCM), resample + encode to μ-law, stream to Plivo. */
  private async speak(text: string, signal?: AbortSignal): Promise<void> {
    this.log("tts", `speaking: ${text.slice(0, 60)}`);
    const res = await fetch(TTS_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${INWORLD_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: INWORLD_VOICE,
        model_id: INWORLD_TTS_MODEL,
        audio_config: { audio_encoding: "PCM", sample_rate_hertz: TTS_SAMPLE_RATE },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Inworld TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const raw = new Uint8Array(await res.arrayBuffer());
    if (raw.length % 2 !== 0) console.warn(`[${this.callId}] [tts] odd byte count (${raw.length}) — output may not be PCM16`);
    const pcm = TTS_SAMPLE_RATE !== PLIVO_SAMPLE_RATE
      ? resamplePcm16(raw, TTS_SAMPLE_RATE, PLIVO_SAMPLE_RATE)
      : raw;
    this.enqueueAudio(pcmToUlaw(pcm));
    this.flushRemainder();
  }

  // ── plivo_tx ──────────────────────────────────────────────────────────────
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
    this.agentSpeaking = true;
    this.plivoWs.send(JSON.stringify({
      event: "playAudio",
      media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: chunk.toString("base64") },
    }));
  }

  private bargeIn(): void {
    this.log("barge-in", "user interrupted — clearing playback");
    this.agentSpeaking = false;
    this.outBuffer = Buffer.alloc(0);
    this.activeAbort?.abort();
    if (this.plivoWs.readyState === WebSocket.OPEN) {
      this.plivoWs.send(JSON.stringify({ event: "clearAudio", stream_id: this.streamId }));
    }
  }
}

export async function runAgent(opts: AgentOptions): Promise<void> {
  await new InworldTtsAgent(opts).run();
}
