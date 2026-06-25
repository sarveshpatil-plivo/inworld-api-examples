# Agent Rules — Plivo + Inworld LLM (inbound)

Full voice agent spotlighting Inworld's LLM: Deepgram STT → Inworld Router/LLM → ElevenLabs TTS,
over Plivo. See this folder's `CLAUDE.md` for the provider contracts and file map.

## MUST

- Keep `server.ts` (telephony + Plivo provisioning) and `agent.ts` (pipeline + state machine) separate.
- Decode Plivo μ-law → PCM16 before sending to Deepgram (it's configured for LINEAR16).
- Request ElevenLabs `output_format=ulaw_8000` so audio goes to Plivo without conversion.
- Send `playAudio` as `{ media: { contentType:"audio/x-mulaw", sampleRate:8000, payload } }` in 160-byte chunks.
- Stream the LLM and synthesize TTS per sentence; gate barge-in on `agentSpeaking`.
- Route fatal socket / handshake errors through teardown (no alive-but-dead call); log at error severity.
- `npm run build` (tsc) must pass; verify end-to-end against a real Plivo call before claiming done.

## MUST NOT

- Commit `.env` or credentials.
- Drop `contentType`/`sampleRate` from `playAudio`, or change the 8kHz Plivo rate.
- Put pipeline logic in `server.ts` or telephony logic in `agent.ts`.
- Block on the full LLM response before speaking (synthesize per sentence).

## Debugging

- No transcription → Deepgram key/model; check `[stt]` logs and `Deepgram HTTP <status>`.
- No reply after a transcript → Inworld key Router access or `INWORLD_MODEL`.
- No audio out → ElevenLabs key/voice; check `[tts]` logs and the ElevenLabs status.
- Call connects but silent → confirm `playAudio` carries `contentType`+`sampleRate`.
