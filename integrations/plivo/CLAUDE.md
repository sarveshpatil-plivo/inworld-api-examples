# Plivo + Inworld Integration

Voice agent examples connecting Plivo phone calls to Inworld AI.

## Structure

- `realtime/` - Single WebSocket to Inworld Realtime API (STT+LLM+TTS combined)
- `cascaded/` - Separate calls to Inworld STT → Router/LLM → TTS

## Key Decisions

- **Audio format**: G.711 μ-law 8kHz - no transcoding between Plivo and Inworld
- **Barge-in**: Send `clearAudio` to Plivo + `response.cancel` to Inworld
- **Chunking**: Buffer 400 bytes (50ms) before sending to avoid packet overhead

## Do NOT

- Commit `.env` files or API keys
- Modify audio sample rates (must stay 8kHz for Plivo)
- Use synchronous TTS calls in cascaded (use streaming for lower latency)

## Quick Commands

```bash
cd realtime && npm run dev   # Start realtime example
cd cascaded && npm run dev   # Start cascaded example
```

## Plivo WebSocket Events

| From Plivo | To Plivo |
|------------|----------|
| `start` | `playAudio` |
| `media` | `clearAudio` |
| `stop` | |

## Inworld Realtime Events

| Send | Receive |
|------|---------|
| `session.update` | `session.created` |
| `input_audio_buffer.append` | `response.output_audio.delta` |
| `response.cancel` | `input_audio_buffer.speech_started` |
