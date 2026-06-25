# Agent Rules — Plivo + Inworld STT-LLM-TTS Pipeline (inbound)

Cascaded STT → Router/LLM → TTS inbound voice agent. See this folder's `CLAUDE.md` for the
pipeline flow, corrected API contracts, and file map.

> ⚠️ Not yet verified live — needs an Inworld key scoped for STT + Router + TTS.

## MUST

- Keep `server.ts` (telephony + Plivo provisioning) and `agent.ts` (pipeline + state machine) separate.
- Convert audio at the boundaries: Plivo μ-law → `ulawToPcm` (LINEAR16) for STT; TTS PCM → `pcmToUlaw` (+ resample) for Plivo.
- Send `playAudio` as `{ media: { contentType:"audio/x-mulaw", sampleRate:8000, payload } }` in 160-byte (20ms) chunks.
- Stream the LLM and synthesize TTS **per sentence** — don't block on the full response.
- Barge-in (gated on `agentSpeaking`): `activeAbort.abort()` + `clearAudio`.
- Maintain `history` (system/user/assistant) across turns.
- `npm run build` (tsc) must pass; verify end-to-end once a scoped key is available.

## MUST NOT

- Commit `.env` / credentials.
- Drop `contentType`/`sampleRate` from `playAudio`, or change the 8kHz Plivo rate.
- Replace per-sentence TTS with a single blocking call at end of turn (kills perceived latency).
- Put pipeline logic in `server.ts` or telephony logic in `agent.ts`.

## API contracts (corrected — see CLAUDE.md)

- STT: `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional` — `transcribeConfig` / `audioChunk` / `result.transcription`.
- LLM: `POST /v1/chat/completions` — SSE `choices[0].delta.content`.
- TTS: `POST /tts/v1/voice:stream` — `{text, voice_id, model_id, audio_config}`.

## Debugging

- `[stt] Inworld HTTP <status>` / `error frame` → scope or config mismatch (8k vs 16k, encoding).
- `[tts] TTS <status>` → scope or unsupported `audio_encoding`/`sample_rate_hertz`.
- No reply after transcript → Router scope/model, or the 800ms silence timer never fired (no `isFinal`).
- Audio garbled → sample-rate mismatch; confirm `TTS_SAMPLE_RATE` matches what TTS actually returns.
