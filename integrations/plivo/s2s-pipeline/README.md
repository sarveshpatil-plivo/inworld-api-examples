# Plivo + Inworld Realtime Voice Agent

A voice agent that connects phone calls to the [Inworld Realtime API](https://docs.inworld.ai/realtime/overview) for speech-to-speech conversations. One WebSocket to Inworld handles STT + LLM + TTS, and audio is G.711 μ-law at 8kHz on both legs, so it passes through with no conversion.

```
Caller ↔ Plivo ↔ WebSocket ↔ Inworld Realtime
              mulaw 8kHz (passthrough)
```

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [ngrok](https://ngrok.com/) account (free tier works)
- [Plivo](https://www.plivo.com/) account with a Voice-enabled phone number
- [Inworld](https://www.inworld.ai/) account with a Realtime API key

## Setup

1. **Get your Inworld API key** — sign up at [inworld.ai](https://www.inworld.ai/), go to your workspace, and create an API key for the Realtime API.

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

On startup the server **auto-configures Plivo** — it creates (or updates) a Plivo Application pointing at this server's webhooks and maps `PLIVO_PHONE_NUMBER` to it, so there's no manual console step. To configure manually instead, leave `PLIVO_PHONE_NUMBER` unset and set your number's Answer URL to `https://<your-ngrok-domain>/answer` (HTTP POST).

> ngrok is for local development. For production, deploy the server behind a stable HTTPS URL.

## Run

In two terminals:

```bash
ngrok http 3000
```

```bash
npm run dev
```

Set `PUBLIC_URL` in `.env` to the ngrok HTTPS URL, then call your Plivo number — the bot will greet you and you can have a conversation.

## How it works

1. Inbound call hits `/answer` → returns Plivo XML with `<Stream bidirectional="true">`
2. Plivo opens a Media Stream WebSocket to `/ws`
3. Server passes mulaw audio between Plivo and the Inworld Realtime API (no format conversion needed)
4. Barge-in: on speech detection, clears Plivo playback and cancels the Inworld response

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://<your-ngrok-domain>/ws
  </Stream>
</Response>
```

## Project structure

```
s2s-pipeline/
├── inbound/
│   ├── agent.ts          # pipeline orchestration + call state machine
│   ├── server.ts         # telephony + Plivo provisioning (/answer, /ws, /hangup, /fallback)
│   └── system_prompt.md  # system instructions
└── utils.ts              # phone-number helpers
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INWORLD_API_KEY` | yes | – | Inworld key with Realtime API access |
| `PUBLIC_URL` | yes | – | Public HTTPS base URL (your ngrok URL, no trailing slash) |
| `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` | yes | – | Plivo credentials |
| `PLIVO_PHONE_NUMBER` | for auto-provision | – | E.164 number to map to this app (e.g. `+14155551234`) |
| `SERVER_PORT` | no | `3000` | HTTP/WebSocket port |
| `SYSTEM_PROMPT` | no | `inbound/system_prompt.md` | Override the system instructions |
| `INWORLD_MODEL` | no | `openai/gpt-4.1-mini` | LLM model |
| `INWORLD_VOICE` | no | `Sarah` | TTS voice |

## Troubleshooting

- **No audio / one-way audio** — make sure `PUBLIC_URL` matches your ngrok URL and the number's Answer URL uses HTTPS.
- **Call doesn't connect** — confirm the `/answer` webhook is reachable; check the server logs for the incoming-call line.
- **Provisioning failed** — verify the Plivo credentials and that `PLIVO_PHONE_NUMBER` is E.164; see the `[provision]` log lines.
- **No AI response** — verify the Inworld key has Realtime API access; the logs surface the Inworld connection status.

## License

MIT
