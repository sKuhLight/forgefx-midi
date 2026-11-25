/**
 * Gen-3 per-block visual data descriptors.
 *
 * Pins the block → (curve slots, markers, meters) mapping, the per-model marker
 * pids and meter spans, and that every frame goes through the existing
 * telemetry builders unchanged. Synthetic replies only.
 */
import {
  gen3BlockVisual,
  gen3VisualFamilies,
  gen3VisualModelByte,
  gen3VisualParam,
  buildGen3VisualCurvePoll,
  isGen3VisualCurveResponse,
  parseGen3VisualCurve,
  buildGen3VisualValuePoll,
  isGen3VisualValueResponse,
  parseGen3VisualValue,
  gen3VisualMeterDb,
} from '../../src/devices/gen3/visualData.js';
import {
  buildBlockMonitorPoll,
  buildGraphCurvePoll,
  GRAPH_CURVE_VALUE_COUNT,
} from '../../src/gen3/axe-fx-iii/telemetry.js';
import { encode5SeptetFloat32 } from '../../src/gen3/axe-fx-iii/setParam.js';
import { fractalChecksum } from '../../src/shared/checksum.js';
import { float32Bytes, packSeptetStream } from '../shared/septet-fixtures.js';
import { FM3_PARAMS } from '../../src/gen3/fm3/params.js';
import { FM9_PARAMS } from '../../src/gen3/fm9/params.js';
import { PARAMS as III_PARAMS } from '../../src/gen3/axe-fx-iii/params.js';

function fail(msg: string): never {
  throw new Error(`[gen3/visualData] ${msg}`);
}

const FM3 = 'fm3' as const;
const FM9 = 'fm9' as const;
const III = 'iii' as const;

function curveReply(model: number, eid: number, slot: number): number[] {
  const raw = float32Bytes(sampleCurve(GRAPH_CURVE_VALUE_COUNT));
  const header = [
    0xf0, 0x00, 0x01, 0x74, model, 0x01,
    0x23, 0x00,
    eid & 0x7f, (eid >> 7) & 0x7f,
    slot & 0x7f, (slot >> 7) & 0x7f,
    0, 0, 0, 0, 0,
    0, 0,
    0x00, 0x04,
  ];
  const body = [...header, ...packSeptetStream(raw)];
  return [...body, fractalChecksum(body), 0xf7];
}

function sampleCurve(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.sin(i / 5));
  return out;
}

type ParamRow = { family: string; paramId: number; name: string };

/** Catalog pid by (family, name) — the independent oracle for the visual tables. */
function paramPid(params: readonly ParamRow[], family: string, name: string): number | undefined {
  return params.find((p) => p.family === family && p.name === name)?.paramId;
}

/** 23-byte `sub 0x19` state-read reply with a 5-septet float value at 12..16. */
function stateReply(model: number, eid: number, pid: number, value: number): number[] {
  const body = [
    0xf0, 0x00, 0x01, 0x74, model, 0x01,
    0x19, 0x00,
    eid & 0x7f, (eid >> 7) & 0x7f,
    pid & 0x7f, (pid >> 7) & 0x7f,
    ...encode5SeptetFloat32(value),
    0, 0, 0, 0,
  ];
  return [...body, fractalChecksum(body), 0xf7];
}

export const GEN3_VISUALDATA_CASE_COUNT = 8;

export function runGen3VisualDataTests(): void {
  // 1 - compressor descriptor: sidechain + transfer slots, one marker, one meter.
  const comp = gen3BlockVisual('COMP', FM3);
  if (!comp) fail('COMP descriptor missing');
  if (comp.curveSlots.join(',') !== '0,1') fail(`COMP curve slots ${comp.curveSlots.join(',')}`);
  if (comp.waveform) fail('COMP flagged as waveform');
  const compMarker = gen3VisualParam(comp, 'COMP_XMARK');
  if (!compMarker || compMarker.role !== 'marker' || compMarker.pid !== 28) fail('COMP_XMARK binding wrong');
  const compMeter = gen3VisualParam(comp, 'COMP_GAINMONITOR');
  if (!compMeter || compMeter.role !== 'meter' || compMeter.pid !== 25) fail('COMP_GAINMONITOR binding wrong');
  if (compMeter.minDb !== -40 || compMeter.maxDb !== 0) fail('COMP_GAINMONITOR dB span wrong');
  if (gen3BlockVisual('NOT_A_BLOCK', FM3) !== null) fail('unknown family produced a descriptor');

  // 2 - markers are per model; LOOPER_STOP carries the playhead, not a stop flag.
  const controllersFm3 = gen3BlockVisual('CONTROLLERS', FM3)!;
  const controllersFm9 = gen3BlockVisual('CONTROLLERS', FM9)!;
  const controllersIii = gen3BlockVisual('CONTROLLERS', III)!;
  const pidOf = (v: ReturnType<typeof gen3BlockVisual>, name: string): number | undefined =>
    v ? gen3VisualParam(v, name)?.pid : undefined;
  if (pidOf(controllersFm3, 'CONTROLLERS_ADSR1_XMARK') !== 123) fail('FM3 ADSR1 marker pid');
  if (pidOf(controllersFm3, 'CONTROLLERS_ADSR2_XMARK') !== 125) fail('FM3 ADSR2 marker pid');
  if (pidOf(controllersFm9, 'CONTROLLERS_ADSR1_XMARK') !== 123) fail('FM9 ADSR1 marker pid');
  if (pidOf(controllersIii, 'CONTROLLERS_ADSR1_XMARK') !== 171) fail('III ADSR1 marker pid');
  if (pidOf(controllersIii, 'CONTROLLERS_ADSR2_XMARK') !== 173) fail('III ADSR2 marker pid');
  const looper = gen3BlockVisual('LOOPER', FM3)!;
  if (!looper.waveform) fail('LOOPER not flagged as waveform');
  const playhead = gen3VisualParam(looper, 'LOOPER_STOP');
  if (!playhead || playhead.role !== 'marker' || playhead.pid !== 14) fail('LOOPER_STOP binding wrong');
  if (!playhead.note || !playhead.note.includes('playhead')) fail('LOOPER_STOP note does not explain the playhead');

  // The param catalogs are the independent oracle for every marker pid, per model.
  const controllers: Array<[string, ReturnType<typeof gen3BlockVisual>, readonly ParamRow[]]> = [
    ['fm3', controllersFm3, FM3_PARAMS],
    ['fm9', controllersFm9, FM9_PARAMS],
    ['iii', controllersIii, III_PARAMS],
  ];
  for (const [model, visual, params] of controllers) {
    for (const name of ['CONTROLLERS_ADSR1_XMARK', 'CONTROLLERS_ADSR2_XMARK']) {
      const expected = paramPid(params, 'CONTROLLERS', name);
      if (expected === undefined) fail(`${model}: ${name} missing from the param catalog`);
      if (pidOf(visual, name) !== expected) fail(`${model}: ${name} pid ${pidOf(visual, name)} != catalog ${expected}`);
    }
    const expectedPlayhead = paramPid(params, 'LOOPER', 'LOOPER_STOP');
    if (expectedPlayhead === undefined) fail(`${model}: LOOPER_STOP missing from the param catalog`);
    if (pidOf(gen3BlockVisual('LOOPER', model), 'LOOPER_STOP') !== expectedPlayhead) {
      fail(`${model}: LOOPER_STOP pid != catalog ${expectedPlayhead}`);
    }
  }

  // 3 - meters come from the model's own table: OUTPUT is RMS, spans differ by model.
  const outputFm3 = gen3BlockVisual('OUTPUT', FM3)!;
  const outputIii = gen3BlockVisual('OUTPUT', III)!;
  const out1Fm3 = gen3VisualParam(outputFm3, 'OUTPUT_VUL');
  const out1Iii = gen3VisualParam(outputIii, 'OUTPUT_VUL');
  if (!out1Fm3 || out1Fm3.encoding !== 'rms') fail('OUTPUT_VUL is not RMS on FM3');
  if (out1Fm3.maxDb !== 6) fail(`FM3 OUTPUT_VUL ceiling ${out1Fm3.maxDb}`);
  if (!out1Iii || out1Iii.maxDb !== 10) fail(`III OUTPUT_VUL ceiling ${out1Iii?.maxDb}`);
  const input = gen3VisualParam(gen3BlockVisual('INPUT', FM3)!, 'INPUT_GAINMONITOR');
  if (!input || input.encoding !== 'normalized') fail('INPUT_GAINMONITOR is not normalized');
  const levelFm3 = gen3VisualParam(looper, 'LOOPER_LEVEL');
  if (!levelFm3 || levelFm3.pid !== 22 || levelFm3.minDb !== -80 || levelFm3.maxDb !== 20) {
    fail('FM3 LOOPER_LEVEL meter row missing or wrong');
  }
  if (paramPid(FM3_PARAMS, 'LOOPER', 'LOOPER_LEVEL') !== levelFm3.pid) {
    fail(`FM3 LOOPER_LEVEL pid ${levelFm3.pid} != catalog ${paramPid(FM3_PARAMS, 'LOOPER', 'LOOPER_LEVEL')}`);
  }

  // 4 - curve fetch delegates to the sub-0x23 builder and rejects unknown slots.
  const cab = gen3BlockVisual('CABINET', FM3)!;
  const cabPoll = buildGen3VisualCurvePoll(cab, FM3, 62, 3);
  if (cabPoll.join(',') !== buildGraphCurvePoll(62, 3, gen3VisualModelByte(FM3)).join(',')) {
    fail('cabinet curve poll differs from buildGraphCurvePoll');
  }
  let threw = false;
  try { buildGen3VisualCurvePoll(cab, FM3, 62, 4); } catch { threw = true; }
  if (!threw) fail('cabinet slot 4 accepted');
  threw = false;
  try { buildGen3VisualCurvePoll(gen3BlockVisual('INPUT', FM3)!, FM3, 1, 0); } catch { threw = true; }
  if (!threw) fail('meter-only family accepted a curve fetch');

  // 5 - curve matching + decode (Looper waveform included).
  const cabReply = curveReply(0x11, 62, 3);
  if (!isGen3VisualCurveResponse(cab, cabReply, 62, 3)) fail('cabinet curve reply rejected');
  if (isGen3VisualCurveResponse(cab, cabReply, 62, 2)) fail('cabinet curve matched the wrong slot');
  if (parseGen3VisualCurve(cab, cabReply).length !== GRAPH_CURVE_VALUE_COUNT) fail('cabinet curve value count');
  const waveReply = curveReply(0x11, 166, 0);
  if (!isGen3VisualCurveResponse(looper, waveReply, 166, 0)) fail('looper waveform reply rejected');
  if (parseGen3VisualCurve(looper, waveReply).length !== GRAPH_CURVE_VALUE_COUNT) fail('looper value count');

  // 6 - marker/meter poll delegates to the sub-0x19 builder and matches its reply.
  const markerPoll = buildGen3VisualValuePoll(comp, FM3, 46, 'COMP_XMARK');
  if (markerPoll.join(',') !== buildBlockMonitorPoll(46, 28, 0x11).join(',')) {
    fail('COMP_XMARK poll differs from buildBlockMonitorPoll');
  }
  const markerReply = stateReply(0x11, 46, 28, 0.25);
  if (!isGen3VisualValueResponse(comp, markerReply, 46, 'COMP_XMARK')) fail('COMP_XMARK reply rejected');
  if (isGen3VisualValueResponse(comp, markerReply, 46, 'COMP_GAINMONITOR')) fail('marker reply matched a meter');
  if (isGen3VisualValueResponse(comp, markerReply, 47, 'COMP_XMARK')) fail('marker reply matched the wrong eid');
  if (Math.abs(parseGen3VisualValue(markerReply) - 0.25) > 1e-6) fail('marker value decode');
  if (isGen3VisualValueResponse(comp, markerReply, 46, 'NOPE')) fail('unknown visual param matched');

  // 7 - meter dB mapping: normalized linear span, RMS 10*log10, clamping.
  const gainDb = gen3VisualMeterDb(compMeter, 0.25);
  if (gainDb !== -30) fail(`COMP_GAINMONITOR 0.25 -> ${gainDb}, expected -30`);
  const rmsDb = gen3VisualMeterDb(out1Fm3, 0.01);
  if (Math.abs((rmsDb ?? NaN) + 20) > 1e-6) fail(`OUTPUT_VUL 0.01 -> ${rmsDb}, expected -20`);
  if (gen3VisualMeterDb(out1Fm3, 100) !== 6) fail('RMS meter did not clamp to its ceiling');
  if (gen3VisualMeterDb(compMeter, -1) !== -40) fail('normalized meter did not clamp to its floor');
  if (gen3VisualMeterDb(compMarker, 0.5) !== null) fail('marker produced a dB value');

  // 8 - the family inventory is model-gated and covers curves and meter-only blocks.
  const familiesFm3 = gen3VisualFamilies(FM3);
  const familiesFm9 = gen3VisualFamilies(FM9);
  const familiesIii = gen3VisualFamilies(III);
  for (const required of ['CABINET', 'COMP', 'CONTROLLERS', 'GEQ', 'GLOBAL', 'INPUT', 'LOOPER', 'MULTICOMP', 'OUTPUT', 'RTA']) {
    if (!familiesFm3.includes(required)) fail(`FM3 family inventory missing ${required}`);
  }
  if (familiesFm3.includes('TONEMATCH') || familiesFm3.includes('DYNDIST')) fail('FM3 advertises a III-only family');
  if (familiesFm9.includes('TONEMATCH') || familiesFm9.includes('DYNDIST')) fail('FM9 advertises a III-only family');
  if (!familiesIii.includes('TONEMATCH') || !familiesIii.includes('DYNDIST')) fail('III inventory misses a III-only family');
  for (const families of [familiesFm3, familiesFm9, familiesIii]) {
    if (families.includes('CHORUS')) fail('CHORUS advertised without a graph widget');
    if (families.join(',') !== [...families].sort().join(',')) fail('family inventory is not sorted');
  }
  if (gen3BlockVisual('CHORUS', FM3) !== null) fail('CHORUS produced a descriptor');
  if (gen3BlockVisual('TONEMATCH', FM3) !== null) fail('TONEMATCH produced an FM3 descriptor');
  if (gen3BlockVisual('DYNDIST', FM9) !== null) fail('DYNDIST produced an FM9 descriptor');
  const globalFm3 = gen3BlockVisual('GLOBAL', FM3)!;
  const globalFm9 = gen3BlockVisual('GLOBAL', FM9)!;
  const globalIii = gen3BlockVisual('GLOBAL', III)!;
  if (globalFm3.curveSlots.join(',') !== '0,1') fail(`FM3 GLOBAL slots ${globalFm3.curveSlots.join(',')}`);
  if (globalFm9.curveSlots.join(',') !== '0,1,2') fail(`FM9 GLOBAL slots ${globalFm9.curveSlots.join(',')}`);
  if (globalIii.curveSlots.join(',') !== '0,1,2,3') fail(`III GLOBAL slots ${globalIii.curveSlots.join(',')}`);
  if (gen3BlockVisual('GEQ', FM3)!.curveSlots.join(',') !== '0') fail('GEQ slot 0 missing');
  if (gen3BlockVisual('MULTICOMP', FM3)!.curveSlots.join(',') !== '0') fail('MULTICOMP slot 0 missing');
  if (gen3BlockVisual('DYNDIST', III)!.curveSlots.join(',') !== '0') fail('III DYNDIST slot 0 missing');
}
