/**
 * Inworld Realtime (speech-to-speech) client: owns the WebSocket and the event
 * protocol, exposing the agent a small handler/method surface. One socket does
 * STT + LLM + TTS; audio is G.711 μ-law @ 8 kHz in and out.
 */
import WebSocket from "ws";

const REALTIME_URL = "wss://api.inworld.ai/api/v1/realtime/session";

export interface RealtimeConfig {
  apiKey: string;
  sessionId: string;
  instructions: string;
  llmModel: string;
  sttModel: string;
  ttsModel: string;
  voice: string;
  vadEagerness: string;
  tools: object[];
}

export interface RealtimeHandlers {
  onReady(): void;                                   // session configured
  onAudioDelta(audioB64: string): void;              // a chunk of agent speech
  onResponseDone(): void;                            // a response finished generating
  onUserTranscript(text: string): void;
  onSpeechStarted(): void;                           // caller began speaking (barge-in cue)
  onToolCall(callId: string, name: string, args: string): void;
  onClose(): void;
}

export class InworldRealtime {
  private ws: WebSocket | null = null;

  constructor(private readonly cfg: RealtimeConfig, private readonly h: RealtimeHandlers) {}

  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  connect(): void {
    // `key` is a per-session correlation id, not the API key (that's the header).
    const ws = new WebSocket(`${REALTIME_URL}?key=${this.cfg.sessionId}&protocol=realtime`, {
      headers: { Authorization: `Basic ${this.cfg.apiKey}` },
    });
    this.ws = ws;
    ws.on("message", (d: Buffer) => this.onMessage(d));
    ws.on("error", (e) => { console.error(`[inworld] socket error: ${(e as Error).message}`); this.h.onClose(); });
    ws.on("close", () => this.h.onClose());
    ws.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => { console.error(`[inworld] HTTP ${res.statusCode}: ${body}`); this.h.onClose(); });
      res.on("error", () => this.h.onClose());
    });
  }

  appendAudio(audioB64: string): void { this.send({ type: "input_audio_buffer.append", audio: audioB64 }); }

  /** Seed a first user turn so the agent greets the caller. */
  greet(): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "The call just connected. Greet the caller." }] },
    });
    this.send({ type: "response.create" });
  }

  cancelResponse(): void { this.send({ type: "response.cancel" }); }

  /** Return a tool result, then ask the model to continue (e.g. voice a goodbye). */
  sendToolResult(callId: string, output: object): void {
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.send({ type: "response.create" });
  }

  close(): void { try { this.ws?.close(); } catch { /* noop */ } }

  private onMessage(data: Buffer): void {
    let m: Record<string, unknown>;
    try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.type) {
      case "session.created": this.send(this.sessionUpdate()); break;
      case "session.updated": this.h.onReady(); break;
      // Inworld has shipped both long and short audio-delta event names.
      case "response.audio.delta":
      case "response.output_audio.delta": this.h.onAudioDelta(m.delta as string); break;
      case "response.done": this.h.onResponseDone(); break;
      case "response.function_call_arguments.done":
        this.h.onToolCall(m.call_id as string, m.name as string, m.arguments as string); break;
      case "input_audio_buffer.speech_started": this.h.onSpeechStarted(); break;
      case "conversation.item.input_audio_transcription.completed":
        if (m.transcript) this.h.onUserTranscript(m.transcript as string); break;
      case "error":
        // A session-level error means no progress is possible — tear down.
        console.error(`[inworld] error frame: ${JSON.stringify(m.error)}`); this.h.onClose(); break;
    }
  }

  private sessionUpdate(): object {
    return {
      type: "session.update",
      session: {
        type: "realtime",
        model: this.cfg.llmModel,
        instructions: this.cfg.instructions,
        output_modalities: ["audio", "text"],
        tools: this.cfg.tools,
        tool_choice: "auto",
        audio: {
          input: {
            format: "g711_ulaw",
            transcription: { model: this.cfg.sttModel },
            turn_detection: { type: "semantic_vad", eagerness: this.cfg.vadEagerness, create_response: true, interrupt_response: true },
          },
          output: { format: "g711_ulaw", model: this.cfg.ttsModel, voice: this.cfg.voice },
        },
      },
    };
  }

  private send(msg: object): void { if (this.open) this.ws!.send(JSON.stringify(msg)); }
}
