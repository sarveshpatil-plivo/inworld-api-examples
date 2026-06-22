/**
 * Orchestrates the cascaded pipeline: Plivo → STT → LLM → TTS → Plivo
 *
 * This handler:
 * 1. Receives audio from Plivo
 * 2. Sends to Inworld STT for transcription
 * 3. When user finishes speaking, sends transcript to LLM
 * 4. Streams LLM response through TTS
 * 5. Sends synthesized audio back to Plivo
 */
import WebSocket from "ws";
import { config } from "../config.js";
import { InworldSTTClient } from "./inworld-stt.js";
import { streamChatCompletion, type Message } from "./inworld-llm.js";
import { synthesizeSpeech } from "./inworld-tts.js";

interface PlivoStartMessage {
  event: "start";
  start: { streamId: string; callId: string; from: string; to: string };
}

interface PlivoMediaMessage {
  event: "media";
  media: { payload: string; timestamp: string };
}

interface PlivoStopMessage {
  event: "stop";
}

type PlivoMessage = PlivoStartMessage | PlivoMediaMessage | PlivoStopMessage;

const MIN_CHUNK_BYTES = 400; // 50ms of μ-law 8kHz

export function handleCallStream(plivoWs: WebSocket): void {
  let streamId: string | null = null;
  let stt: InworldSTTClient | null = null;
  let conversationHistory: Message[] = [
    { role: "system", content: config.systemPrompt },
  ];
  let currentTranscript = "";
  let silenceTimeout: NodeJS.Timeout | null = null;
  let isProcessing = false;
  let activeAbort: AbortController | null = null;

  function sendToPlivo(payload: Buffer) {
    if (plivoWs.readyState === WebSocket.OPEN && streamId) {
      // Send in chunks for smooth playback
      for (let i = 0; i < payload.length; i += MIN_CHUNK_BYTES) {
        const chunk = payload.subarray(i, i + MIN_CHUNK_BYTES);
        plivoWs.send(JSON.stringify({
          event: "playAudio",
          media: { payload: chunk.toString("base64") },
        }));
      }
    }
  }

  function clearPlivoAudio() {
    if (plivoWs.readyState === WebSocket.OPEN) {
      plivoWs.send(JSON.stringify({ event: "clearAudio" }));
    }
  }

  async function processUserInput(transcript: string) {
    if (isProcessing || !transcript.trim()) return;
    isProcessing = true;

    console.log(`[pipeline] User: ${transcript}`);
    conversationHistory.push({ role: "user", content: transcript });

    const abort = new AbortController();
    activeAbort = abort;

    try {
      // Collect LLM response
      let fullResponse = "";
      let sentenceBuffer = "";

      for await (const chunk of streamChatCompletion(conversationHistory, abort.signal)) {
        fullResponse += chunk;
        sentenceBuffer += chunk;

        // Send TTS for complete sentences (improves perceived latency)
        const sentenceMatch = sentenceBuffer.match(/^(.+?[.!?])\s*/);
        if (sentenceMatch) {
          const sentence = sentenceMatch[1];
          sentenceBuffer = sentenceBuffer.slice(sentenceMatch[0].length);

          console.log(`[pipeline] Assistant (partial): ${sentence}`);
          const audio = await synthesizeSpeech({ text: sentence });
          sendToPlivo(audio);
        }
      }

      // Send any remaining text
      if (sentenceBuffer.trim()) {
        console.log(`[pipeline] Assistant (final): ${sentenceBuffer}`);
        const audio = await synthesizeSpeech({ text: sentenceBuffer });
        sendToPlivo(audio);
      }

      conversationHistory.push({ role: "assistant", content: fullResponse });
      console.log(`[pipeline] Response complete`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        console.log("[pipeline] Response cancelled (barge-in)");
      } else {
        console.error("[pipeline] Error:", err);
      }
    } finally {
      isProcessing = false;
      activeAbort = null;
    }
  }

  plivoWs.on("message", async (data: Buffer) => {
    const msg: PlivoMessage = JSON.parse(data.toString());

    switch (msg.event) {
      case "start":
        streamId = msg.start.streamId;
        console.log(`[call] Stream started (call: ${msg.start.callId}, from: ${msg.start.from})`);

        // Initialize STT
        stt = new InworldSTTClient();

        stt.on("transcript", (text, isFinal) => {
          if (isFinal && text.trim()) {
            currentTranscript = text;

            // Clear any existing timeout
            if (silenceTimeout) clearTimeout(silenceTimeout);

            // Wait for silence before processing (simple end-of-utterance detection)
            silenceTimeout = setTimeout(() => {
              if (currentTranscript && !isProcessing) {
                // User might be interrupting - cancel current response
                if (activeAbort) {
                  activeAbort.abort();
                  clearPlivoAudio();
                }
                processUserInput(currentTranscript);
                currentTranscript = "";
              }
            }, 1000); // 1 second silence threshold
          }
        });

        stt.on("error", (err) => console.error(`[stt] Error: ${err.message}`));
        stt.on("closed", () => console.log("[stt] Closed"));

        try {
          await stt.connect();

          // Send initial greeting
          console.log("[pipeline] Sending greeting...");
          const greeting = await synthesizeSpeech({
            text: "Hello! How can I help you today?",
          });
          sendToPlivo(greeting);
        } catch (err) {
          console.error("[call] Failed to initialize STT:", err);
        }
        break;

      case "media":
        if (stt && msg.media) {
          stt.sendAudio(msg.media.payload);
        }
        break;

      case "stop":
        console.log("[call] Stream stopped");
        if (silenceTimeout) clearTimeout(silenceTimeout);
        stt?.close();
        stt = null;
        break;
    }
  });

  plivoWs.on("close", () => {
    console.log("[call] WebSocket closed");
    if (silenceTimeout) clearTimeout(silenceTimeout);
    activeAbort?.abort();
    stt?.close();
  });
}
