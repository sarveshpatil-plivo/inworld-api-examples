# Plivo + Inworld STT-LLM-TTS (Cascaded) Pipeline — Voice Agent

Inbound phone voice agent. Three separate Inworld services chained: **STT** (WebSocket) →
**Router/LLM** (streaming HTTP) → **TTS** (HTTP) → Plivo. Each stage is independently swappable
and observable (vs. the single-socket `s2s-pipeline/`). Layout:
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

- **`inbound/server.ts`** — telephony + Plivo provisioning ONLY (`configurePlivoWebhooks`, `/answer`, `/ws`, `/hangup`, `/fallback`). Identical to s2s-pipeline.
- **`inbound/agent.ts`** — the cascaded pipeline + state machine. Owns the STT socket, the Router/LLM stream, and the TTS calls.
- **`inbound/system_prompt.md`** — system instructions (override via `SYSTEM_PROMPT`).
- **`utils.ts`** — phone normalization **+ G.711 μ-law↔PCM + resample** (this pipeline transcodes; S2S doesn't).

## Pipeline flow (agent.ts)

1. Plivo `media` (μ-law 8k) → `ulawToPcm` → LINEAR16 PCM → STT `audioChunk`.
2. STT emits `result.transcription.{transcript,isFinal}`; on a final transcript an 800ms silence
   timer debounces end-of-utterance.
3. On fire → `handleTurn`: stream the Router/LLM, split on sentence boundaries, and `speak()` each.
4. `speak()` → TTS (PCM) → resample to 8k → `pcmToUlaw` → 160-byte `playAudio` frames.
5. Any caller speech while `agentSpeaking` → `bargeIn()`: abort LLM/TTS + `clearAudio`.
6. `history` (system/user/assistant) is maintained across turns.

## API contracts (corrected from official examples)

- **STT** — `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional`, `Basic` auth.
  Config `{transcribeConfig:{modelId, audioEncoding:"LINEAR16", sampleRateHertz:8000, numberOfChannels:1, language}}`;
  frames `{audioChunk:{content:<base64 pcm16>}}`; responses `result.transcription.{transcript,isFinal}`.
- **Router/LLM** — `POST https://api.inworld.ai/v1/chat/completions`, SSE, `choices[0].delta.content`.
- **TTS** — `POST https://api.inworld.ai/tts/v1/voice:stream`, body
  `{text, voice_id, model_id, audio_config:{audio_encoding:"PCM", sample_rate_hertz}}`.

## Rules

- NEVER commit `.env` / API keys. Key needs **STT + Router + TTS** scopes.
- `playAudio` MUST include `contentType:"audio/x-mulaw"` + `sampleRate:8000`; send 160-byte (20ms) chunks.
- Synthesize TTS **per sentence** as the LLM streams — don't wait for the full response.
- Barge-in (gated on `agentSpeaking`): `activeAbort.abort()` + `clearAudio`.
- Keep telephony/provisioning in `server.ts`, pipeline in `agent.ts`.

## Env vars

Required: `INWORLD_API_KEY` (STT+Router+TTS), `PUBLIC_URL`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_PHONE_NUMBER`.
Optional: `SERVER_PORT`, `DEFAULT_COUNTRY_CODE`, `SYSTEM_PROMPT`, `INWORLD_MODEL`, `INWORLD_STT_MODEL`,
`INWORLD_TTS_MODEL`, `INWORLD_VOICE`, `TTS_SAMPLE_RATE`.

## Verifying a change (needs STT+Router+TTS-scoped key)

1. Fill `.env`; `ngrok http 3000`; `npm run dev` (auto-provisions Plivo).
2. Call the number; confirm greeting, transcription logs (`[turn] user: ...`), a spoken reply, and barge-in.
3. If STT/TTS error: check the `[stt]`/`[tts]` logs for the real status — likely a scope/format mismatch to adjust.
