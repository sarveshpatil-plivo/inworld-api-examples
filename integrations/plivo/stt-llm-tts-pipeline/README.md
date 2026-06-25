# Plivo + Inworld STT-LLM-TTS (Cascaded) Pipeline — Inbound Voice Agent

Inbound phone voice agent that wires three separate [Inworld](https://www.inworld.ai/) services —
**STT → Router/LLM → TTS** — behind [Plivo](https://www.plivo.com/) telephony. Each stage is
independently swappable and observable, the trade-off being more moving parts and higher latency
than the single-socket [`s2s-pipeline`](../s2s-pipeline/). The server auto-provisions the Plivo
Application/number on startup; the agent streams the LLM and synthesizes TTS per sentence, with
barge-in. Native orchestration (raw WebSockets/HTTP), no framework.

## Architecture

```
┌────────┐   ┌────────┐   ┌──────────────────────────────────────────────┐
│ Caller │──▶│ Plivo  │──▶│  server.ts (/ws)  ·  agent.ts (pipeline)       │
│ (Phone)│◀──│ (PSTN) │◀──│  ┌──────┐   ┌────────┐   ┌──────┐             │
└────────┘   └────────┘   │  │ STT  │──▶│ Router │──▶│ TTS  │  (Inworld)  │
                          │  │ (WS) │   │ (LLM)  │   │(HTTP)│             │
                          │  └──────┘   └────────┘   └──────┘             │
                          └──────────────────────────────────────────────┘
   μ-law 8k ──ulawToPcm──▶ LINEAR16 (STT)        TTS PCM ──pcmToUlaw──▶ μ-law 8k
```

## Project structure

```
stt-llm-tts-pipeline/
├── inbound/
│   ├── agent.ts          # cascaded pipeline + state machine (STT/LLM/TTS)
│   ├── server.ts         # telephony + Plivo provisioning: /answer /ws /hangup /fallback
│   └── system_prompt.md  # system instructions
├── utils.ts              # phone normalization + G.711 μ-law↔PCM + resample
├── package.json / tsconfig.json / .env.example / README.md
```

## Prerequisites

- Node.js 18+, [ngrok](https://ngrok.com/), a [Plivo](https://www.plivo.com/) voice number + Auth ID/Token
- An [Inworld](https://www.inworld.ai/) API key scoped for **STT, Router, and TTS**

## Setup & run

```bash
npm install
cp .env.example .env      # fill INWORLD_API_KEY, PLIVO_* , PUBLIC_URL, PLIVO_PHONE_NUMBER
ngrok http 3000           # put the HTTPS URL in PUBLIC_URL
npm run dev               # auto-provisions Plivo, then listens
```

Then call your number. Manual alternative: leave `PLIVO_PHONE_NUMBER` unset and point the number's
Answer URL at `https://<domain>/answer` (POST).

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INWORLD_API_KEY` | yes | – | Inworld key with **STT + Router + TTS** scopes |
| `PUBLIC_URL` | yes | – | Public HTTPS base URL (ngrok), no trailing slash |
| `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` | yes | – | Plivo credentials |
| `PLIVO_PHONE_NUMBER` | for auto-provision | – | E.164 number to map to this app |
| `SERVER_PORT` | no | `3000` | HTTP/WS port |
| `INWORLD_MODEL` | no | `openai/gpt-4.1-mini` | Router/LLM model |
| `INWORLD_STT_MODEL` | no | `inworld/inworld-stt-1` | STT model |
| `INWORLD_TTS_MODEL` | no | `inworld-tts-2` | TTS model |
| `INWORLD_VOICE` | no | `Sarah` | TTS voice |
| `TTS_SAMPLE_RATE` | no | `8000` | PCM rate requested from TTS (resampled to 8k for Plivo) |

## API contracts (corrected from Inworld's official examples)

- **STT** — `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional` (`Basic` auth):
  `transcribeConfig` → `audioChunk{content}` frames → `result.transcription.{transcript,isFinal}`.
- **Router/LLM** — `POST /v1/chat/completions`, SSE (`choices[0].delta.content`).
- **TTS** — `POST /tts/v1/voice:stream`, body `{text, voice_id, model_id, audio_config:{audio_encoding,sample_rate_hertz}}`.

## Troubleshooting

- **403 / "required scopes"** — the key isn't scoped for STT/Router/TTS.
- **No transcription** — check STT `[stt]` logs; may need 16k LINEAR16 instead of 8k.
- **Garbled TTS audio** — sample-rate mismatch; set `TTS_SAMPLE_RATE` to what TTS actually returns.
- **High latency** — inherent to 3 sequential services; the `s2s-pipeline/` is lower-latency.

## Choosing between this and `s2s-pipeline`

| | Cascaded (this) | S2S (`s2s-pipeline`) |
|---|---|---|
| Latency | higher (3 hops) | lower (one socket) |
| Flexibility | mix/swap STT·LLM·TTS | Inworld Realtime only |
| Observability | per-stage transcripts/logs | single pipeline |

## License

MIT
