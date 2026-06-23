# Agent Instructions

## What This Is

Two voice agent examples: Plivo (telephony) → Inworld (AI).

## Files to Know

| Task | File |
|------|------|
| Change system prompt | `src/config.ts` → `systemPrompt` |
| Change voice/model | `realtime/src/voice/inworld-realtime.ts` or `cascaded/src/config.ts` |
| Handle Plivo messages | `src/voice/call-handler.ts` or `src/pipeline/call-handler.ts` |
| Modify Plivo XML | `src/server/xml.ts` |

## Audio Pipeline

```
Plivo (μ-law 8kHz) ←→ Server ←→ Inworld (μ-law 8kHz)
```

No conversion needed. Pass through as base64.

## Barge-in Pattern

When user interrupts:
1. Clear local buffer
2. Send `{ event: "clearAudio" }` to Plivo
3. Send `{ type: "response.cancel" }` to Inworld (realtime) or `AbortController.abort()` (cascaded)

## Common Bugs

- **No audio**: Check Plivo webhook URL matches `SERVER_URL` env var
- **One-way audio**: Ensure `bidirectional="true"` in XML Stream element
- **Choppy audio**: Buffer at least 400 bytes before sending

## Testing

1. `ngrok http 3000`
2. Set Plivo Answer URL to ngrok
3. `npm run dev`
4. Call the Plivo number
