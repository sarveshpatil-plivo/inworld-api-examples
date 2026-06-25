# Plivo + Inworld TTS Voice Agent

Full inbound phone voice agent spotlighting **Inworld TTS**. Other stages use different providers:
Deepgram STT → Gemini LLM → **Inworld TTS**, over Plivo. Layout:
`inbound/{agent.ts, server.ts, system_prompt.md}` + a shared `utils.ts`.

## Commands

```bash
npm install
npm run dev        # tsx watch inbound/server.ts (SERVER_PORT, default 3000)
npm run build
```
Local testing needs `ngrok http 3000` → put the HTTPS URL in `PUBLIC_URL`.

## Responsibilities

- **`inbound/server.ts`** — telephony + Plivo provisioning only (`/answer`, `/ws`, `/hangup`, `/fallback`).
- **`inbound/agent.ts`** — pipeline + state machine: Deepgram STT socket, Gemini LLM stream, Inworld TTS calls.
- **`inbound/system_prompt.md`** — system instructions (override via `SYSTEM_PROMPT`).
- **`utils.ts`** — phone normalization + G.711 μ-law↔PCM + resample (Inworld TTS PCM → μ-law).

## Provider contracts

- **STT** — `wss://api.deepgram.com/v1/listen?...&encoding=linear16&sample_rate=8000&interim_results=false`, header `Authorization: Token <key>`. Send raw PCM16 bytes; receive `{type:"Results", channel.alternatives[0].transcript}`.
- **LLM** — Gemini `v1beta/models/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key`, body `{systemInstruction, contents:[{role:"user"|"model", parts:[{text}]}], generationConfig}`; SSE `candidates[0].content.parts[0].text`.
- **TTS** — `POST https://api.inworld.ai/tts/v1/voice:stream` (Basic auth), body `{text, voice_id, model_id, audio_config:{audio_encoding:"PCM", sample_rate_hertz}}` → PCM (resampled to 8k + μ-law for Plivo).

## Rules

- NEVER commit `.env` / API keys.
- Decode Plivo μ-law → PCM16 for Deepgram (LINEAR16). Inworld TTS returns PCM → resample to 8k + `pcmToUlaw`.
- `playAudio` MUST include `contentType:"audio/x-mulaw"` + `sampleRate:8000`; send 160-byte (20ms) chunks.
- Gemini history uses `contents` with roles `user`/`model`; system prompt via `systemInstruction`.
- Stream the LLM and synthesize TTS per sentence; barge-in gated on `agentSpeaking`.
- Keep telephony/provisioning in `server.ts`, pipeline in `agent.ts`.

## Env vars

Required: `INWORLD_API_KEY` (TTS), `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `PUBLIC_URL`,
`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_PHONE_NUMBER`. Optional: `SERVER_PORT`, `DEEPGRAM_MODEL`,
`GEMINI_MODEL`, `INWORLD_TTS_MODEL`, `INWORLD_VOICE`, `TTS_SAMPLE_RATE`.
