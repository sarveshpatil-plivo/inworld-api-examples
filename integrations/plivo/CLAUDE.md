# Plivo + Inworld Voice Agent

Two examples: `realtime/` (single WebSocket) and `cascaded/` (STT→LLM→TTS pipeline).

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

| Change | File |
|--------|------|
| System prompt | `src/config.ts` |
| Voice/model | `realtime/src/voice/inworld-realtime.ts` |
| Plivo XML | `src/server/xml.ts` |
| Call handling | `src/voice/call-handler.ts` |
