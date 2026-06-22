# Agents Guide - Plivo + Inworld Integration

This document provides context for AI coding agents (Claude, Cursor, Copilot, etc.) working on this codebase.

## Project Overview

Two examples showing how to connect Plivo phone calls to Inworld AI:

| Folder | Approach | When to Use |
|--------|----------|-------------|
| `realtime/` | Single WebSocket (STT+LLM+TTS) | Simple setup, lowest latency |
| `cascaded/` | Separate services (STT → LLM → TTS) | Custom pipeline, more control |

## Audio Format

- **Plivo**: G.711 μ-law, 8kHz, mono
- **Inworld**: G.711 μ-law, 8kHz, mono
- **No transcoding needed** - audio passes through as-is

---

## Realtime Example (`realtime/`)

### Architecture
```
Plivo → WebSocket → Inworld Realtime API (STT+LLM+TTS) → WebSocket → Plivo
```

### Key Files
| File | Purpose |
|------|---------|
| `src/voice/call-handler.ts` | Bridges Plivo ↔ Inworld |
| `src/voice/inworld-realtime.ts` | Inworld Realtime client |
| `src/server/xml.ts` | Plivo XML webhook |

### Inworld Realtime Messages
- `session.update` → Configure session
- `input_audio_buffer.append` → Send audio
- `response.output_audio.delta` → Receive audio
- `response.cancel` → Barge-in

---

## Cascaded Example (`cascaded/`)

### Architecture
```
Plivo → Server → Inworld STT → Inworld LLM → Inworld TTS → Server → Plivo
```

### Key Files
| File | Purpose |
|------|---------|
| `src/pipeline/call-handler.ts` | Orchestrates pipeline |
| `src/pipeline/inworld-stt.ts` | STT WebSocket client |
| `src/pipeline/inworld-llm.ts` | Router/LLM API client |
| `src/pipeline/inworld-tts.ts` | TTS API client |

### Inworld APIs Used
- STT: `wss://api.inworld.ai/v1/stt/stream`
- LLM: `POST https://api.inworld.ai/v1/chat/completions`
- TTS: `POST https://api.inworld.ai/v1/tts`

---

## Common Tasks

### Change the system prompt
Set `SYSTEM_PROMPT` in `.env`

### Change the LLM model
Set `INWORLD_MODEL` in `.env` (cascaded) or edit `inworld-realtime.ts` (realtime)

### Change the TTS voice
Set `TTS_VOICE` in `.env` (cascaded) or edit `inworld-realtime.ts` (realtime)

### Test locally
```bash
ngrok http 3000
npm run dev
# Configure Plivo webhook → ngrok URL
# Call your Plivo number
```

## Code Style

- TypeScript with strict mode
- ES modules (`"type": "module"`)
- Async/await for async operations
- Console logging with `[tag]` prefixes
