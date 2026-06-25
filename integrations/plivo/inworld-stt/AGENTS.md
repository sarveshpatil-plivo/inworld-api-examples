# Agent Rules — Plivo + Inworld STT (inbound)

Full voice agent spotlighting Inworld STT: Inworld STT → Gemini LLM → ElevenLabs TTS, over Plivo.
See this folder's `CLAUDE.md` for the provider contracts and file map.

## MUST

- Keep `server.ts` (telephony + Plivo provisioning) and `agent.ts` (pipeline + state machine) separate.
- Decode Plivo μ-law → PCM16 before sending to Inworld STT (configured for LINEAR16).
- Request ElevenLabs `output_format=ulaw_8000` so audio goes to Plivo without conversion.
- Send `playAudio` as `{ media: { contentType:"audio/x-mulaw", sampleRate:8000, payload } }` in 160-byte chunks.
- Use Gemini's `contents` (roles user/model) + `systemInstruction`; stream and synthesize per sentence.
- Gate barge-in on `agentSpeaking`; route fatal socket/handshake errors through teardown.
- `npm run build` (tsc) must pass; verify end-to-end against a real Plivo call before claiming done.

## MUST NOT

- Commit `.env` or credentials.
- Drop `contentType`/`sampleRate` from `playAudio`, or change the 8kHz Plivo rate.
- Put pipeline logic in `server.ts` or telephony logic in `agent.ts`.

## Debugging

- No transcription → Inworld key STT access; check `[stt]` logs / `Inworld HTTP <status>` / error frames.
- No reply → Gemini key/model.
- No audio out → ElevenLabs key/voice; check `[tts]` logs.
- Call connects but silent → confirm `playAudio` carries `contentType`+`sampleRate`.
