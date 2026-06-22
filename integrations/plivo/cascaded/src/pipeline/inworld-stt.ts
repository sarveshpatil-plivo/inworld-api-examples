/**
 * Inworld Speech-to-Text (STT) WebSocket client.
 *
 * Streams audio to Inworld's STT service and receives transcriptions.
 * Docs: https://docs.inworld.ai/stt/overview
 */
import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { config } from "../config.js";

interface STTEvents {
  transcript: (text: string, isFinal: boolean) => void;
  error: (error: Error) => void;
  closed: () => void;
}

export declare interface InworldSTTClient {
  on<K extends keyof STTEvents>(event: K, listener: STTEvents[K]): this;
  emit<K extends keyof STTEvents>(event: K, ...args: Parameters<STTEvents[K]>): boolean;
}

export class InworldSTTClient extends EventEmitter {
  private ws: WebSocket | null = null;

  async connect(): Promise<void> {
    const url = "wss://api.inworld.ai/v1/stt/stream";

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Basic ${config.inworldApiKey}` },
      });

      this.ws.on("open", () => {
        console.log("[stt] Connected to Inworld STT");
        // Send initial config
        this.send({
          config: {
            encoding: "MULAW",
            sample_rate_hertz: 8000,
            language_code: "en-US",
          },
        });
        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.transcript) {
            this.emit("transcript", msg.transcript, msg.is_final ?? false);
          }
        } catch {
          // ignore non-JSON frames
        }
      });

      this.ws.on("error", (err) => {
        this.emit("error", err as Error);
        reject(err);
      });

      this.ws.on("close", () => {
        console.log("[stt] Connection closed");
        this.emit("closed");
      });
    });
  }

  sendAudio(base64Audio: string): void {
    this.send({ audio: base64Audio });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
