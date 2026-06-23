# Plivo + Inworld Cascaded Pipeline Voice Agent

Cascaded voice agent: Plivo → **Inworld STT** (WebSocket) → **Inworld Router/LLM** (streaming
HTTP) → **Inworld TTS** (HTTP) → Plivo. Unlike `realtime-api/`, each stage is a separate Inworld
service, so each is independently swappable and observable.

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
  STT sends `encoding: "MULAW", sample_rate_hertz: 8000`; TTS requests `output_format: "mulaw_8000"`.
- ALWAYS chunk outgoing audio to ≤400 bytes per `playAudio` (see `sendToPlivo` in `call-handler.ts`).
- Synthesize TTS **per sentence** as the LLM streams (lower perceived latency) — do not wait for the full response.
- On barge-in: `activeAbort.abort()` the in-flight LLM/TTS work AND send `clearAudio` to Plivo.
- Maintain `conversationHistory` (system + user + assistant turns) across the call.

## Audio

μ-law (G.711) 8kHz mono, base64 on the Plivo WebSocket. `MIN_CHUNK_BYTES = 400`.

## Pipeline flow (`call-handler.ts`)

1. Plivo `media` frames → `stt.sendAudio(payload)`.
2. STT emits `transcript(text, isFinal)`; on a final transcript, a **1s silence timer** debounces end-of-utterance.
3. On fire: if a response is in flight, abort it + `clearAudio` (barge-in), then `processUserInput()`.
4. `processUserInput` streams the LLM via `streamChatCompletion`, buffers tokens, and on each
   sentence boundary (`/^(.+?[.!?])\s*/`) calls `synthesizeSpeech()` and pushes audio to Plivo.
5. Remaining text is flushed; full assistant turn is appended to `conversationHistory`.

## Message / API contracts

**Plivo WebSocket** (`/media-stream`)
- Receive: `start`, `media` (base64 μ-law), `stop`
- Send: `playAudio` (base64 audio), `clearAudio` (barge-in)

**Inworld STT** — `wss://api.inworld.ai/v1/stt/stream`, `Authorization: Basic <key>`
- Send config `{ encoding, sample_rate_hertz, language_code }`, then `{ audio: <base64> }` frames
- Receive `{ transcript, is_final }`

**Inworld Router/LLM** — `POST https://api.inworld.ai/v1/chat/completions` (streamed)
**Inworld TTS** — `POST https://api.inworld.ai/v1/tts` (per-sentence) or `/v1/tts/stream` (chunked)

## Barge-in pattern

```typescript
if (activeAbort) {
  activeAbort.abort();   // cancel in-flight LLM stream + TTS (AbortError is caught)
  clearPlivoAudio();     // flush queued playback on Plivo
}
```

## File map

| Change | File |
|--------|------|
| System prompt, TTS voice/model, LLM model, env | `src/config.ts` |
| Pipeline orchestration, silence/barge-in, history | `src/pipeline/call-handler.ts` |
| STT WebSocket client + config | `src/pipeline/inworld-stt.ts` |
| Router/LLM streaming client | `src/pipeline/inworld-llm.ts` |
| TTS client (`synthesizeSpeech`, `streamSynthesis`) | `src/pipeline/inworld-tts.ts` |
| Plivo XML (`/voice`), health check | `src/server/xml.ts` |
| Express + WebSocket server bootstrap | `src/index.ts` |

## Defaults (in `config.ts`)

- LLM model (`INWORLD_MODEL`): `openai/gpt-4.1-mini`
- TTS voice (`TTS_VOICE`): `Sarah`; TTS model (`TTS_MODEL`): `inworld-tts-2`
- STT: `MULAW` / `8000` / `en-US` (in `inworld-stt.ts`)

## Env vars

`INWORLD_API_KEY`, `SERVER_URL`, `PLIVO_AUTH_ID`, `PLIVO_AUTH_TOKEN` (required);
`PORT` (3000), `SYSTEM_PROMPT`, `TTS_VOICE`, `TTS_MODEL`, `INWORLD_MODEL` (optional).
The Inworld key must have **STT, Router, and TTS** access.

## Verifying a change

1. `ngrok http 3000 --url=<domain>`; set the Plivo Answer URL to `https://<domain>/voice` (POST).
2. `npm run dev`; call the number.
3. Confirm the greeting, that your speech is transcribed (`[pipeline] User: ...` logs), a spoken
   response, and that talking over the AI cancels its current reply.
