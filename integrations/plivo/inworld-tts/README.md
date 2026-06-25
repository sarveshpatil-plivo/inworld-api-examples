# Plivo + Inworld TTS Voice Agent

This guide shows how to use **Inworld's Text-to-Speech** inside a complete phone voice agent on Plivo. It's a full speech-to-speech pipeline where Inworld powers the voice, and the other two stages use different providers so you can see how to drop Inworld TTS into an existing voice stack:

- **STT** — Deepgram (`nova-2-phonecall`)
- **LLM** — Google Gemini (`gemini-2.0-flash`)
- **TTS** — **Inworld TTS** (`tts/v1/voice:stream`)

```
Caller ↔ Plivo ↔ Server ↔ Deepgram STT → Gemini LLM → Inworld TTS
         μ-law 8kHz
```

## Prerequisites

Before getting started, make sure you have:

- A **Plivo account** with a Voice phone number, plus your Auth ID and Auth Token from the [console](https://console.plivo.com/dashboard/).
- An **Inworld API key** with TTS access, from your [Inworld workspace](https://www.inworld.ai/).
- A **Deepgram API key** ([console.deepgram.com](https://console.deepgram.com/)).
- A **Google Gemini API key** ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
- **Node.js 18+** and **ngrok** ([download](https://ngrok.com/)).

## Plivo Setup

When a call comes in, Plivo opens a bidirectional audio stream via XML generated automatically by `/answer`:

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

Fill in `INWORLD_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, `PUBLIC_URL`, and the Plivo credentials (see [Configuration](#configuration)).

### 3. Start the server, then ngrok

```bash
npm run dev
```
```bash
ngrok http 3000
```

The server logs `[provision] Mapped +… → Inworld_TTS_Voice_Agent` and `[server] Listening on port 3000`.

## Placing a Test Call

Call your Plivo number. The agent greets you (in an **Inworld** voice), transcribes your speech with Deepgram, generates a reply with Gemini, speaks it with **Inworld TTS** — and you can talk over it to interrupt.

## How It Works

```
                              +-----------------------------------+
Phone Call  <-->  Plivo       |            This Server            |
                  μ-law 8kHz <-+-> WebSocket /ws                  |
                              |     ├─► Deepgram STT  (WebSocket)  |  speech → text
                              |     ├─► Gemini LLM    (HTTP, SSE)  |  text → reply
                              |     └─► Inworld TTS   (HTTP)       |  reply → audio
                              +-----------------------------------+
```

- **Deepgram** — caller μ-law is decoded to LINEAR16 PCM and streamed to Deepgram; final transcripts drive each turn.
- **Gemini** — each transcript is sent with the full history; the reply streams token by token.
- **Inworld TTS** — each sentence is synthesized via `tts/v1/voice:stream` (PCM), resampled to 8k, encoded to μ-law, and streamed to Plivo.
- **Barge-in** — gated on whether the agent is speaking; caller speech aborts the in-flight reply and clears playback.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `INWORLD_API_KEY` | Yes | -- | Inworld API key with TTS access |
| `DEEPGRAM_API_KEY` | Yes | -- | Deepgram API key (STT) |
| `GEMINI_API_KEY` | Yes | -- | Google Gemini API key (LLM) |
| `PUBLIC_URL` | Yes | -- | Public HTTPS URL of this server (no trailing slash) |
| `PLIVO_AUTH_ID` / `PLIVO_AUTH_TOKEN` | Yes | -- | Plivo credentials |
| `PLIVO_PHONE_NUMBER` | For auto-provisioning | -- | E.164 number to map to this app |
| `SERVER_PORT` | No | `3000` | Port the server listens on |
| `DEEPGRAM_MODEL` | No | `nova-2-phonecall` | Deepgram STT model |
| `GEMINI_MODEL` | No | `gemini-2.0-flash` | Gemini model |
| `INWORLD_TTS_MODEL` | No | `inworld-tts-2` | Inworld TTS model |
| `INWORLD_VOICE` | No | `Sarah` | Inworld TTS voice |
| `TTS_SAMPLE_RATE` | No | `8000` | PCM rate requested from Inworld TTS (resampled to 8k) |

## Further Reading and Troubleshooting

- [Inworld TTS Documentation](https://docs.inworld.ai/tts/overview) — voices and models.
- [Deepgram Streaming STT](https://developers.deepgram.com/docs/streaming) — live transcription.
- [Gemini API](https://ai.google.dev/gemini-api/docs) — generateContent and streaming.
- [Plivo Audio Streaming](https://www.plivo.com/docs/voice/xml/stream/) — the `<Stream>` element.

Common issues: no transcription → Deepgram key/model (`[stt]` logs); no reply → Gemini key/model; garbled or no audio out → the Inworld key's TTS access or a sample-rate mismatch (`[tts]` logs; adjust `TTS_SAMPLE_RATE`).
