# Plivo + Inworld Cascaded (STT-LLM-TTS) Voice Agent

A voice agent that connects phone calls to Inworld using a **cascaded pipeline** — three separate Inworld services wired in sequence: Speech-to-Text → Router/LLM → Text-to-Speech. Each stage is independently swappable and observable; the trade-off versus the single-socket [`s2s-pipeline`](../s2s-pipeline/) is more moving parts and higher latency.

```
Caller ↔ Plivo ↔ Server ↔ Inworld STT → Router/LLM → Inworld TTS
         μ-law 8kHz   (μ-law↔PCM conversion at the STT/TTS boundaries)
```

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [ngrok](https://ngrok.com/) account (free tier works)
- [Plivo](https://www.plivo.com/) account with a Voice-enabled phone number
- [Inworld](https://www.inworld.ai/) account with an API key that has **STT, Router, and TTS** access

## Setup

1. **Get your Inworld API key** — sign up at [inworld.ai](https://www.inworld.ai/) and create an API key with access to the STT, Router, and TTS APIs.

2. **Get a Plivo phone number** — sign up at [plivo.com](https://www.plivo.com/), buy a number with Voice capability, and copy your Auth ID and Auth Token from the [console](https://console.plivo.com/dashboard/).

3. **Set up ngrok** — [install ngrok](https://ngrok.com/download), then start a tunnel to port 3000 (a reserved [static domain](https://dashboard.ngrok.com/domains) keeps the URL stable).

4. **Configure environment:**
   ```bash
   cp .env.example .env
   # Fill in INWORLD_API_KEY, PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN,
   # PLIVO_PHONE_NUMBER (E.164), and PUBLIC_URL (your ngrok URL)
   ```

5. **Install dependencies:**
   ```bash
   npm install
   ```

On startup the server **auto-configures Plivo** — it creates (or updates) a Plivo Application pointing at this server's webhooks and maps `PLIVO_PHONE_NUMBER` to it. To configure manually instead, leave `PLIVO_PHONE_NUMBER` unset and set your number's Answer URL to `https://<your-ngrok-domain>/answer` (HTTP POST).

> ngrok is for local development. For production, deploy the server behind a stable HTTPS URL.

## Run

In two terminals:

```bash
ngrok http 3000
```

```bash
npm run dev
```

Set `PUBLIC_URL` in `.env` to the ngrok HTTPS URL, then call your Plivo number.

## How it works

1. Inbound call hits `/answer` → returns Plivo XML with `<Stream bidirectional="true">`
2. Plivo opens a Media Stream WebSocket to `/ws`
3. Caller μ-law is decoded to PCM and streamed to **Inworld STT**; final transcripts drive the turn
4. The transcript is sent to the **Inworld Router/LLM**, which streams the reply
5. Each sentence is synthesized by **Inworld TTS**, converted to μ-law, and streamed back to the caller
6. Barge-in: when the caller speaks while the agent is talking, the in-flight response is cancelled and Plivo playback is cleared

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://<your-ngrok-domain>/ws
  </Stream>
</Response>
```

## Project structure

```
stt-llm-tts-pipeline/
├── inbound/
│   ├── agent.ts          # cascaded STT→LLM→TTS pipeline + call state machine
│   ├── server.ts         # telephony + Plivo provisioning (/answer, /ws, /hangup, /fallback)
│   └── system_prompt.md  # system instructions
└── utils.ts              # phone helpers + G.711 μ-law↔PCM + resampling
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INWORLD_API_KEY` | yes | – | Inworld key with STT + Router + TTS access |
| `PUBLIC_URL` | yes | – | Public HTTPS base URL (your ngrok URL, no trailing slash) |
| `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` | yes | – | Plivo credentials |
| `PLIVO_PHONE_NUMBER` | for auto-provision | – | E.164 number to map to this app |
| `SERVER_PORT` | no | `3000` | HTTP/WebSocket port |
| `INWORLD_MODEL` | no | `openai/gpt-4.1-mini` | Router/LLM model |
| `INWORLD_STT_MODEL` | no | `inworld/inworld-stt-1` | STT model |
| `INWORLD_TTS_MODEL` | no | `inworld-tts-2` | TTS model |
| `INWORLD_VOICE` | no | `Sarah` | TTS voice |

## Cascaded vs. Realtime

| | Cascaded (this example) | Realtime ([`s2s-pipeline`](../s2s-pipeline/)) |
|---|---|---|
| Latency | higher (three sequential services) | lower (single socket) |
| Flexibility | mix/swap STT, LLM, TTS independently | Inworld Realtime only |
| Observability | per-stage transcripts and logs | single pipeline |

## Troubleshooting

- **No audio / one-way audio** — make sure `PUBLIC_URL` matches your ngrok URL and the Answer URL uses HTTPS.
- **No transcription** — check the `[stt]` logs; confirm the key has STT access.
- **No reply after a transcript** — confirm the key has Router access and `INWORLD_MODEL` is valid.
- **Garbled TTS audio** — a sample-rate mismatch; check the `[tts]` logs.
- **High latency** — inherent to the cascaded approach; the [`s2s-pipeline`](../s2s-pipeline/) is lower-latency.

## License

MIT
