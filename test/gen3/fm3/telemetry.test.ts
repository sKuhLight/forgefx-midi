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
  isOutputMeterResponse,
  parseOutputMeterRms,
  meterRmsToDb,
  buildCpuPoll,
  isCpuResponse,
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

  // ── CPU: builder + raw byte + percent math ──
  const cpu = entry('cpu-poll');
  assertEq(toHex(buildCpuPoll(FM3)), cpu.requestHex, 'buildCpuPoll frame');
  for (const run of cpu.runs) {
    const frames = run.frames.map(parseHex);
    const f = frames.find((x) => isCpuResponse(x));
    if (!f) throw new Error('[fm3/telemetry] no matching CPU response frame');
    const raw = parseCpuRawLoad(f);
    assertEq({ rawByte37: raw, percent: cpuPercentFromRaw(raw) }, run.expected, 'CPU raw/percent');
  }

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

  // ── model-byte discipline: frames carry the byte they were built with ──
  for (const mb of [0x10, 0x11, 0x12]) {
    for (const frame of [buildTunerPoll(mb), buildCpuPoll(mb), buildOutputMeterPoll(GEN3_OUTPUT_METERS[0]!, mb), buildSetTempoViaParam(120, mb)]) {
      if (frame[4] !== mb) throw new Error(`[fm3/telemetry] frame model byte ${frame[4]} !== ${mb}`);
    }
  }
}
