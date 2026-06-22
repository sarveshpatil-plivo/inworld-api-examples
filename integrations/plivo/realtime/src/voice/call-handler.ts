/**
 * Bridges a Plivo Media Stream WebSocket to an Inworld Realtime WebSocket.
 *
 * Both Plivo and Inworld use G.711 μ-law at 8kHz, so audio passes through
 * as-is with no format conversion. We only buffer to ≥50ms chunks for
 * efficient transmission.
 */
import WebSocket from "ws";
import { InworldRealtimeClient } from "./inworld-realtime.js";
import { config } from "../config.js";

interface PlivoStartMessage {
  event: "start";
  start: {
    streamId: string;
    callId: string;
    from: string;
    to: string;
  };
}

interface PlivoMediaMessage {
  event: "media";
  media: {
    payload: string;
    timestamp: string;
  };
}

interface PlivoStopMessage {
  event: "stop";
}

type PlivoMessage = PlivoStartMessage | PlivoMediaMessage | PlivoStopMessage;

// 50ms of μ-law 8kHz = 400 bytes (8000 samples/sec × 0.05s × 1 byte/sample)
const MIN_CHUNK_BYTES = 400;

export function handleCallStream(plivoWs: WebSocket): void {
  let streamId: string | null = null;
  let inworld: InworldRealtimeClient | null = null;
  let outBuffer = Buffer.alloc(0);
  let inBuffer = Buffer.alloc(0);

  function sendToPlivo(payload: Buffer) {
    if (plivoWs.readyState === WebSocket.OPEN && streamId) {
      plivoWs.send(JSON.stringify({
        event: "playAudio",
        media: {
          payload: payload.toString("base64"),
        },
      }));
    }
  }

  function flushOutBuffer() {
    while (outBuffer.length >= MIN_CHUNK_BYTES) {
      sendToPlivo(outBuffer.subarray(0, MIN_CHUNK_BYTES));
      outBuffer = outBuffer.subarray(MIN_CHUNK_BYTES);
    }
  }

  plivoWs.on("message", async (data: Buffer) => {
    const msg: PlivoMessage = JSON.parse(data.toString());

    switch (msg.event) {
      case "start":
        streamId = msg.start.streamId;
        console.log(`[call] Stream started (call: ${msg.start.callId}, from: ${msg.start.from})`);

        inworld = new InworldRealtimeClient();

        inworld.on("audio", (base64Audio) => {
          outBuffer = Buffer.concat([outBuffer, Buffer.from(base64Audio, "base64")]);
          flushOutBuffer();
        });

        inworld.on("audioDone", () => {
          if (outBuffer.length > 0) {
            sendToPlivo(outBuffer);
            outBuffer = Buffer.alloc(0);
          }
        });

        inworld.on("speechStarted", () => {
          // Clear output buffer and send clear command to Plivo for barge-in
          outBuffer = Buffer.alloc(0);
          if (plivoWs.readyState === WebSocket.OPEN) {
            plivoWs.send(JSON.stringify({ event: "clearAudio" }));
          }
          inworld?.cancelResponse();
        });

        inworld.on("transcript", (text) => console.log(`[call] User: ${text}`));
        inworld.on("error", (err) => console.error(`[call] Inworld error: ${err.message}`));
        inworld.on("closed", () => console.log("[call] Inworld closed"));

        try {
          await inworld.connect(config.systemPrompt);
        } catch (err) {
          console.error("[call] Failed to connect to Inworld:", err);
        }
        break;

      case "media":
        if (inworld && msg.media) {
          inBuffer = Buffer.concat([inBuffer, Buffer.from(msg.media.payload, "base64")]);
          while (inBuffer.length >= MIN_CHUNK_BYTES) {
            inworld.sendAudio(inBuffer.subarray(0, MIN_CHUNK_BYTES).toString("base64"));
            inBuffer = inBuffer.subarray(MIN_CHUNK_BYTES);
          }
        }
        break;

      case "stop":
        console.log("[call] Stream stopped");
        inworld?.close();
        inworld = null;
        break;
    }
  });

  plivoWs.on("close", () => {
    console.log("[call] WebSocket closed");
    inworld?.close();
  });
}
