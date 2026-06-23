# Plivo + Inworld Voice Agent

Two self-contained examples connecting Plivo phone calls to Inworld:

- **`realtime/`** — single WebSocket to the Inworld Realtime API (STT + LLM + TTS in one).
- **`cascaded/`** — separate Inworld STT → Router/LLM → TTS services chained in a pipeline.

Each folder has its own `README.md` (full setup/usage docs), `CLAUDE.md`, and `AGENTS.md`
with details specific to that example. **Read the agent docs inside the folder you're editing** —
this root file is only an overview.

## Commands

```bash
cd realtime && npm install && npm run dev
cd cascaded && npm install && npm run dev
```

## Rules

- NEVER commit `.env` files or API keys
- NEVER change audio sample rate from 8kHz - Plivo requires it
- ALWAYS buffer 400+ bytes before sending audio (50ms minimum)
- ALWAYS use base64 encoding for audio payloads
- ALWAYS send `clearAudio` to Plivo AND cancel Inworld on barge-in

## Audio

μ-law 8kHz mono. No transcoding. Pass through as-is.

## Plivo WebSocket

Send: `playAudio`, `clearAudio`
Receive: `start`, `media`, `stop`

## Inworld Realtime

Send: `session.update`, `input_audio_buffer.append`, `response.cancel`
Receive: `session.created`, `response.output_audio.delta`, `input_audio_buffer.speech_started`

## File Locations

| Change | realtime/ | cascaded/ |
|--------|-----------|-----------|
| System prompt / env | `src/config.ts` | `src/config.ts` |
| Voice / LLM / STT config | `src/voice/inworld-realtime.ts` | `src/pipeline/inworld-{stt,llm,tts}.ts` |
| Plivo XML (`/voice`) | `src/server/xml.ts` | `src/server/xml.ts` |
| Call handling | `src/voice/call-handler.ts` | `src/pipeline/call-handler.ts` |
| Server bootstrap | `src/index.ts` | `src/index.ts` |
