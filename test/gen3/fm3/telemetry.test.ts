/**
 * Gen-3 telemetry — live-FM3 goldens.
 *
 * `fixtures/telemetry.expected.json` freezes raw request/response frames from
 * a REAL FM3 (through the pre-migration ForgeFX server, migration Phase 0)
 * plus the values that live-validated implementation computed. This suite
 * asserts (a) every builder reproduces the captured request byte-exactly at
 * model 0x11, and (b) every parser reproduces the captured expected value from
 * the captured raw frames.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTunerPoll,
  buildTunerPageOpen,
  buildTunerPageClose,
  isTunerResponse,
  parseTunerFreqHz,
  GEN3_OUTPUT_METERS,
  buildOutputMeterPoll,
  buildLooperWaveformPoll,
  isLooperWaveformResponse,
  parseLooperWaveform,
  isOutputMeterResponse,
  parseOutputMeterRms,
  meterRmsToDb,
  buildCpuPoll,
  isCpuResponse,
  parseCpuPercent,
  parseCpuRawLoad,
  cpuPercentFromRaw,
  buildSetTempoViaParam,
} from '../../../src/gen3/axe-fx-iii/telemetry.js';
import {
  parseTempoResponse,
  isSetGetTempoResponse,
  parseSceneResponse,
  isSetGetSceneResponse,
  buildGetTempo,
  buildGetScene,
} from '../../../src/gen3/axe-fx-iii/setParam.js';
import { decodeSeptetStream } from '../../../src/shared/septetStream.js';

const FM3 = 0x11;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface TelemetryRun { frames: string[]; expected: unknown }
interface TelemetryEntry { name: string; requestHex: string; runs: TelemetryRun[] }

const fixture = JSON.parse(readFileSync(join(FIXTURES, 'telemetry.expected.json'), 'utf8')) as { entries: TelemetryEntry[] };

const parseHex = (h: string): number[] => (h.match(/../g) ?? []).map((x) => parseInt(x, 16));
const toHex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');

function entry(name: string): TelemetryEntry {
  const e = fixture.entries.find((x) => x.name === name);
  if (!e) throw new Error(`[fm3/telemetry] fixture entry '${name}' missing`);
  return e;
}
function assertEq(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`[fm3/telemetry] ${what}: ${a} !== expected ${e}`);
}

export const FM3_TELEMETRY_CASE_COUNT = fixture.entries.length + 3; // + page open/close + tempo write

export function runFm3TelemetryTests(): void {
  // ── tuner poll: builder byte-exact + parser value-exact ──
  const tuner = entry('tuner-poll');
  assertEq(toHex(buildTunerPoll(FM3)), tuner.requestHex, 'buildTunerPoll frame');
  for (const run of tuner.runs) {
    const frames = run.frames.map(parseHex);
    const f = frames.find((x) => isTunerResponse(x));
    if (!f) throw new Error('[fm3/telemetry] captured tuner run has no matching response frame');
    assertEq({ freqHz: parseTunerFreqHz(f) }, run.expected, 'parseTunerFreqHz');
  }

  // ── meters: builder + RMS→dB pipeline against each captured run ──
  for (const meter of GEN3_OUTPUT_METERS) {
    const e = entry(`meter-${meter.role}`);
    assertEq(toHex(buildOutputMeterPoll(meter, FM3)), e.requestHex, `buildOutputMeterPoll(${meter.role})`);
    for (const run of e.runs) {
      const frames = run.frames.map(parseHex);
      const f = frames.find((x) => isOutputMeterResponse(x, meter));
      if (!f) throw new Error(`[fm3/telemetry] ${meter.role}: no matching response frame`);
      assertEq({ db: meterRmsToDb(parseOutputMeterRms(f)) }, run.expected, `${meter.role} dB`);
    }
  }

  // ── CPU: builder and exact load on the existing status replies ──
  // The 496-byte payload is ONE continuous MSB-first septet stream (7 wire bits per
  // byte, no per-chunk re-alignment), so it decodes to exactly the reply's declared
  // byte count and its leading fields are self-consistent: u32 edited flag @0x04 = 1,
  // u32 scene index @0x08 = 0, preset name @0x10, float32 LE CPU percent @0x0C.
  const cpu = entry('cpu-poll');
  assertEq(toHex(buildCpuPoll(FM3)), cpu.requestHex, 'buildCpuPoll frame');
  const expectedCpu = [65.74028015136719, 65.74581146240234, 65.73789978027344];
  assertEq(cpu.runs.length, expectedCpu.length, 'CPU fixture run count');
  const ascii = (bytes: Uint8Array, start: number, len: number): string => {
    let s = '';
    for (let i = 0; i < len; i++) {
      const b = bytes[start + i] ?? 0;
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s.trimEnd();
  };
  for (const [i, run] of cpu.runs.entries()) {
    const frames = run.frames.map(parseHex);
    const f = frames.find((x) => isCpuResponse(x));
    if (!f) throw new Error('[fm3/telemetry] no matching CPU response frame');
    assertEq(parseCpuPercent(f), expectedCpu[i], 'CPU float at status payload offset 0x0C');
    // Real-reply invariants: sub-op fields 0, 496-byte payload in a 590-byte frame
    // (21 header + ceil(496*8/7)=567 septets + checksum + F7).
    assertEq([f[7], f[17], f[18], f.length], [0, 0, 0, 590], 'status reply header/frame length');
    const declared = (f[19] ?? 0) | ((f[20] ?? 0) << 7);
    const payload = decodeSeptetStream(f, declared, 21);
    assertEq([payload.length, f.length], [declared, 21 + Math.ceil(declared * 8 / 7) + 2], 'declared payload size');
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    assertEq([dv.getUint32(4, true), dv.getUint32(8, true)], [1, 0], 'status flags at payload 0x04/0x08');
    assertEq([ascii(payload, 0x10, 32), ascii(payload, 0x30, 32)], ['yeet', 'Brilliant'], 'preset/scene names in the payload');
    // Keep the legacy public byte reader and estimate compatible for existing clients.
    const raw = parseCpuRawLoad(f);
    assertEq({ rawByte37: raw, percent: cpuPercentFromRaw(raw) }, run.expected, 'CPU raw/percent');
    // A real-shape frame with a flipped checksum must not match, so the legacy
    // `isCpuResponse` + `parseCpuRawLoad` path cannot read a corrupt reply.
    const corrupt = f.slice();
    corrupt[corrupt.length - 2] ^= 1;
    assertEq([isCpuResponse(f), isCpuResponse(corrupt)], [true, false], 'real reply checksum gate');
  }
  const status = (model: number, percent: number, field4 = 0): number[] => {
    const payload = new Uint8Array(640);
    new DataView(payload.buffer).setFloat32(12, percent, true);
    const wire = new Array<number>(Math.ceil(payload.length * 8 / 7)).fill(0);
    for (let bit = 0; bit < payload.length * 8; bit++) {
      const v = (payload[Math.floor(bit / 8)] >> (7 - bit % 8)) & 1;
      wire[Math.floor(bit / 7)] |= v << (6 - bit % 7);
    }
    const body = [...buildCpuPoll(model).slice(0, 19), payload.length & 0x7f, payload.length >>> 7, ...wire];
    // 14-bit field 4 (bytes 17..18): 0 on every observed FM3 reply, not constrained elsewhere.
    body[17] = field4 & 0x7f;
    body[18] = (field4 >> 7) & 0x7f;
    return [...body, body.reduce((xor, byte) => xor ^ byte, 0) & 0x7f, 0xf7];
  };
  assertEq(parseCpuPercent(status(0x10, 80.125)), 80.125, 'Axe-Fx III 640-byte status payload');
  assertEq(parseCpuPercent(status(0x12, 0)), 0, 'FM9 zero CPU load is valid');
  // Field 4 is only proven zero on FM3: an III/FM9-shaped reply with bytes 17/18 set
  // still decodes, while the same non-zero field 4 on an FM3 frame is rejected.
  assertEq(parseCpuPercent(status(0x10, 80.125, 0x1234)), 80.125, 'III status accepts non-zero field 4');
  assertEq(isCpuResponse(status(0x12, 12.5, 1)), true, 'FM9 status accepts non-zero field 4');
  assertEq(isCpuResponse(status(FM3, 50, 1)), false, 'FM3 status with non-zero field 4 is rejected');
  assertEq(isCpuResponse(buildCpuPoll(FM3)), false, 'CPU request is not a response');
  const fullStatus = status(0x10, 80.125);
  assertEq(isCpuResponse([...fullStatus.slice(0, -3), ...fullStatus.slice(-2)]), false, 'truncated CPU status');
  fullStatus[fullStatus.length - 2] ^= 1;
  assertEq(isCpuResponse(fullStatus), false, 'bad CPU status checksum is not a match');
  assertEq(parseCpuPercent(fullStatus), null, 'bad CPU status checksum');
  assertEq(parseCpuPercent(status(0x10, NaN)), null, 'non-finite CPU status value');

  // ── tuner page open/close: byte-exact vs the reference envelope math ──
  // (not in the capture file — the server fire-and-forgets these; frames are
  //  fixed by the envelope construction: F0 00 01 74 11 12 <sub> cs F7)
  const env = (fn: number, data: number[]): string => {
    const body = [0xf0, 0x00, 0x01, 0x74, FM3, fn, ...data];
    let cs = 0;
    for (const b of body) cs ^= b;
    return toHex([...body, cs & 0x7f, 0xf7]);
  };
  assertEq(toHex(buildTunerPageOpen(FM3)), env(0x12, [0x1e]), 'buildTunerPageOpen frame');
  assertEq(toHex(buildTunerPageClose(FM3)), env(0x12, [0x08]), 'buildTunerPageClose frame');

  // ── tempo write: byte-exact vs the reference implementation's independent math ──
  for (const bpm of [30, 120, 250]) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, bpm, true);
    const u = dv.getUint32(0, true);
    const val = [u & 0x7f, (u >>> 7) & 0x7f, (u >>> 14) & 0x7f, (u >>> 21) & 0x7f, (u >>> 28) & 0x7f];
    const expected = env(0x01, [0x09, 0x00, 0x02, 0x00, 0x20, 0x00, ...val, 0, 0, 0, 0]);
    assertEq(toHex(buildSetTempoViaParam(bpm, FM3)), expected, `buildSetTempoViaParam(${bpm})`);
  }

  // ── tempo/scene: the (now model-byte-parameterized) setParam parsers must
  //    reproduce the frozen live values on the captured FM3 frames. This is the
  //    behavioral diff-check gating the server's inline-parser removal
  //    (server math was: bpm = p0|(p1<<7); scene = payload[0] & 0x07). ──
  const tempoEntry = entry('tempo');
  for (const run of tempoEntry.runs) {
    const frames = run.frames.map(parseHex);
    const f = frames.find((x) => isSetGetTempoResponse(x, FM3));
    if (!f) throw new Error('[fm3/telemetry] no 0x14 frame matched at model 0x11');
    assertEq({ bpm: parseTempoResponse(f, FM3).bpm }, run.expected, 'parseTempoResponse vs live server math');
  }
  const sceneEntry = entry('scene');
  for (const run of sceneEntry.runs) {
    const frames = run.frames.map(parseHex);
    const f = frames.find((x) => isSetGetSceneResponse(x, FM3));
    if (!f) throw new Error('[fm3/telemetry] no 0x0C frame matched at model 0x11');
    assertEq({ index: parseSceneResponse(f, FM3).scene }, run.expected, 'parseSceneResponse vs live server math');
  }
  // and the query builders carry the requested model byte
  if (buildGetTempo(FM3)[4] !== FM3) throw new Error('[fm3/telemetry] buildGetTempo model byte');
  if (buildGetScene(FM3)[4] !== FM3) throw new Error('[fm3/telemetry] buildGetScene model byte');

  // Synthetic trace: packed little-endian floats [0, 0.25, 0.75, 1.125, -0.5].
  const looper = 166;
  const wave = parseHex('f0000174110123002601000007000000000000140000000000000001001f000004017c0000480f600000027e3ef7');
  assertEq(buildLooperWaveformPoll(looper, FM3).length, 23, 'full looper trace request');
  assertEq(isLooperWaveformResponse(wave, looper), true, 'looper trace response');
  assertEq(isLooperWaveformResponse(wave, looper + 1), false, 'looper response for another block');
  assertEq(parseLooperWaveform(wave), [0, 0.25, 0.75, 1, 0], 'decode packed waveform magnitudes');
  assertEq(parseLooperWaveform(wave.slice(0, -2)), [], 'reject truncated waveform');

  // ── model-byte discipline: frames carry the byte they were built with ──
  for (const mb of [0x10, 0x11, 0x12]) {
    for (const frame of [buildTunerPoll(mb), buildCpuPoll(mb), buildOutputMeterPoll(GEN3_OUTPUT_METERS[0]!, mb), buildSetTempoViaParam(120, mb)]) {
      if (frame[4] !== mb) throw new Error(`[fm3/telemetry] frame model byte ${frame[4]} !== ${mb}`);
    }
  }
}
