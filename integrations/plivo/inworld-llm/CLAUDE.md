# Plivo + Inworld LLM Voice Agent

Full inbound phone voice agent spotlighting **Inworld's LLM (Router)**. The other two stages use
different providers, to show how to drop Inworld's LLM into an existing voice stack:
Deepgram STT → **Inworld Router/LLM** → ElevenLabs TTS, over Plivo telephony. Layout:
`inbound/{agent.ts, server.ts, system_prompt.md}` + a shared `utils.ts`.

## Commands

```bash
npm install
npm run dev        # tsx watch inbound/server.ts (SERVER_PORT, default 3000)
npm run build      # tsc -> dist/
npm start          # node dist/inbound/server.js
```

Local testing needs a public tunnel: `ngrok http 3000` → put the HTTPS URL in `PUBLIC_URL`.

## Responsibilities

- **`inbound/server.ts`** — telephony + Plivo provisioning ONLY (`/answer`, `/ws`, `/hangup`, `/fallback`; `configurePlivoWebhooks`). Identical across the plivo examples.
- **`inbound/agent.ts`** — pipeline + state machine. Owns the Deepgram STT socket, the Inworld Router LLM stream, and the ElevenLabs TTS calls.
- **`inbound/system_prompt.md`** — system instructions (override via `SYSTEM_PROMPT`).
- **`utils.ts`** — phone normalization + G.711 μ-law→PCM (for Deepgram).

## Provider contracts (verified against `plivo/python-agents-examples`)

- **STT** — `wss://api.deepgram.com/v1/listen?model=...&encoding=linear16&sample_rate=8000&channels=1&punctuate=true&interim_results=false`, header `Authorization: Token <key>`. Send raw PCM16 bytes; receive `{type:"Results", channel.alternatives[0].transcript}`.
- **LLM** — `POST https://api.inworld.ai/v1/chat/completions` (Basic auth), SSE, `choices[0].delta.content`.
- **TTS** — `POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=ulaw_8000`, header `xi-api-key`, body `{text, model_id}` → μ-law 8k (sent straight to Plivo).

## Rules

- NEVER commit `.env` / API keys.
- Audio: decode Plivo μ-law → PCM16 for Deepgram; ElevenLabs returns μ-law 8k (no conversion out).
- `playAudio` MUST include `contentType:"audio/x-mulaw"` + `sampleRate:8000`; send 160-byte (20ms) chunks.
- Stream the LLM and synthesize TTS **per sentence**; barge-in gated on `agentSpeaking`.
- Keep telephony/provisioning in `server.ts`, pipeline in `agent.ts`.

## Env vars

Required: `INWORLD_API_KEY` (Router), `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `PUBLIC_URL`,
`PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_PHONE_NUMBER`. Optional: `SERVER_PORT`, `INWORLD_MODEL`,
`DEEPGRAM_MODEL`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL`.
