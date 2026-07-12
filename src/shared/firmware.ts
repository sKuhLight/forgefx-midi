/**
 * Fractal firmware-version query — the fn 0x08 request/reply that reports a
 * unit's running firmware and build date.
 *
 * A gen-3 unit answers a fn 0x08 frame with its own Fractal-headed reply whose
 * fn is 0x08: `frame[6]` is the firmware major, `frame[7]` the minor, and a
 * NUL-terminated 7-bit-ASCII build-date string occupies `frame[10..30]`. This
 * is live-validated on the FM3 (model 0x11); the FM9 and Axe-Fx III share the
 * gen-3 firmware and are expected identical. AM4 (gen-4) and the gen-1/gen-2
 * families are unverified for this function.
 *
 * Pure and transport-agnostic: builders/parsers only. Consumers own the
 * request/response orchestration (send the query, wait for a header-shaped
 * fn 0x08 reply).
 */
import { fractalChecksum } from './checksum.js';
import { isFractalHeaderFrame } from './identify.js';

/** Firmware-version function byte (SysEx header f[5]). */
export const FN_FIRMWARE_VERSION = 0x08;

/** Decoded firmware-version reply: numeric major/minor + optional build date. */
export interface FirmwareVersion {
  major: number;
  minor: number;
  /** NUL-terminated ASCII build date, or null when the reply carries none. */
  build: string | null;
}

/** Build the fn 0x08 firmware query for a model: `F0 00 01 74 <model> 08 cs F7`. */
export function buildFirmwareVersionQuery(modelId: number): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, modelId, FN_FIRMWARE_VERSION];
  return [...body, fractalChecksum(body), 0xf7];
}

/** First byte offset of the build-date region, and the (inclusive) last. */
const BUILD_START = 10;
const BUILD_END = 30;

/**
 * Decode a fn 0x08 firmware-version reply. Null unless the frame is a
 * Fractal-headed frame with fn 0x08 and both version bytes present. `build` is
 * the NUL-terminated 7-bit-ASCII date from `frame[10..30]` (null when that
 * region is absent or empty).
 */
export function parseFirmwareVersionReply(frame: readonly number[]): FirmwareVersion | null {
  if (!isFractalHeaderFrame(frame)) return null;
  if (frame[5] !== FN_FIRMWARE_VERSION) return null;
  if (frame.length < 8) return null; // need major (f[6]) + minor (f[7])

  let build = '';
  for (let i = BUILD_START; i <= BUILD_END && i < frame.length; i++) {
    const c = frame[i]!;
    if (c === 0x00 || c === 0xf7) break; // NUL terminator (or the SysEx end)
    if (c > 0x7f) break; // stop at the first non-ASCII byte
    build += String.fromCharCode(c);
  }

  return { major: frame[6]!, minor: frame[7]!, build: build.length > 0 ? build : null };
}

/** Canonical `major.minor` firmware spelling, e.g. `formatFirmwareVersion(12, 0)` → "12.0". */
export function formatFirmwareVersion(major: number, minor: number): string {
  return `${major}.${minor}`;
}
