// Live-poll value decode: a known catalog address decodes to a display value;
// a correlated candidate keeps its label; a truly unknown address returns raw.
// The ingate.gain_monitor frames are REAL captures (see polldecode.test.ts).

import {
  decodeAm4PollResponse,
  decodeAm4LiveValue,
  am4ParamKeyForPid,
} from '../../src/am4/liveDecode.js';

function h(hex: string): number[] {
  return hex.trim().split(/\s+/).map((b) => Number.parseInt(b, 16));
}

export const AM4_LIVE_DECODE_CASE_COUNT = 5;

export function runAm4LiveDecodeTests(): void {
  const failed: string[] = [];

  // 1. Known catalog param: ingate.gain_monitor (0x0025/0x0010) → ~9.25 on the
  //    knob_0_10 scale (float32 0.9253 × 10).
  const r = decodeAm4PollResponse(h('f0 00 01 74 15 01 25 00 10 00 10 00 00 00 04 00 5B 78 6D 43 78 45 f7'));
  if (r.paramKey !== 'ingate.gain_monitor') failed.push(`expected ingate.gain_monitor, got ${r.paramKey}`);
  if (r.unit !== 'knob_0_10') failed.push(`expected unit knob_0_10, got ${r.unit}`);
  if (r.display === undefined || Math.abs(r.display - 9.25) > 0.02) failed.push(`expected display ~9.25, got ${r.display}`);
  if (r.formatted !== '9.25') failed.push(`expected formatted '9.25', got '${r.formatted}'`);
  if (r.unknown) failed.push('known param should not be flagged unknown');

  // 2. Reverse index resolves the address to the catalog key.
  if (am4ParamKeyForPid(0x0025, 0x0010) !== 'ingate.gain_monitor') {
    failed.push('am4ParamKeyForPid(0x25,0x10) did not resolve ingate.gain_monitor');
  }

  // 3. Correlated candidate with no catalog param (tuner channel 0x0023/0x0001):
  //    no display value, but the candidate label is attached and it is NOT
  //    marked unknown (we know the address, just not its scaling).
  const t = decodeAm4LiveValue(0x0023, 0x0001, 0.5, 0, 0x0010);
  if (t.candidate?.name !== 'tuner.live_channel_1') failed.push(`expected tuner.live_channel_1 candidate, got ${t.candidate?.name}`);
  if (t.display !== undefined) failed.push('candidate-only address must not invent a display value');
  if (t.unknown) failed.push('a correlated candidate address should not be flagged unknown');

  // 4. Genuinely unknown address → raw value only, flagged unknown.
  const u = decodeAm4LiveValue(0x7f7f, 0x7f7f, 0.42, 0, 0x0010);
  if (!u.unknown) failed.push('unrecognised address should be flagged unknown');
  if (u.display !== undefined || u.candidate !== undefined) failed.push('unknown address must carry no scaling/label');
  if (Math.abs(u.rawFloat - 0.42) > 1e-9) failed.push('unknown address must still surface the raw float');

  if (failed.length > 0) {
    throw new Error(`[am4/livedecode] ${failed.length} failure(s):\n` + failed.join('\n'));
  }
}
