import "dotenv/config";

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  plivoAuthId: required("PLIVO_AUTH_ID"),
  plivoAuthToken: required("PLIVO_AUTH_TOKEN"),
  inworldApiKey: required("INWORLD_API_KEY"),

  port: parseInt(optional("PORT", "3000"), 10),
  serverUrl: required("SERVER_URL"),

  systemPrompt: optional(
    "SYSTEM_PROMPT",
    "You are a helpful voice assistant powered by Inworld. Keep responses brief and conversational."
  ),

  // TTS configuration
  ttsVoice: optional("TTS_VOICE", "Sarah"),
  ttsModel: optional("TTS_MODEL", "inworld-tts-2"),

  // LLM configuration
  llmModel: optional("INWORLD_MODEL", "openai/gpt-4.1-mini"),
} as const;
