# Plivo + Inworld Realtime Voice Agent

A voice agent that connects phone calls to the [Inworld Realtime API](https://docs.inworld.ai/realtime/overview) for speech-to-speech conversations. One WebSocket to Inworld handles STT + LLM + TTS.

```
Caller <-> Plivo <-> WebSocket <-> Inworld Realtime
             mulaw 8kHz (passthrough)
```

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [ngrok](https://ngrok.com/) account (free tier works)
- [Plivo](https://www.plivo.com/) account with a phone number
- [Inworld](https://www.inworld.ai/) account with a Realtime API key

## Setup

1. **Get your Inworld API key** — sign up at [inworld.ai](https://www.inworld.ai/), go to your workspace, and create an API key for the Realtime API.

2. **Get a Plivo phone number:**
   1. Sign up at [plivo.com](https://www.plivo.com/)
   2. Go to [Phone Numbers](https://console.plivo.com/phone-numbers/search/) and buy a number with Voice capability
   3. Get your Auth ID and Auth Token from the [Dashboard](https://console.plivo.com/dashboard/)

3. **Set up ngrok** — [install ngrok](https://ngrok.com/download), then reserve a free static domain in the [ngrok dashboard](https://dashboard.ngrok.com/domains).

4. **Configure environment:**
   ```bash
   cp .env.example .env
   # Fill in PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, INWORLD_API_KEY, and SERVER_URL
   ```

5. **Install dependencies:**
   ```bash
   npm install
   ```

6. **Configure Plivo webhook:**
   1. Go to [Plivo Console](https://console.plivo.com/) -> Phone Numbers -> Your Number
   2. Under "Voice", set the "Answer URL" to `https://<your-ngrok-domain>/voice`
   3. Set the method to **POST**
   4. Save

## Run

In two terminals:

```bash
# Terminal 1: Start ngrok tunnel
ngrok http 3000 --url=<your-ngrok-domain>
```

```bash
# Terminal 2: Start the server
npm run dev
```

Call your Plivo number — the bot will greet you and you can have a conversation.

## How it works

1. Inbound call hits `/voice` -> returns Plivo XML with `<Stream bidirectional="true">`
2. Plivo opens a Media Stream WebSocket to `/media-stream`
3. Server passes mulaw audio between Plivo and Inworld (no format conversion needed)
4. Barge-in: on speech detection, clears Plivo buffer and cancels Inworld response

## Project Structure

```
src/
  index.ts              # Express + WebSocket server
  config.ts             # Environment variables
  server/
    xml.ts              # POST /voice -> Plivo XML response
  voice/
    call-handler.ts     # Bridges Plivo WS <-> Inworld WS
    inworld-realtime.ts # Inworld Realtime API client
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PLIVO_AUTH_ID` | Yes | - | Plivo Auth ID |
| `PLIVO_AUTH_TOKEN` | Yes | - | Plivo Auth Token |
| `INWORLD_API_KEY` | Yes | - | Inworld API key |
| `SERVER_URL` | Yes | - | Public URL (ngrok domain) |
| `PORT` | No | `3000` | Server port |
| `SYSTEM_PROMPT` | No | Generic assistant | System instructions for the AI |

## Audio Format

Both Plivo and Inworld Realtime API support G.711 mulaw at 8kHz, so audio passes through without any conversion. This keeps latency low and avoids quality loss from transcoding.

## Troubleshooting

- **No audio**: Check that your Plivo number's Answer URL is set correctly and using HTTPS
- **Connection errors**: Ensure ngrok is running and the URL matches your `.env`
- **Inworld errors**: Verify your API key has Realtime API access

## License

MIT
