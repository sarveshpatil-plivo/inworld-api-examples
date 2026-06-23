# Agent Rules — Plivo + Inworld Cascaded Pipeline

Cascaded STT → LLM → TTS voice agent using three separate Inworld services. See `CLAUDE.md`
in this folder for the full pipeline flow, file map, and API contracts.

## MUST

- Run `npm run dev` and test over `ngrok http 3000` against a real Plivo call before claiming a change works.
- Keep audio at 8kHz μ-law end to end: STT `encoding: "MULAW", sample_rate_hertz: 8000`; TTS `output_format: "mulaw_8000"`.
- Chunk outgoing audio to ≤400 bytes per `playAudio` message (`sendToPlivo`).
- Stream the LLM and synthesize TTS per sentence — do not block on the full LLM response.
- On barge-in: `activeAbort.abort()` the in-flight work AND send `clearAudio` to Plivo.
- Append both user and assistant turns to `conversationHistory` so context persists.
- Handle errors on the STT WebSocket and on every `fetch` (check `response.ok`).

## MUST NOT

- Commit `.env` or credentials.
- Change the audio format or sample rate at any stage.
- Replace per-sentence streaming TTS with a single blocking call at the end of the turn (kills perceived latency).
- Drop the 1s silence debounce without an equivalent end-of-utterance signal.
- Swap the Authorization scheme — all Inworld APIs use `Authorization: Basic <INWORLD_API_KEY>`.

## Barge-in pattern

```typescript
// When a new final transcript arrives while a response is in flight:
if (activeAbort) {
  activeAbort.abort();   // cancels LLM stream + TTS (AbortError is caught downstream)
  clearPlivoAudio();     // flushes queued Plivo playback
}
```

## Testing

1. `ngrok http 3000 --url=<domain>`
2. Plivo Console → your number → Answer URL = `https://<domain>/voice`, method POST
3. `npm run dev`
4. Call the number; verify greeting → transcription logs → spoken reply → barge-in

## Debugging

- No transcription: check audio is μ-law 8kHz and that STT access is enabled on the key; inspect `[stt] Error` logs.
- No reply after transcript: verify Router access and `INWORLD_MODEL`; the 1s silence timer must fire (`[pipeline] User: ...`).
- TTS audio bad/silent: confirm `output_format: "mulaw_8000"`; mismatched sample rate sounds garbled on Plivo.
- High latency: expected (3 sequential services) — ensure per-sentence TTS is active; consider the `realtime/` example.
