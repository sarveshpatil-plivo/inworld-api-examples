# Plivo + Inworld Realtime API Voice Agent

Single-WebSocket speech-to-speech voice agent. Plivo streams call audio to this server,
which bridges it to the **Inworld Realtime API** (STT + LLM + TTS in one connection) and
streams the response back.

## Commands

```bash
npm install
npm run dev        # tsx watch src/index.ts (starts on PORT, default 3000)
npm run build      # tsc -> dist/
npm start          # node dist/index.js
```

Local testing requires a public tunnel: `ngrok http 3000 --url=<your-domain>`.

## Rules

- NEVER commit `.env` files or API keys.
- NEVER change the audio sample rate from 8kHz — Plivo requires G.711 μ-law @ 8kHz.
- Audio is `g711_ulaw` on BOTH sides, so it passes through with no transcoding. Don't add codecs.
- ALWAYS buffer to ≥400 bytes (50ms of μ-law 8kHz) before sending audio in either direction.
- ALWAYS base64-encode audio payloads on the Plivo WebSocket.
- ALWAYS handle barge-in: clear local buffer → `clearAudio` to Plivo → `response.cancel` to Inworld.

## Audio

μ-law (G.711) 8kHz mono, base64 on the wire. `MIN_CHUNK_BYTES = 400` in `call-handler.ts`.

## Message contracts

**Plivo WebSocket** (`/media-stream`)
- Receive: `start` (streamId/callId/from/to), `media` (base64 μ-law), `stop`
- Send: `playAudio` (base64 audio), `clearAudio` (flush playback on barge-in)

**Inworld Realtime** (`wss://api.inworld.ai/api/v1/realtime/session`, `Authorization: Basic <key>`)
- Send: `session.update`, `input_audio_buffer.append`, `response.cancel`, `conversation.item.create` + `response.create` (greeting)
- Receive: `session.created`, `session.updated`, `response.output_audio.delta`, `response.output_audio.done`, `input_audio_buffer.speech_started`, `conversation.item.input_audio_transcription.completed`, `error`

## Barge-in pattern

Triggered on the Inworld `input_audio_buffer.speech_started` event:

```typescript
outBuffer = Buffer.alloc(0);                                   // 1. drop queued output
plivoWs.send(JSON.stringify({ event: "clearAudio" }));         // 2. stop Plivo playback
inworld.cancelResponse();                                      // 3. cancel Inworld generation
```

## File map

| Change | File |
|--------|------|
| System prompt / env handling | `src/config.ts` |
| Voice, LLM model, STT, turn detection (`session.update`) | `src/voice/inworld-realtime.ts` |
| Plivo↔Inworld bridging, buffering, barge-in | `src/voice/call-handler.ts` |
| Plivo XML (`/voice`), health check | `src/server/xml.ts` |
| Express + WebSocket server bootstrap | `src/index.ts` |

## Session config defaults (in `inworld-realtime.ts`)

- LLM model: `openai/gpt-4.1-mini`
- Input transcription: `assemblyai/universal-streaming-multilingual`
- Turn detection: `semantic_vad`, `interrupt_response: true` (do not disable — barge-in depends on it)
- TTS: model `inworld-tts-2`, voice `Sarah`, format `g711_ulaw`

## Env vars

`INWORLD_API_KEY`, `SERVER_URL`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN` (required);
`PORT` (3000), `SYSTEM_PROMPT` (optional).

## Verifying a change

1. `ngrok http 3000 --url=<domain>` and set the Plivo number's Answer URL to `https://<domain>/voice` (POST).
2. `npm run dev` — expect `[server] Listening on port 3000`.
3. Call the number; confirm greeting, a back-and-forth turn, and that interrupting the AI cuts its audio.
