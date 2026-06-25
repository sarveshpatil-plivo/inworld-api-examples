/**
 * Shared utilities for the inworld-stt example.
 *
 * Inworld STT wants LINEAR16, so Plivo μ-law is decoded to PCM16 on the way in.
 * ElevenLabs TTS returns μ-law 8k directly, so no conversion is needed on the way out.
 */

export const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "1";

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
