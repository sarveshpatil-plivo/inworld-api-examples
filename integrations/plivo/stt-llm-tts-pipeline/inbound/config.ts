/**
 * Single source of truth for configuration. Required vars are validated at
 * startup (fail fast with a clear message); optional ones fall back to defaults.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return value;
}
const optional = (name: string, fallback: string): string => process.env[name] || fallback;

export const config = {
  // Required (the Inworld key needs STT + Router + TTS scopes)
  inworldApiKey: required("INWORLD_API_KEY"),
  publicUrl: required("PUBLIC_URL").replace(/\/$/, ""),
  plivoAuthId: required("PLIVO_AUTH_ID"),
  plivoAuthToken: required("PLIVO_AUTH_TOKEN"),
  plivoPhoneNumber: required("PLIVO_PHONE_NUMBER"),

  // Optional — override the pipeline defaults
  port: parseInt(optional("SERVER_PORT", "3000"), 10),
  llmModel: optional("LLM_MODEL", "google-ai-studio/gemini-2.5-flash"),
  sttModel: optional("STT_MODEL", "inworld/inworld-stt-1"),
  ttsModel: optional("TTS_MODEL", "inworld-tts-2"),
  voice: optional("VOICE", "Sarah"),
  ttsSampleRate: parseInt(optional("TTS_SAMPLE_RATE", "8000"), 10),
  systemPrompt:
    process.env.SYSTEM_PROMPT?.trim() ||
    readFileSync(new URL("./system_prompt.md", import.meta.url), "utf-8").trim(),
} as const;
