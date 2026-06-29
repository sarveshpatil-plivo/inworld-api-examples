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

- **`inbound/server.ts`** — telephony + Plivo provisioning ONLY (`configurePlivoWebhooks`, `/answer`, `/ws`, `/hangup`, `/fallback`). Mirrors the s2s-pipeline server (same structure; hands off to the cascaded agent).
- **`inbound/agent.ts`** — the turn/state machine: STT transcripts → LLM stream → per-sentence TTS → paced playback, plus barge-in and the `end_call` hangup.
- **`inbound/inworld.ts`** — the Inworld clients: `InworldSTT` (WebSocket), `streamLLM` (Router SSE), `synthesize` (TTS → μ-law).
- **`inbound/system_prompt.md`** — system instructions (override via `SYSTEM_PROMPT`).
- **`utils.ts`** — phone normalization **+ G.711 μ-law↔PCM + resample** (used by `inworld.ts`; this pipeline transcodes, S2S doesn't).

## Pipeline flow (agent.ts)

1. Plivo `media` (μ-law 8k) → `ulawToPcm` → LINEAR16 PCM → STT `audioChunk`.
2. STT emits `result.transcription.{transcript,isFinal}`; on a final transcript an 800ms silence
   timer debounces end-of-utterance.
3. On fire → `handleTurn`: stream the Router/LLM, split on sentence boundaries, and `speak()` each.
4. `speak()` → TTS (PCM) → resample to 8k → `pcmToUlaw` → 160-byte `playAudio` frames.
5. Any caller speech while `isSpeaking()` → `bargeIn()`: abort LLM/TTS + `clearAudio`.
6. `history` (system/user/assistant) is maintained across turns.
7. Tools: the Router may return `tool_calls` (OpenAI format). `end_call` arms a hangup that
   fires once the farewell audio drains (`handleToolCall` → tx-pump → `doHangup`).

## API contracts (corrected from official examples)

- **STT** — `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional`, `Basic` auth.
  Config `{transcribeConfig:{modelId, audioEncoding:"LINEAR16", sampleRateHertz:8000, numberOfChannels:1, language}}`;
  frames `{audioChunk:{content:<base64 pcm16>}}`; responses `result.transcription.{transcript,isFinal}`.
- **Router/LLM** — `POST https://api.inworld.ai/v1/chat/completions`, SSE, `choices[0].delta.content`
  and `choices[0].delta.tool_calls` (OpenAI tool format; streamed fragments accumulated by index → `end_call`).
- **TTS** — `POST https://api.inworld.ai/tts/v1/voice`, body
  `{text, voice_id, model_id, audio_config:{audio_encoding:"LINEAR16", sample_rate_hertz}}`;
  returns JSON `{audioContent:<base64 LINEAR16>}` (may carry a WAV header — strip it).

## Rules

- NEVER commit `.env` / API keys. Key needs **STT + Router + TTS** scopes.
- `playAudio` MUST include `contentType:"audio/x-mulaw"` + `sampleRate:8000`; send 160-byte (20ms) chunks.
- Synthesize TTS **per sentence** as the LLM streams — don't wait for the full response.
- Barge-in (gated on `isSpeaking()`): `activeAbort.abort()` + `clearAudio`.
- Keep telephony/provisioning in `server.ts`, pipeline in `agent.ts`.

## Env vars

Required: `INWORLD_API_KEY` (STT+Router+TTS), `PUBLIC_URL`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN`, `PLIVO_PHONE_NUMBER`.
Optional (override pipeline defaults): `SERVER_PORT`, `SYSTEM_PROMPT`, `LLM_MODEL`, `STT_MODEL`, `TTS_MODEL`, `VOICE`, `TTS_SAMPLE_RATE`.

## Verifying a change (needs STT+Router+TTS-scoped key)

1. Fill `.env`; `ngrok http 3000`; `npm run dev` (auto-provisions Plivo).
2. Call the number; confirm greeting, transcription logs (`[turn] user: ...`), a spoken reply, and barge-in.
3. If STT errors: check the `[stt]` logs (`Inworld HTTP <status>` / `error frame`). If TTS errors: it throws and surfaces as `[turn] pipeline error` (or `[tts] skipped` for a single sentence) — likely a scope/format mismatch to adjust.
