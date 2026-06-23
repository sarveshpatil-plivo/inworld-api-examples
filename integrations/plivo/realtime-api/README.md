# Plivo + Inworld Realtime API Voice Agent

This example demonstrates how to build a voice agent that connects Plivo phone calls to the [Inworld Realtime API](https://docs.inworld.ai/realtime/overview). The Realtime API provides a complete speech-to-speech solution where a single WebSocket connection handles STT (speech-to-text), LLM inference, and TTS (text-to-speech).

## Architecture

```
┌──────────┐     ┌──────────┐     ┌─────────────────┐     ┌─────────────────────┐
│  Caller  │────▶│  Plivo   │────▶│   Your Server   │────▶│ Inworld Realtime API│
│ (Phone)  │◀────│  (PSTN)  │◀────│   (WebSocket)   │◀────│  (STT + LLM + TTS)  │
└──────────┘     └──────────┘     └─────────────────┘     └─────────────────────┘
                   G.711 μ-law 8kHz (passthrough, no transcoding)
```

### How It Works

1. **Inbound Call**: A caller dials your Plivo phone number
2. **Webhook Trigger**: Plivo sends a POST request to your `/voice` endpoint
3. **XML Response**: Your server returns Plivo XML with `<Stream bidirectional="true">` pointing to your WebSocket
4. **Audio Streaming**: Plivo opens a bidirectional WebSocket, streaming caller audio to your server
5. **Inworld Connection**: Your server forwards audio to the Inworld Realtime API
6. **AI Processing**: Inworld transcribes speech, generates a response via LLM, and synthesizes speech
7. **Response Playback**: Audio streams back through your server to Plivo, and the caller hears the response

### Key Features

- **Single WebSocket**: One connection to Inworld handles the entire voice pipeline
- **No Transcoding**: Both Plivo and Inworld use G.711 μ-law at 8kHz
- **Barge-in Support**: Caller can interrupt the AI mid-response
- **Low Latency**: Optimized for real-time conversation

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18+** installed ([download](https://nodejs.org/))
- **ngrok account** for exposing your local server ([sign up](https://ngrok.com/))
- **Plivo account** with a Voice-enabled phone number ([sign up](https://www.plivo.com/))
- **Inworld account** with a Realtime API key ([sign up](https://www.inworld.ai/))

## Setup Instructions

### 1. Get Your Inworld API Key

1. Sign up or log in at [inworld.ai](https://www.inworld.ai/)
2. Navigate to your workspace
3. Go to **API Keys** and create a new key with **Realtime API** access
4. Copy the API key (you'll need it for the `.env` file)

### 2. Get Your Plivo Credentials

1. Sign up or log in at [console.plivo.com](https://console.plivo.com/)
2. From the Dashboard, copy your **Auth ID** and **Auth Token**
3. Navigate to **Phone Numbers** → **Buy Numbers**
4. Purchase a phone number with **Voice** capability

### 3. Set Up ngrok

ngrok creates a public URL that tunnels to your local server.

1. [Download and install ngrok](https://ngrok.com/download)
2. Sign up for a free account at [ngrok.com](https://ngrok.com/)
3. Reserve a free static domain in the [ngrok dashboard](https://dashboard.ngrok.com/domains) (recommended for stable webhooks)

### 4. Configure Environment Variables

```bash
cd integrations/plivo/realtime-api
cp .env.example .env
```

Edit `.env` with your credentials:

```
INWORLD_API_KEY=<your-inworld-api-key>
SERVER_URL=<https://your-domain.ngrok-free.app>
PLIVO_AUTH_ID=<your-plivo-auth-id>
PLIVO_AUTH_TOKEN=<your-plivo-auth-token>
```

### 5. Install Dependencies

```bash
npm install
```

### 6. Configure Plivo Webhook

1. Go to [Plivo Console](https://console.plivo.com/) → **Phone Numbers** → **Your Number**
2. Under **Voice Configuration**:
   - Set **Answer URL** to: `https://your-domain.ngrok-free.app/voice`
   - Set **Method** to: `POST`
3. Click **Save**

## Running the Application

Open two terminal windows:

**Terminal 1 - Start ngrok:**
```bash
ngrok http 3000 --url=your-domain.ngrok-free.app
```

**Terminal 2 - Start the server:**
```bash
npm run dev
```

You should see:
```
[server] Listening on port 3000
[server] Voice webhook: https://your-domain.ngrok-free.app/voice
```

## Testing

1. Call your Plivo phone number from any phone
2. Wait for the AI to greet you
3. Have a conversation!
4. Try interrupting the AI mid-sentence (barge-in)

## Project Structure

```
realtime-api/
├── src/
│   ├── index.ts              # Express server + WebSocket setup
│   ├── config.ts             # Environment variable handling
│   ├── server/
│   │   └── xml.ts            # Plivo XML webhook response
│   └── voice/
│       ├── call-handler.ts   # Bridges Plivo ↔ Inworld WebSockets
│       └── inworld-realtime.ts # Inworld Realtime API client
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Configuration Options

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INWORLD_API_KEY` | Yes | - | Your Inworld API key with Realtime API access |
| `SERVER_URL` | Yes | - | Your public URL (ngrok domain) |
| `PLIVO_AUTH_ID` | Yes | - | Plivo Auth ID from console |
| `PLIVO_AUTH_TOKEN` | Yes | - | Plivo Auth Token from console |
| `PORT` | No | `3000` | Port for the HTTP/WebSocket server |
| `SYSTEM_PROMPT` | No | Generic assistant | Instructions for the AI personality |

## Customizing the AI

### Change the System Prompt

Set `SYSTEM_PROMPT` in your `.env` file:

```env
SYSTEM_PROMPT="You are a friendly customer service agent for Acme Corp. Be helpful, concise, and professional."
```

### Change the Voice

Edit `src/voice/inworld-realtime.ts` and modify the `voice` parameter in the session config:

```typescript
output: {
  format: "g711_ulaw",
  model: "inworld-tts-2",
  voice: "Sarah",  // Change to another Inworld voice
},
```

### Change the LLM Model

Edit the `model` parameter in the session config:

```typescript
session: {
  type: "realtime",
  model: "openai/gpt-4.1-mini",  // Change to another model
  // ...
}
```

## Troubleshooting

### No Audio / One-Way Audio

- Verify your Plivo Answer URL is correct and uses HTTPS
- Check that ngrok is running and the domain matches your `.env`
- Ensure your Plivo number has Voice capability enabled

### Connection Errors

- Verify your Inworld API key has Realtime API access
- Check the server logs for specific error messages
- Ensure your firewall allows WebSocket connections

### High Latency

- Use a server geographically close to your users
- Check your internet connection stability
- Monitor Inworld's status page for any service issues

### Barge-in Not Working

- Ensure `interrupt_response: true` is set in the turn detection config
- Check that the `clearAudio` event is being sent to Plivo

## API Reference

### Plivo XML Response

When a call comes in, the server responds with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://your-domain.ngrok-free.app/media-stream
  </Stream>
</Response>
```

### Plivo WebSocket Messages

**Incoming from Plivo:**
- `start` - Stream initialization with call metadata
- `media` - Audio frames (base64-encoded μ-law)
- `stop` - Call ended

**Outgoing to Plivo:**
- `playAudio` - Send audio to caller
- `clearAudio` - Clear audio buffer (for barge-in)

### Inworld Realtime Messages

**Outgoing to Inworld:**
- `session.update` - Configure the session
- `input_audio_buffer.append` - Send audio
- `response.cancel` - Cancel current response (barge-in)

**Incoming from Inworld:**
- `session.created` - Session ready
- `response.output_audio.delta` - Audio chunk
- `input_audio_buffer.speech_started` - User started speaking

## License

MIT

## Resources

- [Inworld Realtime API Documentation](https://docs.inworld.ai/realtime/overview)
- [Inworld Realtime WebSocket Reference](https://docs.inworld.ai/realtime/websocket)
- [Plivo Audio Streaming Documentation](https://www.plivo.com/docs/voice/xml/stream/)
- [Plivo XML Reference](https://www.plivo.com/docs/voice/xml/)
