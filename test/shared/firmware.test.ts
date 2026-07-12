/**
 * Firmware-version query (fn 0x08) — query-frame goldens + reply-parse cases.
 *
 * The query golden is checksum-inclusive (same scheme as the fn 0x00 identify
 * broadcast). Reply frames are synthesized to exercise the major/minor + build
 * date decode and the null-guards (missing date, non-Fractal frame, wrong fn).
 */
import {
  FN_FIRMWARE_VERSION,
  buildFirmwareVersionQuery,
  parseFirmwareVersionReply,
  formatFirmwareVersion,
} from '../../src/shared/firmware.js';
import { fractalChecksum } from '../../src/shared/checksum.js';

const toHex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');

function fail(msg: string): never {
  throw new Error(`[shared/firmware] ${msg}`);
}

/** Build a synthetic fn 0x08 reply: header + maj/min + reserved + ASCII date + NUL(s). */
function replyFrame(model: number, major: number, minor: number, date: string | null): number[] {
  const frame = [0xf0, 0x00, 0x01, 0x74, model, FN_FIRMWARE_VERSION, major, minor];
  // reserved bytes f[8], f[9] before the build-date region at f[10].
  frame.push(0x00, 0x00);
  if (date !== null) {
    for (const ch of date) frame.push(ch.charCodeAt(0));
    frame.push(0x00); // NUL terminator
  }
  frame.push(0xf7);
  return frame;
}

export const FIRMWARE_CASE_COUNT = 10;

export function runFirmwareTests(): void {
  // ── query-frame golden: FM3 (model 0x11), checksum-inclusive ──
  const fm3 = buildFirmwareVersionQuery(0x11);
  const cs = (0xf0 ^ 0x00 ^ 0x01 ^ 0x74 ^ 0x11 ^ 0x08) & 0x7f;
  const expected = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x08, cs, 0xf7];
  if (toHex(fm3) !== toHex(expected)) fail(`FM3 query ${toHex(fm3)} !== ${toHex(expected)}`);

  // ── query frames for FM9 (0x12) and Axe-Fx III (0x10), checksum via helper ──
  for (const model of [0x12, 0x10]) {
    const q = buildFirmwareVersionQuery(model);
    const body = [0xf0, 0x00, 0x01, 0x74, model, 0x08];
    const want = [...body, fractalChecksum(body), 0xf7];
    if (toHex(q) !== toHex(want)) fail(`model 0x${model.toString(16)} query ${toHex(q)} !== ${toHex(want)}`);
  }

  // ── reply parse: major/minor + build date ──
  const r = parseFirmwareVersionReply(replyFrame(0x11, 12, 0, '11/03/2025')) ?? fail('reply parsed to null');
  if (r.major !== 12) fail(`major ${r.major} !== 12`);
  if (r.minor !== 0) fail(`minor ${r.minor} !== 0`);
  if (r.build !== '11/03/2025') fail(`build '${r.build}' !== '11/03/2025'`);

  // ── formatter spells major.minor ──
  if (formatFirmwareVersion(r.major, r.minor) !== '12.0') fail('formatFirmwareVersion(12,0) !== "12.0"');

  // ── reply with no date region → build null, version still decoded ──
  const nd = parseFirmwareVersionReply(replyFrame(0x11, 9, 2, null)) ?? fail('no-date reply parsed to null');
  if (nd.major !== 9 || nd.minor !== 2) fail('no-date reply lost major/minor');
  if (nd.build !== null) fail(`no-date reply build '${nd.build}' !== null`);

  // ── empty date region (immediate NUL) → build null ──
  const empty = parseFirmwareVersionReply(replyFrame(0x11, 1, 0, '')) ?? fail('empty-date reply parsed to null');
  if (empty.build !== null) fail(`empty-date build '${empty.build}' !== null`);

  // ── non-Fractal frame → null ──
  if (parseFirmwareVersionReply([0xf0, 0x43, 0x00, 0x08, 0x11, 0x08, 0x01, 0x00, 0xf7]) !== null) {
    fail('non-Fractal frame did not return null');
  }

  // ── wrong-fn frame (fn 0x00 identify reply) → null ──
  if (parseFirmwareVersionReply([0xf0, 0x00, 0x01, 0x74, 0x11, 0x00, 0x00, 0xf7]) !== null) {
    fail('wrong-fn frame did not return null');
  }

  // ── too-short fn 0x08 frame (no minor byte) → null ──
  if (parseFirmwareVersionReply([0xf0, 0x00, 0x01, 0x74, 0x11, 0x08, 0x0c]) !== null) {
    fail('too-short frame did not return null');
  }
}
