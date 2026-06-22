# Plivo + Inworld Cascaded Pipeline Voice Agent

This example demonstrates how to build a voice agent that connects Plivo phone calls to Inworld using a **cascaded pipeline** approach. Unlike the Realtime API (which bundles everything), this approach uses separate Inworld services for each stage:

1. **STT** (Speech-to-Text) - Transcribes caller audio
2. **Router/LLM** - Generates AI response text
3. **TTS** (Text-to-Speech) - Synthesizes response audio

## When to Use Cascaded vs Realtime

| Aspect | Cascaded Pipeline | Realtime API |
|--------|-------------------|--------------|
| **Complexity** | More code, more control | Simple, one WebSocket |
| **Latency** | Higher (3 API calls) | Lower (optimized) |
| **Customization** | Mix different providers | Inworld only |
| **Observability** | Log each stage separately | Single pipeline |
| **Cost** | Pay per service | Single pricing |

**Use Cascaded when you need:**
- Custom STT provider (e.g., your own model)
- Detailed logging per stage
- Different LLM for different scenarios
- Custom audio processing between stages

## Architecture

```
┌──────────┐     ┌──────────┐     ┌─────────────────────────────────────────────┐
│  Caller  │────▶│  Plivo   │────▶│              Your Server                    │
│ (Phone)  │◀────│  (PSTN)  │◀────│                                             │
└──────────┘     └──────────┘     │  ┌─────────┐   ┌─────────┐   ┌─────────┐   │
                                  │  │   STT   │──▶│ Router  │──▶│   TTS   │   │
                                  │  │ (Audio  │   │  (LLM)  │   │ (Text   │   │
                                  │  │ → Text) │   │         │   │ → Audio)│   │
                                  │  └─────────┘   └─────────┘   └─────────┘   │
                                  └─────────────────────────────────────────────┘
                                            All Inworld Services
```

### Pipeline Flow

1. **Inbound Call**: Caller dials your Plivo number
2. **Audio Stream**: Plivo streams audio to your server via WebSocket
3. **STT**: Server buffers audio and sends to Inworld STT API for transcription
4. **LLM**: Transcript is sent to Inworld Router API for response generation
5. **TTS**: Response text is sent to Inworld TTS API for audio synthesis
6. **Playback**: Synthesized audio streams back to caller via Plivo

### Key Features

- **Modular Pipeline**: Each stage is independent and can be customized
- **Streaming TTS**: Audio plays back as it's generated (sentence by sentence)
- **Conversation History**: Full context maintained across turns
- **Barge-in Support**: Cancel in-flight responses when caller interrupts

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18+** installed ([download](https://nodejs.org/))
- **ngrok account** for exposing your local server ([sign up](https://ngrok.com/))
- **Plivo account** with a Voice-enabled phone number ([sign up](https://www.plivo.com/))
- **Inworld account** with API access ([sign up](https://www.inworld.ai/))

## Setup Instructions

### 1. Get Your Inworld API Key

1. Sign up or log in at [inworld.ai](https://www.inworld.ai/)
2. Navigate to your workspace
3. Go to **API Keys** and create a new key
4. Ensure the key has access to: **STT**, **Router**, and **TTS** APIs
5. Copy the API key

### 2. Get Your Plivo Credentials

1. Sign up or log in at [console.plivo.com](https://console.plivo.com/)
2. From the Dashboard, copy your **Auth ID** and **Auth Token**
3. Navigate to **Phone Numbers** → **Buy Numbers**
4. Purchase a phone number with **Voice** capability

### 3. Set Up ngrok

1. [Download and install ngrok](https://ngrok.com/download)
2. Sign up for a free account
3. Reserve a static domain in the [ngrok dashboard](https://dashboard.ngrok.com/domains)

### 4. Configure Environment Variables

```bash
cd integrations/plivo/cascaded
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

## Project Structure

```
cascaded/
├── src/
│   ├── index.ts              # Express server + WebSocket setup
│   ├── config.ts             # Environment variable handling
│   ├── server/
│   │   └── xml.ts            # Plivo XML webhook response
│   └── pipeline/
│       ├── call-handler.ts   # Orchestrates the cascaded pipeline
│       ├── inworld-stt.ts    # Inworld Speech-to-Text client
│       ├── inworld-llm.ts    # Inworld Router/LLM client
│       └── inworld-tts.ts    # Inworld Text-to-Speech client
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Configuration Options

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INWORLD_API_KEY` | Yes | - | Your Inworld API key |
| `SERVER_URL` | Yes | - | Your public URL (ngrok domain) |
| `PLIVO_AUTH_ID` | Yes | - | Plivo Auth ID |
| `PLIVO_AUTH_TOKEN` | Yes | - | Plivo Auth Token |
| `PORT` | No | `3000` | Server port |
| `SYSTEM_PROMPT` | No | Generic assistant | Instructions for the AI |
| `TTS_VOICE` | No | `Sarah` | Inworld TTS voice |
| `TTS_MODEL` | No | `inworld-tts-2` | Inworld TTS model |
| `INWORLD_MODEL` | No | `openai/gpt-4.1-mini` | LLM model for Router API |

## Inworld Services Used

### 1. Speech-to-Text (STT)

Converts caller audio to text transcripts.

```typescript
// WebSocket: wss://api.inworld.ai/v1/stt/stream
// Input: Audio chunks (base64 μ-law)
// Output: Transcript text with timing
```

### 2. Router/LLM API

Generates AI responses using the configured LLM.

```typescript
// POST https://api.inworld.ai/v1/chat/completions
// Input: Conversation history + system prompt
// Output: Streaming text response
```

### 3. Text-to-Speech (TTS)

Synthesizes speech from text.

```typescript
// POST https://api.inworld.ai/v1/tts
// Input: Text + voice config
// Output: Audio data (PCM/μ-law)
```

## Customization

### Using Different STT Settings

Edit `src/pipeline/inworld-stt.ts`:

```typescript
const config = {
  model: "assemblyai/universal-streaming-multilingual",
  language: "en",
  // Add custom settings
};
```

### Using Different LLM Models

Set `INWORLD_MODEL` in `.env`:

```env
INWORLD_MODEL=openai/gpt-4.1
```

Or modify `src/pipeline/inworld-llm.ts` for dynamic model selection.

### Using Different TTS Voices

Set in `.env`:

```env
TTS_VOICE=Clive
TTS_MODEL=inworld-tts-2
```

Available voices depend on your Inworld subscription.

## Troubleshooting

### High Latency

- The cascaded approach has inherent latency (3 sequential API calls)
- Consider the `realtime/` example for lower latency
- Enable streaming TTS to play audio as it generates

### STT Not Transcribing

- Ensure audio is in correct format (μ-law 8kHz)
- Check that audio chunks are being buffered correctly
- Verify STT API access in your Inworld key

### TTS Audio Quality Issues

- Verify TTS output format matches Plivo expectations
- Check for sample rate mismatches (should be 8kHz for Plivo)

## API Reference

### Inworld STT WebSocket

**Connection:**
```
wss://api.inworld.ai/v1/stt/stream
Headers: Authorization: Basic <api-key>
```

**Send Audio:**
```json
{ "audio": "<base64-audio>" }
```

**Receive Transcript:**
```json
{ "transcript": "Hello world", "is_final": true }
```

### Inworld Router API

**Request:**
```bash
POST https://api.inworld.ai/v1/chat/completions
Authorization: Basic <api-key>
Content-Type: application/json

{
  "model": "openai/gpt-4.1-mini",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": true
}
```

### Inworld TTS API

**Request:**
```bash
POST https://api.inworld.ai/v1/tts
Authorization: Basic <api-key>
Content-Type: application/json

{
  "text": "Hello, how can I help you?",
  "voice": "Sarah",
  "model": "inworld-tts-2",
  "output_format": "mulaw_8000"
}
```

## License

MIT

## Resources

- [Inworld STT Documentation](https://docs.inworld.ai/stt/overview)
- [Inworld Router API Documentation](https://docs.inworld.ai/router/overview)
- [Inworld TTS Documentation](https://docs.inworld.ai/tts/overview)
- [Plivo Audio Streaming](https://www.plivo.com/docs/voice/xml/stream/)
