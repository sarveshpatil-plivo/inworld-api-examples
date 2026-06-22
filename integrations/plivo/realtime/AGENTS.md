# Agents Guide - Plivo + Inworld Realtime

This document provides context for AI coding agents (Claude, Cursor, Copilot, etc.) working on this codebase.

## Project Overview

This is a voice agent that connects Plivo phone calls to Inworld's Realtime API. One WebSocket handles STT + LLM + TTS.

## Architecture

```
Plivo (μ-law 8kHz) → WebSocket → Inworld Realtime API → WebSocket → Plivo
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Express server + WebSocket setup |
| `src/config.ts` | Environment variable handling |
| `src/server/xml.ts` | Plivo XML webhook response |
| `src/voice/call-handler.ts` | Bridges Plivo ↔ Inworld WebSockets |
| `src/voice/inworld-realtime.ts` | Inworld Realtime API client |

## Audio Format

- **Plivo**: G.711 μ-law, 8kHz, mono
- **Inworld Realtime**: G.711 μ-law, 8kHz, mono
- **No transcoding needed** - audio passes through as-is

## WebSocket Message Types

### From Plivo
- `start` - Call started, contains callId and streamId
- `media` - Audio chunk (base64 μ-law)
- `stop` - Call ended

### To Plivo
- `playAudio` - Send audio to caller
- `clearAudio` - Clear buffer (for barge-in)

### From Inworld
- `session.created` - Send session config
- `session.updated` - Session ready, trigger greeting
- `response.output_audio.delta` - Audio chunk
- `input_audio_buffer.speech_started` - User speaking (barge-in)

### To Inworld
- `session.update` - Configure session
- `input_audio_buffer.append` - Send audio
- `response.cancel` - Cancel response (barge-in)

## Common Tasks

### Change the AI voice
Edit `src/voice/inworld-realtime.ts`, modify `voice` in session config.

### Change the LLM model
Edit `src/voice/inworld-realtime.ts`, modify `model` in session config.

### Change the system prompt
Set `SYSTEM_PROMPT` environment variable.

### Add logging
All key events already log to console with `[tag]` prefixes.

## Testing

1. Set up ngrok: `ngrok http 3000`
2. Configure Plivo webhook to ngrok URL
3. Run: `npm run dev`
4. Call your Plivo number

## Dependencies

- `express` - HTTP server
- `ws` - WebSocket client/server
- `dotenv` - Environment variables

## Code Style

- TypeScript with strict mode
- ES modules (`"type": "module"`)
- Async/await for all async operations
