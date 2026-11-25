/**
 * Continuous MSB-first septet stream decoder.
 *
 * The decoder is the shared container for the block graph-curve channel and the
 * Looper waveform; these cases pin the bit order, the continuity across value
 * boundaries, the start offset, and the short-wire contract.
 */
import { decodeSeptetStream } from '../../src/shared/septetStream.js';
import { packSeptetStream } from './septet-fixtures.js';

function fail(msg: string): never {
  throw new Error(`[shared/septetStream] ${msg}`);
}

export const SHARED_SEPTETSTREAM_CASE_COUNT = 6;

export function runSharedSeptetStreamTests(): void {
  // 1 - round-trip every length from 0 to 520 bytes (the curve payload is 512).
  for (let n = 0; n <= 520; n++) {
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) bytes.push((i * 37 + (i >> 3) * 11) & 0xff);
    const wire = packSeptetStream(bytes);
    if (wire.length !== Math.ceil((n * 8) / 7)) fail(`encoded length ${wire.length} for ${n} bytes`);
    const decoded = decodeSeptetStream(wire, n);
    if (decoded.length !== n) fail(`round-trip length ${decoded.length} !== ${n}`);
    for (let i = 0; i < n; i++) if (decoded[i] !== bytes[i]) fail(`round-trip byte ${i} of ${n}: ${decoded[i]} !== ${bytes[i]}`);
  }

  // 2 - known bit patterns, including a byte split across two septets.
  const ff00 = decodeSeptetStream([0x7f, 0x40, 0x00], 2);
  if (ff00[0] !== 0xff || ff00[1] !== 0x00) fail(`ff00 -> ${[...ff00].join(',')}`);
  const zeroff = decodeSeptetStream([0x00, 0x3f, 0x60], 2);
  if (zeroff[0] !== 0x00 || zeroff[1] !== 0xff) fail(`00ff -> ${[...zeroff].join(',')}`);

  // 3 - the stream is continuous: 8 bytes never align to septets, so a wrong
  //     per-value grouping would corrupt every byte after the first.
  const bytes8 = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67];
  const wire8 = packSeptetStream(bytes8);
  const decoded8 = decodeSeptetStream(wire8, bytes8.length);
  if (decoded8.join(',') !== bytes8.join(',')) fail('8-byte stream is not continuous');

  // 4 - `start` skips the frame header bytes.
  const prefixed = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, ...wire8];
  const decodedPrefixed = decodeSeptetStream(prefixed, bytes8.length, 6);
  if (decodedPrefixed.join(',') !== bytes8.join(',')) fail('start offset misaligned');

  // 5 - a short wire returns the bytes it could produce, not a padded buffer.
  const short = decodeSeptetStream(packSeptetStream(bytes8).slice(0, 4), bytes8.length);
  if (short.length !== 3) fail(`short wire produced ${short.length} bytes, expected 3`);
  for (let i = 0; i < short.length; i++) if (short[i] !== bytes8[i]) fail(`short byte ${i} wrong`);

  // 6 - a 512-byte payload needs exactly 586 septets (the 609-byte reply geometry).
  if (Math.ceil((512 * 8) / 7) !== 586) fail('512-byte payload is not 586 septets');
  const payload: number[] = [];
  for (let i = 0; i < 512; i++) payload.push(i === 0 ? 1 : i & 0xff);
  const payloadWire = packSeptetStream(payload);
  if (payloadWire.length !== 586) fail(`payload encoded to ${payloadWire.length} septets`);
  const payloadBack = decodeSeptetStream(payloadWire, 512);
  if (payloadBack.length !== 512) fail(`payload decoded to ${payloadBack.length} bytes`);
  for (let i = 0; i < 512; i++) if (payloadBack[i] !== payload[i]) fail(`payload byte ${i} wrong`);
}
