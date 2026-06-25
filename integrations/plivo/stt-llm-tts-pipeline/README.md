# Plivo + Inworld Cascaded Voice (STT → LLM → TTS)

This guide explains how to power phone calls with Inworld using a **cascaded pipeline** — three separate Inworld services wired in sequence: Speech-to-Text, the Router/LLM, and Text-to-Speech. Compared to the single-socket [Realtime pipeline](../s2s-pipeline/), this approach lets you swap or observe each stage independently, at the cost of more moving parts and higher latency.

## Prerequisites

Before getting started, make sure you have:

- A **Plivo account** with a phone number configured for Voice, plus your Auth ID and Auth Token from the [Plivo console](https://console.plivo.com/dashboard/).
- An **Inworld API key** from your [Inworld workspace](https://www.inworld.ai/), with access to the **STT, Router, and TTS** APIs.
- **Node.js 18+** installed.
- **ngrok** installed for local development ([download here](https://ngrok.com/)).
- Your public HTTPS URL ready for use (ngrok provides this when tunneling).

## Plivo Setup

When a call comes in, Plivo needs XML instructions to open a bidirectional audio stream to this server. The XML looks like this:

```xml
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">
    wss://your-ngrok-domain.ngrok-free.app/ws
  </Stream>
</Response>
```

This integration generates that XML automatically via the `/answer` webhook, so you do not need to write it by hand. It also **auto-configures Plivo on startup**: when the server boots with `PLIVO_PHONE_NUMBER` and `PUBLIC_URL` set, it creates (or updates) a Plivo Application pointing at this server's `/answer`, `/hangup`, and `/fallback` webhooks and maps your number to it.

### Assigning the number manually (optional)

If you'd rather not use auto-provisioning, leave `PLIVO_PHONE_NUMBER` unset and wire the number yourself:

1. Go to the [Plivo Console](https://console.plivo.com/) and navigate to **Phone Numbers** > **Your Number**.
2. Under **Voice Configuration**, set the **Answer URL** to `https://your-ngrok-domain.ngrok-free.app/answer`.
3. Set the method to **HTTP POST**.
4. Save.

## Running the Server

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with your credentials (see the [Configuration](#configuration) table below for all options):

```
INWORLD_API_KEY=your-inworld-api-key
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
[provision] Mapped +14155551234 → Inworld_STT_LLM_TTS_Voice_Agent
[server] Listening on port 3000
[server] Answer webhook: https://your-ngrok-domain.ngrok-free.app/answer
```

## Placing a Test Call

Call your Plivo phone number from any phone. The assistant should pick up, speak a greeting, transcribe what you say, and respond in real time — and you can talk over it to interrupt.

## How It Works

```
                              +-----------------------------------+
Phone Call  <-->  Plivo       |            This Server            |
                  (Voice)     |                                   |
                  μ-law 8kHz <-+-> WebSocket /ws                  |
                              |     │                             |
                              |     ├─► Inworld STT  (WebSocket)   |  speech → text
                              |     ├─► Inworld Router/LLM (HTTP)  |  text → reply
                              |     └─► Inworld TTS  (HTTP)        |  reply → audio
                              +-----------------------------------+
```

The server bridges Plivo's μ-law audio stream to three Inworld services. Caller audio is decoded to PCM and streamed to STT; final transcripts drive a turn through the Router/LLM; and each sentence of the reply is synthesized by TTS, converted back to μ-law, and streamed to the caller.

### Streaming for Low Latency

The LLM response is streamed token by token. As each sentence completes, the server sends it to TTS immediately and begins playing the audio — so the caller hears the first sentence before the rest of the response has been generated.

### Interruption Handling

When the caller speaks while the agent is talking, the server aborts the in-flight LLM and TTS work using an `AbortController` and clears Plivo's playback buffer, so the agent stops promptly. Barge-in is gated on whether the agent is actually speaking, so the agent never cuts itself off.

### Multi-Turn Conversations

The server keeps the full conversation history (system prompt plus all user and assistant turns) per call, so each new request is sent to the LLM with complete context for coherent multi-turn dialogue.

### Audio Pipeline

1. Plivo streams base64-encoded μ-law audio at 8kHz.
2. The server decodes μ-law to LINEAR16 PCM and streams it to Inworld STT.
3. STT returns transcripts; a brief silence window marks end-of-utterance.
4. The transcript goes to the Router/LLM, which streams the reply.
5. Each sentence is synthesized by Inworld TTS (PCM), resampled if needed, and encoded back to μ-law.
6. The μ-law audio is sent to Plivo in 20ms (160-byte) `playAudio` frames.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `INWORLD_API_KEY` | Yes | -- | Inworld API key with STT, Router, and TTS access |
| `PUBLIC_URL` | Yes | -- | Public HTTPS URL of this server (e.g., your ngrok domain), no trailing slash |
| `PLIVO_AUTH_ID` | Yes | -- | Plivo Auth ID |
| `PLIVO_AUTH_TOKEN` | Yes | -- | Plivo Auth Token |
| `PLIVO_PHONE_NUMBER` | For auto-provisioning | -- | E.164 number to map to this app (e.g., `+14155551234`) |
| `SERVER_PORT` | No | `3000` | Port the HTTP/WebSocket server listens on |
| `SYSTEM_PROMPT` | No | `inbound/system_prompt.md` | System instructions sent to the LLM |
| `INWORLD_MODEL` | No | `openai/gpt-4.1-mini` | Router/LLM model |
| `INWORLD_STT_MODEL` | No | `inworld/inworld-stt-1` | STT model |
| `INWORLD_TTS_MODEL` | No | `inworld-tts-2` | TTS model |
| `INWORLD_VOICE` | No | `Sarah` | TTS voice |

## Further Reading and Troubleshooting

- [Inworld STT Documentation](https://docs.inworld.ai/stt/overview) — streaming transcription.
- [Inworld Router/LLM Documentation](https://docs.inworld.ai) — model routing and chat completions.
- [Inworld TTS Documentation](https://docs.inworld.ai/tts/overview) — voices and models.
- [Plivo Audio Streaming](https://www.plivo.com/docs/voice/xml/stream/) — the bidirectional `<Stream>` element.

Common issues: no transcription usually means the key lacks STT access (check the `[stt]` logs); no reply after a transcript points to Router access or `INWORLD_MODEL`; garbled audio is a sample-rate mismatch (check the `[tts]` logs); and high latency is inherent to the cascaded approach — the [Realtime pipeline](../s2s-pipeline/) is lower-latency.
