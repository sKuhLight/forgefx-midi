// Poll-response decode: parseReadResponse must accept the live-poll (0x0010)
// and status-poll (0x0026) actions and expose the value as a float32. The
// four ingate.gain_monitor frames are REAL captures from
// Repositorys/fm3-scratchpad/devices/am4/captures/{preset-swap,preset-save}.sysex.txt
// (address 0x0025/0x0010, action 0x0010) — see docs/AM4-LIVE-VALUE-DECODE-PLAN.md.

import {
  parseReadResponse,
  isPollResponse,
  READ_TYPE_LIVE_POLL,
  READ_TYPE_STATUS_POLL,
} from '../../src/am4/setParam.js';

function h(hex: string): number[] {
  return hex.trim().split(/\s+/).map((b) => Number.parseInt(b, 16));
}

// Real ingate.gain_monitor (0x0025/0x0010) live-poll responses → float32 ≈ 0.925.
const INGATE_FRAMES: Array<{ hex: string; expected: number }> = [
  { hex: 'f0 00 01 74 15 01 25 00 10 00 10 00 00 00 04 00 5B 78 6D 43 78 45 f7', expected: 0.9253 },
  { hex: 'f0 00 01 74 15 01 25 00 10 00 10 00 00 00 04 00 35 1A 2D 43 78 09 f7', expected: 0.9235 },
  { hex: 'f0 00 01 74 15 01 25 00 10 00 10 00 00 00 04 00 47 6B 6D 53 78 5A f7', expected: 0.9285 },
  { hex: 'f0 00 01 74 15 01 25 00 10 00 10 00 00 00 04 00 27 4C 2D 53 78 5D f7', expected: 0.9265 },
];

// Synthetic status-poll (action 0x0026) with a zero-valued payload.
const STATUS_ZERO_FRAME = 'f0 00 01 74 15 01 2e 00 03 00 26 00 00 00 04 00 00 00 00 00 00 1e f7';

export const AM4_POLL_DECODE_CASE_COUNT = INGATE_FRAMES.length + 3;

export function runAm4PollDecodeTests(): void {
  const failed: string[] = [];

  // 1. Live-poll (0x0010) frames parse, report the right action, and decode
  //    to the expected float32 (u32/65534 would give ~16237 — nonsense).
  for (const { hex, expected } of INGATE_FRAMES) {
    const bytes = h(hex);
    if (!isPollResponse(bytes)) {
      failed.push(`isPollResponse rejected a valid 0x0010 frame: ${hex}`);
      continue;
    }
    const r = parseReadResponse(bytes);
    if (r.action !== READ_TYPE_LIVE_POLL) {
      failed.push(`action: expected 0x0010, got 0x${r.action.toString(16)}`);
    }
    if (r.pidLow !== 0x0025 || r.pidHigh !== 0x0010) {
      failed.push(`pid: expected 0x25/0x10, got 0x${r.pidLow.toString(16)}/0x${r.pidHigh.toString(16)}`);
    }
    const f = r.asFloat32();
    if (Math.abs(f - expected) > 0.001) {
      failed.push(`asFloat32: expected ~${expected}, got ${f.toFixed(4)} (${hex})`);
    }
    // Guard the correction: the u32/65534 reading must NOT be mistaken for a value.
    if (r.asInternalFloat() < 100) {
      failed.push(`asInternalFloat should be nonsensical (~16237) for a float32 payload, got ${r.asInternalFloat()}`);
    }
  }

  // 2. Status-poll (0x0026) frame parses and reports its action.
  const zeroBytes = h(STATUS_ZERO_FRAME);
  if (!isPollResponse(zeroBytes)) failed.push('isPollResponse rejected a valid 0x0026 frame');
  const z = parseReadResponse(zeroBytes);
  if (z.action !== READ_TYPE_STATUS_POLL) failed.push(`status action: expected 0x0026, got 0x${z.action.toString(16)}`);
  if (z.asFloat32() !== 0) failed.push(`status zero frame asFloat32: expected 0, got ${z.asFloat32()}`);

  // 3. A non-read action (write echo shape) must still be rejected.
  const writeEcho = h('f0 00 01 74 15 01 25 00 10 00 01 00 00 00 04 00 5B 78 6D 43 78 5c f7');
  if (isPollResponse(writeEcho)) failed.push('isPollResponse accepted a non-read action (0x0001)');

  if (failed.length > 0) {
    throw new Error(`[am4/polldecode] ${failed.length} failure(s):\n` + failed.join('\n'));
  }
}
