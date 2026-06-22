/**
 * Inworld Text-to-Speech (TTS) client.
 *
 * Converts text to speech audio using Inworld's TTS API.
 * Docs: https://docs.inworld.ai/tts/overview
 */
import { config } from "../config.js";

interface TTSOptions {
  text: string;
  voice?: string;
  model?: string;
}

/**
 * Synthesizes speech from text and returns base64-encoded μ-law audio.
 */
export async function synthesizeSpeech(options: TTSOptions): Promise<Buffer> {
  const { text, voice = config.ttsVoice, model = config.ttsModel } = options;

  const response = await fetch("https://api.inworld.ai/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Basic ${config.inworldApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice,
      model,
      output_format: "mulaw_8000", // G.711 μ-law at 8kHz for Plivo
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Inworld TTS API error ${response.status}: ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Streams TTS synthesis, yielding audio chunks as they're generated.
 * Useful for lower latency - start playing audio before full synthesis completes.
 */
export async function* streamSynthesis(
  options: TTSOptions,
  signal?: AbortSignal
): AsyncGenerator<Buffer> {
  const { text, voice = config.ttsVoice, model = config.ttsModel } = options;

  const response = await fetch("https://api.inworld.ai/v1/tts/stream", {
    method: "POST",
    headers: {
      Authorization: `Basic ${config.inworldApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice,
      model,
      output_format: "mulaw_8000",
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Inworld TTS API error ${response.status}: ${body}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield Buffer.from(value);
  }
}
