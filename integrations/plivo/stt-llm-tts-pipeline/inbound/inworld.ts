/**
 * Inworld cascaded clients: STT (streaming WebSocket, EventEmitter), Router/LLM
 * (OpenAI-compatible SSE), and TTS (JSON audioContent). Audio crossing these is
 * LINEAR16 PCM; the agent converts to/from Plivo's μ-law via utils.
 */
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { ulawToPcm, pcmToUlaw, resamplePcm16 } from "../utils.js";

const STT_URL = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
const LLM_URL = "https://api.inworld.ai/v1/chat/completions";
const TTS_URL = "https://api.inworld.ai/tts/v1/voice";

export interface InworldConfig {
  apiKey: string;
  llmModel: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  ttsSampleRate: number;
  plivoRate: number;
  language: string;
}

export interface Message { role: "system" | "user" | "assistant"; content: string }
export type LlmChunk = { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; args: string };

const auth = (cfg: InworldConfig) => `Basic ${cfg.apiKey}`;

// ── STT: streaming WebSocket ───────────────────────────────────────────────
interface SttEvents {
  ready: () => void;
  transcript: (text: string, isFinal: boolean) => void;
  closed: () => void;
}
export declare interface InworldSTT {
  on<K extends keyof SttEvents>(event: K, listener: SttEvents[K]): this;
  emit<K extends keyof SttEvents>(event: K, ...args: Parameters<SttEvents[K]>): boolean;
}

export class InworldSTT extends EventEmitter {
  private ws: WebSocket | null = null;
  constructor(private readonly cfg: InworldConfig) { super(); }

  connect(): void {
    const ws = new WebSocket(STT_URL, { headers: { Authorization: auth(this.cfg) } });
    this.ws = ws;
    ws.on("open", () => {
      this.send({ transcribeConfig: { modelId: this.cfg.sttModel, audioEncoding: "LINEAR16", sampleRateHertz: this.cfg.plivoRate, numberOfChannels: 1, language: this.cfg.language } });
      this.emit("ready");
    });
    ws.on("message", (d: Buffer) => this.onMessage(d));
    ws.on("error", (e) => { console.error(`[stt] socket error: ${(e as Error).message}`); this.emit("closed"); });
    ws.on("close", () => this.emit("closed"));
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => { console.error(`[stt] HTTP ${res.statusCode}: ${body}`); this.emit("closed"); });
      res.on("error", () => this.emit("closed"));
    });
  }

  /** Caller μ-law → PCM16 → STT. */
  sendCallerAudio(ulawB64: string): void {
    const pcm = ulawToPcm(Buffer.from(ulawB64, "base64"));
    this.send({ audioChunk: { content: pcm.toString("base64") } });
  }

  close(): void { try { this.ws?.close(); } catch { /* noop */ } }

  private onMessage(data: Buffer): void {
    let m: any;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.error) { console.error(`[stt] error frame: ${JSON.stringify(m.error)}`); return; }
    const t = m?.result?.transcription;
    if (t?.transcript) this.emit("transcript", t.transcript, !!t.isFinal);
  }

  private send(msg: object): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
}

// ── LLM: streaming chat completions (yields text + accumulated tool calls) ──
export async function* streamLLM(cfg: InworldConfig, messages: Message[], tools: object[], signal: AbortSignal): AsyncGenerator<LlmChunk> {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { Authorization: auth(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.llmModel, messages, stream: true, tools, tool_choice: "auto" }),
    signal,
  });
  if (!res.ok) throw new Error(`Router ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Router: no response body");
  const decoder = new TextDecoder();
  let buf = "";
  // Tool calls stream as fragments (id+name first, arguments in pieces) — accumulate by index.
  const toolAcc: Record<number, { id: string; name: string; args: string }> = {};
  const flush = function* (): Generator<LlmChunk> {
    for (const tc of Object.values(toolAcc)) if (tc.name) yield { type: "tool_call", id: tc.id, name: tc.name, args: tc.args };
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
      if (data === "[DONE]") { yield* flush(); return; }
      let delta: any;
      try { delta = JSON.parse(data)?.choices?.[0]?.delta; } catch { continue; }
      if (delta?.content) yield { type: "text", text: delta.content as string };
      for (const tc of delta?.tool_calls ?? []) {
        const i: number = tc.index ?? 0;
        const acc = (toolAcc[i] ||= { id: "", name: "", args: "" });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  }
  yield* flush();
}

// ── TTS: synthesize text → μ-law 8 kHz for Plivo ───────────────────────────
export async function synthesize(cfg: InworldConfig, text: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(TTS_URL, {
    method: "POST",
    headers: { Authorization: auth(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice_id: cfg.voice, model_id: cfg.ttsModel, audio_config: { audio_encoding: "LINEAR16", sample_rate_hertz: cfg.ttsSampleRate } }),
    signal,
  });
  if (!res.ok) throw new Error(`Inworld TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const result = (await res.json()) as { audioContent?: string };
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); // barge-in during the request
  if (!result.audioContent) throw new Error("Inworld TTS: no audioContent in response");
  let pcm: Uint8Array = Buffer.from(result.audioContent, "base64");
  if (pcm.length > 44 && Buffer.from(pcm.subarray(0, 4)).toString("ascii") === "RIFF") pcm = pcm.subarray(44);
  const out = cfg.ttsSampleRate !== cfg.plivoRate ? resamplePcm16(pcm, cfg.ttsSampleRate, cfg.plivoRate) : pcm;
  return pcmToUlaw(out);
}
