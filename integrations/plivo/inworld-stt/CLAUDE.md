# Plivo + Inworld STT Voice Agent

Full inbound phone voice agent spotlighting **Inworld STT**. Other stages use different providers:
**Inworld STT** → Gemini LLM → ElevenLabs TTS, over Plivo. Layout:
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
- **`inbound/agent.ts`** — pipeline + state machine: Inworld STT socket, Gemini LLM stream, ElevenLabs TTS.
- **`inbound/system_prompt.md`** — system instructions (override via `SYSTEM_PROMPT`).
- **`utils.ts`** — phone normalization + G.711 μ-law→PCM (for Inworld STT).

## Provider contracts

- **STT** — `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional` (Basic auth). Send `{transcribeConfig:{modelId, audioEncoding:"LINEAR16", sampleRateHertz:8000, numberOfChannels:1, language}}` then `{audioChunk:{content:<b64 pcm16>}}`; receive `result.transcription.{transcript,isFinal}`.
- **LLM** — `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`, header `x-goog-api-key`, body `{systemInstruction, contents:[{role:"user"|"model", parts:[{text}]}], generationConfig}`; SSE `candidates[0].content.parts[0].text`.
- **TTS** — `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=ulaw_8000`, header `xi-api-key`, body `{text, model_id}` → μ-law 8k.

## Rules

- NEVER commit `.env` / API keys.
- Decode Plivo μ-law → PCM16 before sending to Inworld STT (LINEAR16). ElevenLabs returns μ-law 8k (no conversion out).
- `playAudio` MUST include `contentType:"audio/x-mulaw"` + `sampleRate:8000`; send 160-byte (20ms) chunks.
- Gemini history uses `contents` with roles `user`/`model`; system prompt via `systemInstruction`.
- Stream the LLM and synthesize TTS per sentence; barge-in gated on `agentSpeaking`.
- Keep telephony/provisioning in `server.ts`, pipeline in `agent.ts`.

## Env vars

Required: `INWORLD_API_KEY` (STT), `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `PUBLIC_URL`,
`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_PHONE_NUMBER`. Optional: `SERVER_PORT`,
`INWORLD_STT_MODEL`, `GEMINI_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`.
