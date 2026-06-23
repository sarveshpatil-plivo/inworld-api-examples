# Agent Rules — Plivo + Inworld Realtime

Speech-to-speech voice agent over a single Inworld Realtime WebSocket. See `CLAUDE.md` in
this folder for the full file map and message contracts.

## MUST

- Run `npm run dev` and test over `ngrok http 3000` against a real Plivo call before claiming a change works.
- Keep audio at 8kHz μ-law (`g711_ulaw`) on both Plivo and Inworld — no transcoding.
- Buffer ≥400 bytes before sending audio (`MIN_CHUNK_BYTES` in `src/voice/call-handler.ts`).
- On barge-in: clear local buffer → send `clearAudio` to Plivo → call `inworld.cancelResponse()`.
- Keep `interrupt_response: true` in the `semantic_vad` turn detection config.
- Handle errors on every WebSocket (`error`, `close`, `unexpected-response`).

## MUST NOT

- Commit `.env` or credentials.
- Change the audio format or sample rate.
- Remove the greeting trigger (`conversation.item.create` + `response.create` on `session.updated`).
- Swap the Authorization scheme — Inworld Realtime uses `Authorization: Basic <INWORLD_API_KEY>`.

## Barge-in pattern

```typescript
// On Inworld "input_audio_buffer.speech_started":
outBuffer = Buffer.alloc(0);                            // 1. clear local buffer
plivoWs.send(JSON.stringify({ event: "clearAudio" }));  // 2. stop Plivo playback
inworld.cancelResponse();                               // 3. cancel Inworld generation
```

## Testing

1. `ngrok http 3000 --url=<domain>`
2. Plivo Console → your number → Answer URL = `https://<domain>/voice`, method POST
3. `npm run dev`
4. Call the number; verify greeting, conversation, and barge-in

## Debugging

- No audio: `SERVER_URL` must match the ngrok domain; Answer URL must be HTTPS.
- One-way audio: confirm `bidirectional="true"` in the Plivo `<Stream>` XML.
- Choppy audio: increase `MIN_CHUNK_BYTES`.
- No AI response / connect errors: verify the Inworld key has **Realtime API** access; check `unexpected-response` logs for the HTTP status/body.
