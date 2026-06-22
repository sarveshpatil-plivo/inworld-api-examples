# Plivo + Inworld Voice Agent Integration

This directory contains two example integrations showing how to connect Plivo phone calls to Inworld AI services.

## Directory Structure

```
plivo/
├── realtime/     # Inworld Realtime API (STT + LLM + TTS in one WebSocket)
└── cascaded/     # Cascaded pipeline (separate STT, Router/LLM, TTS services)
```

## Which Example to Use?

| Use Case | Folder | Description |
|----------|--------|-------------|
| Simplest setup, lowest latency | `realtime/` | Single WebSocket handles everything |
| Custom pipeline, mix providers | `cascaded/` | Control each stage separately |
| Production with monitoring | `cascaded/` | Better observability per stage |

## Quick Start

### Realtime API (Recommended for most use cases)
```bash
cd realtime
cp .env.example .env  # Add your credentials
npm install && npm run dev
```

### Cascaded Pipeline
```bash
cd cascaded
cp .env.example .env  # Add your credentials
npm install && npm run dev
```

## Prerequisites

- Node.js 18+
- Plivo account with a phone number
- Inworld account with API key
- ngrok for local development

## Architecture Overview

### Realtime API Flow
```
Caller <-> Plivo <-> Your Server <-> Inworld Realtime API
                                     (STT + LLM + TTS combined)
```

### Cascaded Pipeline Flow
```
Caller <-> Plivo <-> Your Server <-> Inworld STT
                         |               |
                         |               v
                         |           Inworld Router/LLM
                         |               |
                         v               v
                     Audio Out <---- Inworld TTS
```

## Audio Format

Both Plivo and Inworld support G.711 μ-law at 8kHz, so audio passes through without transcoding.

## Environment Variables

Both examples require:
- `PLIVO_AUTH_ID` - From Plivo Console
- `PLIVO_AUTH_TOKEN` - From Plivo Console
- `INWORLD_API_KEY` - From Inworld Platform
- `SERVER_URL` - Your public URL (ngrok domain)

## Testing

1. Configure Plivo webhook to point to `https://<your-domain>/voice`
2. Call your Plivo number
3. Speak to the AI agent

## Resources

- [Inworld Realtime API Docs](https://docs.inworld.ai/realtime/overview)
- [Inworld STT Docs](https://docs.inworld.ai/stt/overview)
- [Inworld TTS Docs](https://docs.inworld.ai/tts/overview)
- [Plivo Audio Streaming](https://www.plivo.com/docs/voice/xml/stream/)
