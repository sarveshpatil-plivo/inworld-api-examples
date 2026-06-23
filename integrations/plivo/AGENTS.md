# Agent Rules

## MUST

- Run `npm run dev` to test changes
- Use `ngrok http 3000` for local testing
- Keep audio at 8kHz μ-law (Plivo requirement)
- Buffer minimum 400 bytes before sending audio
- Handle barge-in: clear buffer → clearAudio to Plivo → cancel Inworld

## MUST NOT

- Commit .env or credentials
- Change audio format/sample rate
- Use sync TTS calls in cascaded (causes latency)
- Skip error handling on WebSocket events

## Barge-in Pattern

```typescript
// When user interrupts:
outBuffer = Buffer.alloc(0);  // 1. Clear local buffer
plivoWs.send(JSON.stringify({ event: "clearAudio" }));  // 2. Stop Plivo playback
inworld.cancelResponse();  // 3. Cancel Inworld generation
```

## Testing

1. `ngrok http 3000`
2. Set Plivo Answer URL → ngrok URL + `/voice`
3. `npm run dev`
4. Call Plivo number

## Debugging

- No audio: Check SERVER_URL matches ngrok
- One-way audio: Verify `bidirectional="true"` in XML
- Choppy: Increase buffer size (MIN_CHUNK_BYTES)
- No response: Check Inworld API key has Realtime access
