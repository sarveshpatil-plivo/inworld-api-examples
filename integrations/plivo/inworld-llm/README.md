# Plivo + Inworld LLM Voice Agent

This guide shows how to use **Inworld's LLM (Router)** inside a complete phone voice agent on Plivo. It's a full speech-to-speech pipeline where Inworld powers the language model, and the other two stages use different providers so you can see exactly how to drop Inworld's LLM into an existing voice stack:

- **STT** — Deepgram (`nova-2-phonecall`)
- **LLM** — **Inworld Router** (`/v1/chat/completions`)
- **TTS** — ElevenLabs (`eleven_flash_v2_5`)

```
Caller ↔ Plivo ↔ Server ↔ Deepgram STT → Inworld LLM → ElevenLabs TTS
         μ-law 8kHz
```

## Prerequisites

Before getting started, make sure you have:

- A **Plivo account** with a Voice phone number, plus your Auth ID and Auth Token from the [console](https://console.plivo.com/dashboard/).
- An **Inworld API key** with Router/LLM access, from your [Inworld workspace](https://www.inworld.ai/).
- A **Deepgram API key** ([console.deepgram.com](https://console.deepgram.com/)) for speech-to-text.
- An **ElevenLabs API key** ([elevenlabs.io](https://elevenlabs.io/)) for text-to-speech.
- **Node.js 18+** and **ngrok** ([download](https://ngrok.com/)).

## Plivo Setup

When a call comes in, Plivo needs XML telling it to open a bidirectional audio stream to this server:

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://your-ngrok-domain.ngrok-free.app/ws
  </Stream>
</Response>
```

This integration generates that XML automatically via `/answer`, and **auto-configures Plivo on startup**: with `PLIVO_PHONE_NUMBER` and `PUBLIC_URL` set, the server creates (or updates) a Plivo Application pointing at its `/answer`, `/hangup`, and `/fallback` webhooks and maps your number to it.

### Assigning the number manually (optional)

Leave `PLIVO_PHONE_NUMBER` unset and, in the [Plivo Console](https://console.plivo.com/) → **Phone Numbers** → your number, set the **Answer URL** to `https://your-ngrok-domain.ngrok-free.app/answer` (HTTP POST).

## Running the Server

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your credentials (see [Configuration](#configuration) for all options):

```
INWORLD_API_KEY=your-inworld-api-key
DEEPGRAM_API_KEY=your-deepgram-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key
PUBLIC_URL=https://your-ngrok-domain.ngrok-free.app
PLIVO_AUTH_ID=your-plivo-auth-id
PLIVO_AUTH_TOKEN=your-plivo-auth-token
PLIVO_PHONE_NUMBER=+14155551234
```

### 3. Start the development server

```bash
npm run dev
```

### 4. Start ngrok (in a separate terminal)

```bash
ngrok http 3000
```

The server will log:

```
[provision] Mapped +14155551234 → Inworld_LLM_Voice_Agent
[server] Listening on port 3000
[server] Answer webhook: https://your-ngrok-domain.ngrok-free.app/answer
```

## Placing a Test Call

Call your Plivo phone number. The assistant greets you, transcribes your speech with Deepgram, generates a reply with Inworld's LLM, speaks it with ElevenLabs — and you can talk over it to interrupt.

## How It Works

```
                              +-----------------------------------+
Phone Call  <-->  Plivo       |            This Server            |
                  (Voice)     |                                   |
                  μ-law 8kHz <-+-> WebSocket /ws                  |
                              |     ├─► Deepgram STT  (WebSocket)  |  speech → text
                              |     ├─► Inworld LLM   (HTTP, SSE)  |  text → reply
                              |     └─► ElevenLabs TTS (HTTP)      |  reply → audio
                              +-----------------------------------+
```

### Speech-to-Text (Deepgram)

Caller μ-law audio is decoded to LINEAR16 PCM and streamed to Deepgram over a WebSocket (`encoding=linear16`, `sample_rate=8000`). Finalized transcripts drive each turn.

### Language Model (Inworld Router)

Each transcript is sent to Inworld's Router (`/v1/chat/completions`, streaming) with the full conversation history, so replies are coherent across turns. The reply streams token by token.

### Text-to-Speech (ElevenLabs)

Each sentence of the reply is synthesized by ElevenLabs with `output_format=ulaw_8000` — μ-law at 8kHz, exactly what Plivo plays — so it streams straight back to the caller with no conversion.

### Interruption Handling

Barge-in is gated on whether the agent is actually speaking: when the caller speaks over the agent, the in-flight LLM/TTS work is aborted and Plivo's playback buffer is cleared.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `INWORLD_API_KEY` | Yes | -- | Inworld API key with Router/LLM access |
| `DEEPGRAM_API_KEY` | Yes | -- | Deepgram API key (STT) |
| `ELEVENLABS_API_KEY` | Yes | -- | ElevenLabs API key (TTS) |
| `PUBLIC_URL` | Yes | -- | Public HTTPS URL of this server (no trailing slash) |
| `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` | Yes | -- | Plivo credentials |
| `PLIVO_PHONE_NUMBER` | For auto-provisioning | -- | E.164 number to map to this app |
| `SERVER_PORT` | No | `3000` | Port the server listens on |
| `INWORLD_MODEL` | No | `openai/gpt-4.1-mini` | Inworld Router/LLM model |
| `DEEPGRAM_MODEL` | No | `nova-2-phonecall` | Deepgram STT model |
| `ELEVENLABS_VOICE_ID` | No | `21m00Tcm4TlvDq8ikWAM` | ElevenLabs voice |
| `ELEVENLABS_MODEL` | No | `eleven_flash_v2_5` | ElevenLabs model |

## Further Reading and Troubleshooting

- [Inworld Router / LLM Documentation](https://docs.inworld.ai) — chat completions and model routing.
- [Deepgram Streaming STT](https://developers.deepgram.com/docs/streaming) — live transcription.
- [ElevenLabs Text-to-Speech](https://elevenlabs.io/docs) — voices, models, and the `ulaw_8000` telephony output.
- [Plivo Audio Streaming](https://www.plivo.com/docs/voice/xml/stream/) — the bidirectional `<Stream>` element.

Common issues: no transcription usually means the Deepgram key or model (check `[stt]` logs); no reply after a transcript points to the Inworld key's Router access or `INWORLD_MODEL`; no audio out points to the ElevenLabs key or voice id (check `[tts]` logs).
