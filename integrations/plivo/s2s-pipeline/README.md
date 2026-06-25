# Plivo + Inworld S2S Pipeline (Realtime API) — Inbound Voice Agent

Inbound phone voice agent that bridges [Plivo](https://www.plivo.com/) telephony to the
[Inworld Realtime API](https://docs.inworld.ai/realtime/overview). A single WebSocket to Inworld
handles the full speech-to-speech loop — STT, LLM, and TTS — and audio is G.711 μ-law at 8kHz on
both legs, so it passes through with no transcoding. The server auto-provisions the Plivo
Application and number mapping on startup; the agent runs a small call state machine with
barge-in. Native orchestration (raw WebSockets), no framework.

## Architecture

```
┌──────────┐     ┌──────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Caller  │────▶│  Plivo   │────▶│  server.ts (/ws) │────▶│ Inworld Realtime API│
│ (Phone)  │◀────│  (PSTN)  │◀────│  agent.ts (S2S)  │◀────│  (STT + LLM + TTS)  │
└──────────┘     └──────────┘     └──────────────────┘     └─────────────────────┘
                   G.711 μ-law 8kHz (passthrough, no transcoding)
```

1. Caller dials your Plivo number → Plivo POSTs the `/answer` webhook.
2. `/answer` returns XML with `<Stream bidirectional="true">` pointing at `/ws`.
3. Plivo opens a bidirectional media WebSocket; `server.ts` hands it to `agent.ts`.
4. `agent.ts` opens the Inworld Realtime socket, configures the session, and bridges audio both ways.
5. Barge-in: while the agent is speaking, caller speech clears Plivo playback and cancels the Inworld response.

## Project structure

```
s2s-pipeline/
├── inbound/
│   ├── agent.ts          # pipeline orchestration + call state machine (Inworld S2S)
│   ├── server.ts         # telephony + Plivo provisioning: /answer /ws /hangup /fallback
│   └── system_prompt.md  # system instructions (override with SYSTEM_PROMPT)
├── utils.ts              # shared helpers (phone normalization)
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

(Layout: `inbound/{agent,server,system_prompt}` + a shared `utils.ts`.)

## Prerequisites

- Node.js 18+
- An [ngrok](https://ngrok.com/) account (free tier works)
- A [Plivo](https://www.plivo.com/) account with a Voice-enabled phone number + Auth ID/Token
- An [Inworld](https://www.inworld.ai/) API key with **Realtime API** scope

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INWORLD_API_KEY` | yes | – | Inworld key with Realtime API scope |
| `PUBLIC_URL` | yes | – | Public HTTPS base URL (your ngrok URL, no trailing slash) |
| `PLIVO_AUTH_ID` | yes | – | Plivo Auth ID |
| `PLIVO_AUTH_TOKEN` | yes | – | Plivo Auth Token |
| `PLIVO_PHONE_NUMBER` | for auto-provision | – | E.164 number to map to this app (e.g. `+14155551234`) |
| `SERVER_PORT` | no | `3000` | HTTP/WS port |
| `DEFAULT_COUNTRY_CODE` | no | `1` | Used to normalize bare local numbers |
| `SYSTEM_PROMPT` | no | `inbound/system_prompt.md` | Override the system instructions |
| `INWORLD_MODEL` | no | `openai/gpt-4.1-mini` | LLM model |
| `INWORLD_VOICE` | no | `Sarah` | TTS voice |
| `INWORLD_TTS_MODEL` | no | `inworld-tts-2` | TTS model |
| `INWORLD_STT_MODEL` | no | `assemblyai/universal-streaming-multilingual` | Input transcription model |

## Run

```bash
# Terminal 1 — public tunnel
ngrok http 3000
# copy the https URL into PUBLIC_URL in .env

# Terminal 2 — server
npm run dev
```

On startup the server **auto-provisions Plivo**: it finds or creates an Application
(`Inworld_S2S_Voice_Agent`) with the `/answer`, `/hangup`, `/fallback` webhooks and maps
`PLIVO_PHONE_NUMBER` to it. Expect:

```
[provision] Mapped +14155551234 → Inworld_S2S_Voice_Agent
[server] Listening on port 3000
[server] Answer webhook: https://<domain>/answer
```

If you'd rather configure manually, leave `PLIVO_PHONE_NUMBER` unset and point your number's
**Answer URL** at `https://<domain>/answer` (POST) in the Plivo console.

Then call the number.

## Endpoints

| Route | Purpose |
|-------|---------|
| `GET /` | Health check |
| `GET/POST /answer` | Returns Plivo XML opening the `/ws` media stream |
| `WS /ws` | Bidirectional μ-law audio; handed to the agent on the `start` event |
| `POST /hangup` | Logs call teardown (Duration, HangupCause) |
| `POST /fallback` | Graceful spoken error if `/answer` fails |

## Audio & message contracts

- Plivo WS: receives `start` / `media` (base64 μ-law) / `stop`; the agent sends `playAudio`
  (`{contentType:"audio/x-mulaw", sampleRate:8000, payload}`, 160-byte/20ms chunks) and `clearAudio`.
- Inworld Realtime (`wss://api.inworld.ai/api/v1/realtime/session`, `Basic` auth): the agent sends
  `session.update`, `input_audio_buffer.append`, `response.create`, `response.cancel`; receives
  `session.created/updated`, `response.output_audio.delta/done`, `response.done`,
  `input_audio_buffer.speech_started`, transcription + `error` events.

## Troubleshooting

- **Audio drops mid-response** — ensure `playAudio` carries `contentType` + `sampleRate` (this client does).
- **Call doesn't connect** — `/answer` must be reachable over HTTPS and `PUBLIC_URL` must match ngrok.
- **Provisioning failed** — check Plivo creds and that `PLIVO_PHONE_NUMBER` is E.164; see `[provision]` logs.
- **No AI response / 403** — the Inworld key must have **Realtime API** scope; server logs show `Inworld HTTP <status>`.

## Barge-in

Barge-in uses Inworld's server-side `speech_started` event, gated on the `agentSpeaking` state so
the agent only stops speaking for genuine interruptions. For finer control you can add a
client-side VAD (e.g. Silero) on the inbound audio.

## License

MIT
