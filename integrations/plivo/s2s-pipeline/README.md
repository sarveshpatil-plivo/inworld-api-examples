# Plivo Integration

Connect phone calls to the [Inworld Realtime API](https://docs.inworld.ai/realtime/overview) using Plivo audio streaming.

Plivo's `<Stream>` element forwards live call audio to your server over a WebSocket. Because the Realtime API natively accepts G.711 μ-law (`audio/x-mulaw`) at 8 kHz, you can pipe Plivo audio straight through without transcoding. A single Realtime connection handles STT, LLM, and TTS, so the bridge server is mostly glue.

## Prerequisites

- Node.js v18 or later
- ngrok account with a reserved static domain (the free tier is sufficient)
- Plivo account with a phone number that has Voice capability
- Inworld account with a Realtime API key

## Setup

**1. Clone the example repo**

Clone the examples repo and change into the Plivo Realtime integration directory:

```bash
git clone https://github.com/inworld-ai/inworld-api-examples.git
cd inworld-api-examples/integrations/plivo/s2s-pipeline
```

The remaining steps are run from this directory.

**2. Get your Inworld API key**

Sign in to the [Inworld Portal](https://platform.inworld.ai/), open your workspace, and create an API key with Realtime scope.

**3. Get a Plivo phone number**

In the [Plivo Console](https://console.plivo.com/), buy a phone number with Voice capability and copy your Auth ID and Auth Token from the dashboard.

**4. Reserve an ngrok static domain**

Install ngrok and reserve a free static domain in the ngrok dashboard. A static domain matters here because the Plivo webhook URL needs to stay stable between restarts.

**5. Configure environment**

Copy the example env file and fill in the values:

```bash
cp .env.example .env
```

Set these in `.env`:

```bash
INWORLD_API_KEY=your_inworld_api_key
PUBLIC_URL=https://your-ngrok-domain.ngrok-free.app
PLIVO_AUTH_ID=your_plivo_auth_id
PLIVO_AUTH_TOKEN=your_plivo_auth_token
PLIVO_PHONE_NUMBER=+14155551234
```

**6. Install and run**

Install dependencies:

```bash
npm install
```

Then start ngrok and the dev server in two separate terminals:

```bash
ngrok http 3000 --url=your-ngrok-domain.ngrok-free.app
```

```bash
npm run dev
```

**7. Point your Plivo number at the webhook**

On startup the server **auto-configures Plivo** — it creates (or updates) a Plivo Application pointing at this server's webhooks and maps `PLIVO_PHONE_NUMBER` to it, so there's nothing to do in the console. To configure it manually instead, leave `PLIVO_PHONE_NUMBER` unset and, in the Plivo Console under Phone Numbers → your number → Voice, set the **Answer URL** to `https://your-ngrok-domain.ngrok-free.app/answer` with HTTP POST.

> ngrok is only needed for local development so Plivo can reach a server running on your machine.

## How it works

- An inbound call hits `/answer`, and the server responds with Plivo XML instructing Plivo to open a bidirectional audio stream.
- Plivo opens a WebSocket to `/ws` and begins forwarding call audio.
- The server shuttles μ-law 8 kHz frames between Plivo and Inworld in both directions, paced at 20 ms.
- On detected user speech, the server clears Plivo's audio buffer and cancels the in-flight Inworld response so barge-in feels natural.

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://your-ngrok-domain.ngrok-free.app/ws
  </Stream>
</Response>
```

## Test your integration

Call your Plivo number. The bot should greet you and hold a conversation, and you can talk over it to interrupt.

## Example implementation

[**Plivo + Realtime API (s2s-pipeline)**](https://github.com/inworld-ai/inworld-api-examples/tree/main/integrations/plivo/s2s-pipeline) — a complete Node.js reference implementation that bridges Plivo audio streaming to the Realtime API. The pipeline lives in `inbound/agent.ts`, the telephony + Plivo provisioning in `inbound/server.ts`.

## Further reading

- [Realtime WebSocket Protocol Reference](https://docs.inworld.ai/realtime/connect/websocket)
- [Plivo Audio Streaming](https://www.plivo.com/docs/voice/xml/stream/)
