/**
 * Inbound voice agent — Inworld LLM spotlight.
 *
 * Full speech-to-speech pipeline over Plivo, where the LLM is Inworld's Router
 * and the other two stages use different providers:
 *   STT  — Deepgram  (wss://api.deepgram.com/v1/listen, LINEAR16 8k)
 *   LLM  — Inworld Router  (POST https://api.inworld.ai/v1/chat/completions, SSE)
 *   TTS  — ElevenLabs  (POST /v1/text-to-speech/{voice}?output_format=ulaw_8000)
 *
 * Audio: Plivo μ-law 8k → PCM16 for Deepgram; ElevenLabs returns μ-law 8k, sent
 * straight to Plivo. The agent owns orchestration and the call state machine.
 */
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { ulawToPcm } from "../utils.js";

// ── Config ──────────────────────────────────────────────────────────────────
const INWORLD_API_KEY = process.env.INWORLD_API_KEY || "";
const INWORLD_LLM_MODEL = process.env.INWORLD_MODEL || "openai/gpt-4.1-mini";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-2-phonecall";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";

const LLM_URL = "https://api.inworld.ai/v1/chat/completions";
const DEEPGRAM_URL =
  `wss://api.deepgram.com/v1/listen?model=${DEEPGRAM_MODEL}` +
  `&encoding=linear16&sample_rate=8000&channels=1&punctuate=true&interim_results=false`;
const ELEVENLABS_URL =
  `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=ulaw_8000`;

const PLIVO_CHUNK_SIZE = 160; // 20ms @ 8kHz μ-law

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

class InworldLlmAgent {
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

    // interim_results=false → each Results is a finalized utterance.
    if (this.agentSpeaking) this.bargeIn();
    void this.handleTurn(transcript.trim());
  }

  // ── turn: Inworld LLM stream → per-sentence ElevenLabs TTS → Plivo ────────
  private async handleTurn(transcript: string): Promise<void> {
    if (this.processing) { this.pendingTurn = transcript; return; }
    this.processing = true;
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
      headers: { Authorization: `Basic ${INWORLD_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: INWORLD_LLM_MODEL, messages, stream: true }),
      signal,
    });
    if (!res.ok) throw new Error(`Inworld Router ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("Inworld Router: no response body");
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

  /** Synthesize via ElevenLabs (μ-law 8k) and stream to Plivo. */
  private async speak(text: string, signal?: AbortSignal): Promise<void> {
    this.log("tts", `speaking: ${text.slice(0, 60)}`);
    const res = await fetch(ELEVENLABS_URL, {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
      signal,
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const ulaw = Buffer.from(await res.arrayBuffer()); // already μ-law 8k
    this.enqueueAudio(ulaw);
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
    this.agentSpeaking = true; // audio is actively going to the caller
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
  await new InworldLlmAgent(opts).run();
}
