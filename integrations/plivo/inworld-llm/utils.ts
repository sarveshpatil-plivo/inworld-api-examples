/**
 * Shared utilities for the inworld-llm example.
 *
 * This pipeline uses Deepgram STT (LINEAR16) and ElevenLabs TTS (μ-law 8k out),
 * so the only audio conversion needed is Plivo μ-law → PCM16 for Deepgram.
 * ElevenLabs returns μ-law 8k directly, so no conversion is needed on the way out.
 */

export const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "1";

/** Normalize a phone number to bare E.164 digits (no '+'), the form Plivo expects. */
export function normalizePhoneNumber(
  phone: string,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): string {
  if (!phone) return "";
  const hadPlus = phone.trim().startsWith("+");
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "";
  if (hadPlus) return digits;
  if (digits.length === 10) return `${defaultCountryCode}${digits}`;
  return digits;
}

// ── G.711 μ-law → linear PCM16 (for Deepgram, which we feed LINEAR16) ────────
const BIAS = 0x84;

function ulawDecodeSample(uByte: number): number {
  uByte = ~uByte & 0xff;
  let t = ((uByte & 0x0f) << 3) + BIAS;
  t <<= (uByte & 0x70) >> 4;
  return (uByte & 0x80) ? BIAS - t : t - BIAS;
}

/** μ-law bytes → little-endian PCM16 buffer. */
export function ulawToPcm(ulaw: Uint8Array) {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) out.writeInt16LE(ulawDecodeSample(ulaw[i]), i * 2);
  return out;
}
