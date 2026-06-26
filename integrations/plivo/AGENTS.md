# Agent Rules — Plivo + Inworld Voice Agents

Two inbound voice-agent examples. Each is self-contained; read the `AGENTS.md`/`CLAUDE.md` inside
the folder you're editing.

- `s2s-pipeline/` — Inworld Realtime (speech-to-speech), one WebSocket. **Working.**
- `stt-llm-tts-pipeline/` — Inworld STT → Router/LLM → TTS, cascaded. **Builds; needs a
  STT+Router+TTS-scoped key to verify live.**

## MUST

- Keep the split: `inbound/server.ts` = telephony + Plivo provisioning; `inbound/agent.ts` = pipeline + state machine; `inbound/system_prompt.md` = instructions; `utils.ts` = shared helpers.
- Keep Plivo audio at 8kHz μ-law. Send `playAudio` as `{ media: { contentType:"audio/x-mulaw", sampleRate:8000, payload } }` in 160-byte (20ms) chunks.
- Gate barge-in on `isSpeaking()` (clear playback + cancel only while the agent is talking).
- `npm run build` (tsc) must pass before claiming a change works; test over `ngrok http 3000` against a real call.

## MUST NOT

- Commit `.env` or credentials.
- Drop `contentType`/`sampleRate` from `playAudio`, or change the 8kHz rate.
- Mix telephony/provisioning into `agent.ts` or pipeline logic into `server.ts`.
- Interrupt the agent on every `speech_started` regardless of state (it cuts itself off).

## Plivo provisioning (both server.ts)

On startup `configurePlivoWebhooks()` finds/creates the Plivo Application and maps
`PLIVO_PHONE_NUMBER` to it (answer/hangup/fallback from `PUBLIC_URL`). Non-fatal if creds missing.

## Per-pipeline audio

- `s2s-pipeline`: μ-law passthrough (Inworld Realtime speaks `g711_ulaw`). No transcoding.
- `stt-llm-tts-pipeline`: transcodes — `ulawToPcm` for STT (LINEAR16), `pcmToUlaw` (+resample) for TTS output. See its `utils.ts`.

## Testing

1. `.env`: `INWORLD_API_KEY`, `PLIVO_AUTH_ID/TOKEN`, `PLIVO_PHONE_NUMBER`, `PUBLIC_URL`.
2. `ngrok http 3000` → set `PUBLIC_URL`.
3. `npm run dev` → expect provisioning + `Listening on port 3000`.
4. Call the number; verify greeting, conversation, barge-in.
