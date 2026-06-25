/**
 * Shared utilities for the inworld-tts example.
 *
 * Deepgram STT is fed LINEAR16 (decode Plivo μ-law → PCM16), and Inworld TTS
 * returns PCM, which we resample to 8k and encode to μ-law for Plivo.
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

// ── G.711 μ-law ↔ linear PCM16 ──────────────────────────────────────────────
const BIAS = 0x84;
const CLIP = 32635;

function ulawDecodeSample(uByte: number): number {
  uByte = ~uByte & 0xff;
  let t = ((uByte & 0x0f) << 3) + BIAS;
  t <<= (uByte & 0x70) >> 4;
  return (uByte & 0x80) ? BIAS - t : t - BIAS;
}

function ulawEncodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** μ-law bytes → little-endian PCM16 buffer. */
export function ulawToPcm(ulaw: Uint8Array) {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) out.writeInt16LE(ulawDecodeSample(ulaw[i]), i * 2);
  return out;
}

/** Little-endian PCM16 buffer → μ-law bytes. */
export function pcmToUlaw(pcm: Uint8Array) {
  const b = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = Buffer.alloc(Math.floor(b.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = ulawEncodeSample(b.readInt16LE(i * 2));
  return out;
}

/** Linear-interpolation resample of PCM16 mono audio. */
export function resamplePcm16(pcm: Uint8Array, inRate: number, outRate: number) {
  const b = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  if (inRate === outRate) return b;
  const inSamples = Math.floor(b.length / 2);
  const outSamples = Math.floor((inSamples * outRate) / inRate);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = inRate / outRate;
  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = b.readInt16LE(Math.min(idx, inSamples - 1) * 2);
    const s1 = b.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}
