# Agent Rules — Plivo + Inworld TTS (inbound)

Full voice agent spotlighting Inworld TTS: Deepgram STT → Gemini LLM → Inworld TTS, over Plivo.
See this folder's `CLAUDE.md` for the provider contracts and file map.

## MUST

- Keep `server.ts` (telephony + Plivo provisioning) and `agent.ts` (pipeline + state machine) separate.
- Decode Plivo μ-law → PCM16 for Deepgram (LINEAR16); resample Inworld TTS PCM to 8k + `pcmToUlaw` for Plivo.
- Send `playAudio` as `{ media: { contentType:"audio/x-mulaw", sampleRate:8000, payload } }` in 160-byte chunks.
- Use Gemini's `contents` (roles user/model) + `systemInstruction`; stream and synthesize per sentence.
- Gate barge-in on `agentSpeaking`; route fatal socket/handshake errors through teardown.
- `npm run build` (tsc) must pass; verify end-to-end against a real Plivo call before claiming done.

## MUST NOT

- Commit `.env` or credentials.
- Drop `contentType`/`sampleRate` from `playAudio`, or change the 8kHz Plivo rate.
- Put pipeline logic in `server.ts` or telephony logic in `agent.ts`.

## Debugging

- No transcription → Deepgram key/model; check `[stt]` logs.
- No reply → Gemini key/model.
- Garbled / no audio out → Inworld key TTS access or a sample-rate mismatch; check `[tts]` logs and `TTS_SAMPLE_RATE`.
- Call connects but silent → confirm `playAudio` carries `contentType`+`sampleRate`.
