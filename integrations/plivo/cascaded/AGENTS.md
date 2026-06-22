# Agents Guide - Plivo + Inworld Cascaded Pipeline

This document provides context for AI coding agents (Claude, Cursor, Copilot, etc.) working on this codebase.

## Project Overview

This is a voice agent that connects Plivo phone calls to Inworld using separate services:
1. **STT** - Speech-to-Text (transcription)
2. **Router/LLM** - Language model for responses
3. **TTS** - Text-to-Speech (synthesis)

## Architecture

```
Plivo → Your Server → Inworld STT → Inworld LLM → Inworld TTS → Your Server → Plivo
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Express server + WebSocket setup |
| `src/config.ts` | Environment variable handling |
| `src/server/xml.ts` | Plivo XML webhook response |
| `src/pipeline/call-handler.ts` | Orchestrates the full pipeline |
| `src/pipeline/inworld-stt.ts` | Inworld STT WebSocket client |
| `src/pipeline/inworld-llm.ts` | Inworld Router API client |
| `src/pipeline/inworld-tts.ts` | Inworld TTS API client |

## Audio Format

- **Plivo**: G.711 μ-law, 8kHz, mono
- **Inworld STT**: Accepts μ-law 8kHz
- **Inworld TTS**: Outputs μ-law 8kHz (configured via `output_format`)

## Pipeline Flow

1. Plivo streams caller audio to server
2. Server forwards audio to Inworld STT
3. STT returns transcript when user stops speaking
4. Server sends transcript + history to Inworld Router API
5. Router streams LLM response text
6. Server sends text chunks to Inworld TTS
7. TTS returns audio chunks
8. Server streams audio back to Plivo

## API Endpoints Used

### Inworld STT
- WebSocket: `wss://api.inworld.ai/v1/stt/stream`
- Auth: `Basic <api-key>`

### Inworld Router/LLM
- POST: `https://api.inworld.ai/v1/chat/completions`
- Auth: `Basic <api-key>`
- Streaming: `stream: true`

### Inworld TTS
- POST: `https://api.inworld.ai/v1/tts`
- Auth: `Basic <api-key>`
- Format: `output_format: "mulaw_8000"`

## Common Tasks

### Change the STT language
Edit `src/pipeline/inworld-stt.ts`, modify `language_code` in config.

### Change the LLM model
Set `INWORLD_MODEL` env var or edit `src/config.ts`.

### Change the TTS voice
Set `TTS_VOICE` env var or edit `src/config.ts`.

### Adjust silence detection threshold
Edit `src/pipeline/call-handler.ts`, modify the `setTimeout` value (currently 1000ms).

### Add custom processing between stages
Modify `processUserInput()` in `src/pipeline/call-handler.ts`.

## Conversation History

Maintained in `conversationHistory` array in call-handler.ts:
```typescript
{ role: "system", content: systemPrompt }
{ role: "user", content: "user message" }
{ role: "assistant", content: "ai response" }
```

## Barge-in Handling

When user speaks while AI is responding:
1. `AbortController` cancels in-flight LLM/TTS requests
2. `clearAudio` sent to Plivo to stop playback
3. New user input processed immediately

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
- Async generators for streaming
- AbortController for cancellation
