# Plivo + Inworld Voice Agents

Self-contained inbound voice-agent examples connecting Plivo phone calls to Inworld. Structure
follows a conventional layout: each example has
`inbound/{agent.ts, server.ts, system_prompt.md}` + a shared `utils.ts`.

- **`s2s-pipeline/`** — single WebSocket to the Inworld Realtime API (speech-to-speech: STT + LLM + TTS in one). **Done.**
- **`stt-llm-tts-pipeline/`** — separate Inworld STT → Router/LLM → TTS services chained (more flexibility, higher latency).

Each folder has its own `README.md`, `CLAUDE.md`, and `AGENTS.md`. **Read the agent docs inside
the folder you're editing** — this root file is only an overview.

## Responsibilities (per example)

- **`inbound/server.ts`** — telephony + Plivo provisioning ONLY (`/answer`, `/ws`, `/hangup`, `/fallback`; `configurePlivoWebhooks` on startup).
- **`inbound/agent.ts`** — pipeline orchestration + call state machine; owns the Inworld connection(s) and audio.
- **`inbound/system_prompt.md`** — system instructions (override with `SYSTEM_PROMPT`).
- **`utils.ts`** — shared helpers (phone normalization; audio conversion in pipelines that need it).

## Commands

```bash
cd s2s-pipeline && npm install && npm run dev
```

## Rules

- NEVER commit `.env` files or API keys.
- NEVER change the audio sample rate from 8kHz μ-law — Plivo requires it.
- `playAudio` MUST include `contentType: "audio/x-mulaw"` + `sampleRate: 8000`; send 160-byte (20ms) chunks.
- Barge-in: gate on `isSpeaking()` — clear Plivo playback + cancel Inworld only while the agent is talking.
- Keep telephony/provisioning in `server.ts` and pipeline/state-machine in `agent.ts`.

## Plivo WebSocket (`/ws`)

Send: `playAudio` (`{contentType, sampleRate, payload}`), `clearAudio`. Receive: `start`, `media`, `stop`.

## Inworld Realtime (`wss://api.inworld.ai/api/v1/realtime/session`, `Basic` auth)

Send: `session.update`, `input_audio_buffer.append`, `response.create`, `response.cancel`.
Receive: `session.created/updated`, `response.output_audio.delta/done`, `response.done`, `input_audio_buffer.speech_started`.

## File map (s2s-pipeline)

| Change | File |
|--------|------|
| System prompt | `inbound/system_prompt.md` |
| Voice / LLM / STT config, state machine, barge-in, audio | `inbound/agent.ts` |
| Plivo provisioning, `/answer` `/ws` `/hangup` `/fallback`, env | `inbound/server.ts` |
| Phone normalization (shared) | `utils.ts` |
