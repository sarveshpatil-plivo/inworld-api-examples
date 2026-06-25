# Plivo + Inworld STT Voice Agent

This guide shows how to use **Inworld's Speech-to-Text** inside a complete phone voice agent on Plivo. It's a full speech-to-speech pipeline where Inworld powers transcription, and the other two stages use different providers so you can see how to drop Inworld STT into an existing voice stack:

- **STT** — **Inworld STT** (`stt/v1/transcribe:streamBidirectional`)
- **LLM** — Google Gemini (`gemini-2.0-flash`)
- **TTS** — ElevenLabs (`eleven_flash_v2_5`)

```
Caller ↔ Plivo ↔ Server ↔ Inworld STT → Gemini LLM → ElevenLabs TTS
         μ-law 8kHz
```

## Prerequisites

Before getting started, make sure you have:

- A **Plivo account** with a Voice phone number, plus your Auth ID and Auth Token from the [console](https://console.plivo.com/dashboard/).
- An **Inworld API key** with STT access, from your [Inworld workspace](https://www.inworld.ai/).
- A **Google Gemini API key** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
- An **ElevenLabs API key** ([elevenlabs.io](https://elevenlabs.io/)).
- **Node.js 18+** and **ngrok** ([download](https://ngrok.com/)).

## Plivo Setup

When a call comes in, Plivo opens a bidirectional audio stream to this server via XML generated automatically by `/answer`:

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://your-ngrok-domain.ngrok-free.app/ws
  </Stream>
</Response>
```

The server also **auto-configures Plivo on startup** (creates/updates a Plivo Application and maps `PLIVO_PHONE_NUMBER` to it). To wire the number manually instead, leave `PLIVO_PHONE_NUMBER` unset and set its Answer URL to `https://your-ngrok-domain.ngrok-free.app/answer` (HTTP POST).

## Running the Server

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in `INWORLD_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `PUBLIC_URL`, and the Plivo credentials (see [Configuration](#configuration)).

### 3. Start the server, then ngrok

```bash
npm run dev
```
```bash
ngrok http 3000
```

The server logs `[provision] Mapped +… → Inworld_STT_Voice_Agent` and `[server] Listening on port 3000`.

## Placing a Test Call

Call your Plivo number. The agent greets you, transcribes your speech with **Inworld STT**, generates a reply with Gemini, speaks it with ElevenLabs — and you can talk over it to interrupt.

## How It Works

```
                              +-----------------------------------+
Phone Call  <-->  Plivo       |            This Server            |
                  μ-law 8kHz <-+-> WebSocket /ws                  |
                              |     ├─► Inworld STT  (WebSocket)   |  speech → text
                              |     ├─► Gemini LLM   (HTTP, SSE)   |  text → reply
                              |     └─► ElevenLabs TTS (HTTP)      |  reply → audio
                              +-----------------------------------+
```

- **Inworld STT** — caller μ-law is decoded to LINEAR16 PCM and streamed to `stt/v1/transcribe:streamBidirectional`; final transcripts drive each turn.
- **Gemini** — each transcript is sent with the full conversation history; the reply streams token by token.
- **ElevenLabs** — each sentence is synthesized as `ulaw_8000` and streamed straight to Plivo.
- **Barge-in** — gated on whether the agent is speaking; caller speech aborts the in-flight reply and clears playback.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `INWORLD_API_KEY` | Yes | -- | Inworld API key with STT access |
| `GEMINI_API_KEY` | Yes | -- | Google Gemini API key (LLM) |
| `ELEVENLABS_API_KEY` | Yes | -- | ElevenLabs API key (TTS) |
| `PUBLIC_URL` | Yes | -- | Public HTTPS URL of this server (no trailing slash) |
| `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` | Yes | -- | Plivo credentials |
| `PLIVO_PHONE_NUMBER` | For auto-provisioning | -- | E.164 number to map to this app |
| `SERVER_PORT` | No | `3000` | Port the server listens on |
| `INWORLD_STT_MODEL` | No | `inworld/inworld-stt-1` | Inworld STT model |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | Gemini model |
| `ELEVENLABS_VOICE_ID` | No | `21m00Tcm4TlvDq8ikWAM` | ElevenLabs voice |
| `ELEVENLABS_MODEL` | No | `eleven_flash_v2_5` | ElevenLabs model |

## Further Reading and Troubleshooting

- [Inworld STT Documentation](https://docs.inworld.ai/stt/overview) — streaming transcription.
- [Gemini API](https://ai.google.dev/gemini-api/docs) — generateContent and streaming.
- [ElevenLabs TTS](https://elevenlabs.io/docs) — voices, models, and `ulaw_8000` telephony output.
- [Plivo Audio Streaming](https://www.plivo.com/docs/voice/xml/stream/) — the `<Stream>` element.

Common issues: no transcription → the Inworld key's STT access (check `[stt]` logs); no reply → the Gemini key/model; no audio out → the ElevenLabs key/voice (check `[tts]` logs).
