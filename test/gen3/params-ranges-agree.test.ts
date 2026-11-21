/**
 * Gen-3 params tables vs the device range rows (FM3 / FM9 / Axe-Fx III).
 *
 * The params tables (`src/gen3/<dev>/params.ts`) carry AM4-inferred display metadata;
 * the range tables (`<DEV>_RANGES`, `ranges.generated.ts`) are the device's own. Where
 * the two disagreed the params table was wrong (the amp "Out Compression" knob read
 * `percent 0..100` where the device shows 0..10, a drive knob `0.5..500` where it
 * shows 0..10, a feedback level `percent 0..100` where it runs -100..100), and every
 * consumer that falls back to the params-table bounds inherited the wrong scale. The
 * data generator now makes the range rows authoritative (reconcile step); this suite
 * pins the contract so the two cannot drift apart again, and pins what the consumers
 * (descriptor schema + encode, converter target ranges) do with the reconciled rows.
 *
 * Contract, per device, from the shipped tables only (no walk, no device):
 *   1. a params row with inline bounds whose device row is an enum, or a float row that
 *      carries a device label list (the 0/1 toggles), is the `enum` selector with no
 *      bounds; every other row with inline bounds whose range row is an informative float
 *      row (not an all-zero placeholder, not a typecode-0 stub) agrees with it;
 *   2. the integer -24..24 interval rows (typecode 0x10, scale 1) read `semitones`
 *      -24..24; the named selectors (pole count, mode / direction / curve pickers, DynaCab
 *      type and mic, the III global-mix toggles, ...) are `enum`;
 *   3. the named facts (examples of each reconciled class) hold on every device, bounds at
 *      the panel's two decimals, no AM4 log hint on the linear 0..10 knobs;
 *   4. typecode-0 stub rows are NOT trusted: they keep their params bounds.
 * Consumer behaviour (descriptor): bounds, unit and the display -> wire encode follow
 * the device-true values on all three devices, FM3 included (FM3 does not wire its
 * range table into the descriptor, so it reads the params table).
 */
import { PARAMS as AXE3_PARAMS, AXE3_RANGES, AXE3_ENUM_OVERRIDES } from '../../src/gen3/axe-fx-iii/index.js';
import { FM3_PARAMS, FM3_RANGES, FM3_ENUM_OVERRIDES } from '../../src/gen3/fm3/index.js';
import { FM9_PARAMS, FM9_RANGES, FM9_ENUM_OVERRIDES } from '../../src/gen3/fm9/index.js';
import type { Param } from '../../src/gen3/types.js';
import { createModernFractalDescriptor } from '../../src/devices/gen3/factory.js';
import { AXE_FX_III_CONFIG } from '../../src/devices/gen3/configs/axe-fx-iii.js';
import { FM3_CONFIG } from '../../src/devices/gen3/configs/fm3.js';
import { FM9_CONFIG } from '../../src/devices/gen3/configs/fm9.js';
import { resolveTargetRange } from '../../src/convert/targetRanges.js';
import type { ConverterDeviceId } from '../../src/convert/families.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[params-ranges-agree] ${msg}`);
}

interface RangeRow {
  readonly kind: 'enum' | 'float';
  readonly displayMin: number;
  readonly displayMax: number;
  readonly scale: number;
  readonly typecode: number;
  readonly enumCount?: number;
}
type RangeTable = Readonly<Record<string, Readonly<Record<number, RangeRow>>>>;

const close = (a: number, b: number): boolean =>
  a === b || Math.abs(a - b) <= 0.02 * Math.max(1e-9, Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-6;

/** Informative float row: real device data, not a placeholder or a typecode-0 stub. */
const informative = (r: RangeRow | undefined): r is RangeRow =>
  r !== undefined && r.kind === 'float' && r.displayMin !== r.displayMax && r.typecode !== 0;

interface Dev {
  readonly id: 'fm3' | 'fm9' | 'axe3';
  readonly label: string;
  readonly params: readonly Param[];
  readonly ranges: RangeTable;
  readonly lists: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  readonly desc: ReturnType<typeof createModernFractalDescriptor>;
  readonly converter: ConverterDeviceId;
}

const DEVS: readonly Dev[] = [
  { id: 'fm3', label: 'FM3', params: FM3_PARAMS, ranges: FM3_RANGES as unknown as RangeTable, lists: FM3_ENUM_OVERRIDES, desc: createModernFractalDescriptor(FM3_CONFIG), converter: 'fm3' },
  { id: 'fm9', label: 'FM9', params: FM9_PARAMS, ranges: FM9_RANGES as unknown as RangeTable, lists: FM9_ENUM_OVERRIDES, desc: createModernFractalDescriptor(FM9_CONFIG), converter: 'fm9' },
  { id: 'axe3', label: 'Axe-Fx III', params: AXE3_PARAMS, ranges: AXE3_RANGES as unknown as RangeTable, lists: AXE3_ENUM_OVERRIDES, desc: createModernFractalDescriptor(AXE_FX_III_CONFIG), converter: 'axe-fx-iii' },
];

function row(dev: Dev, name: string): Param {
  const p = dev.params.find((x) => x.name === name);
  assert(p !== undefined, `${dev.label}: ${name} missing from the params table`);
  return p!;
}

/** Named facts (every device): [param name, unit, displayMin, displayMax]. */
const FACTS: ReadonlyArray<readonly [string, Param['unit'], number, number]> = [
  ['DISTORT_COMPRESSION', 'knob_0_10', 0, 10], // was percent 0..100
  ['CHORUS_DRIVE', 'knob_0_10', 0, 10], // was 0.5..500 (log)
  ['ROTARY_DRIVE', 'knob_0_10', 0, 10], // was 0.5..500 (log)
  ['COMP_EMPHASIS', 'knob_0_10', 0, 10], // was knob_0_20 0..20
  ['COMP_LEVEL', 'db', -20, 20], // was -80..20
  ['DELAY_TIME', 'ms', 1, 16000], // was 0..8000
  ['DISTORT_BIAS', 'percent', 0, 100], // was knob_0_10 0..10
  ['DISTORT_VARIAC', 'percent', 50, 150], // was 0..100
  ['DISTORT_TRIODE1RATIO', 'bipolar_percent', -200, 200], // was percent 0..100
  ['PHASER_FEEDBACK', 'bipolar_percent', -99.99, 99.99], // was -90..90
  ['PHASER_TONE', 'numeric', -10, 10], // was knob_0_10 0..10; device -10.00014..10.00014 written at 2 decimals
  ['TREMOLO_WIDTH', 'percent', 0, 400], // was 0..100
  ['WAH_MIX', 'knob_0_10', 0, 10], // was percent 0..100
  ['REVERB_PREDELAY', 'ms', 0, 1000], // was 0..250
  ['PITCH_SHIFT1', 'semitones', -24, 24], // was numeric, no bounds
  ['PITCH_STEP16', 'semitones', -24, 24], // was numeric, no bounds
];

/** Extra III facts (rows the FM3/FM9 caches carry as placeholders). */
const AXE3_FACTS: ReadonlyArray<readonly [string, Param['unit'], number, number]> = [
  ['DELAY_FEEDL', 'bipolar_percent', -100, 100], // was percent 0..100
  ['MULTITAP_FEEDBACK12', 'bipolar_percent', -100, 100],
  ['PLEX_GLOBALMIX', 'numeric', 0, 1], // 0/1 toggle without a device label list, was percent 0..100
  ['FDBKSEND_SENDLEVEL', 'percent', 0, 100], // was db -80..20
  ['PLEX_SHIFT1', 'semitones', -24, 24],
  ['SYNTH_SHIFT3', 'semitones', -24, 24],
];

/** Named selectors (unit 'enum', no bounds) on every device: the device row is an enum. */
const SELECTORS: readonly string[] = [
  'PHASER_ORDER', 'PHASER_MODE', 'PHASER_DIRECTION', 'PHASER_VCR_CURVE', 'FILTER_ORDER',
  'REVERB_PITCHDIR', 'REVERB_PITCHPOS',
  'CABINET_DYNACAB_TYPE1', 'CABINET_DYNACAB_TYPE2', 'CABINET_DYNACAB_MIC1', 'CABINET_DYNACAB_MIC2',
];
/** Extra III selectors: the global-mix toggles that carry an OFF/ON label list, an enum behind a 0..127 bound, old flanger filters. */
const AXE3_SELECTORS: readonly string[] = [
  'GLOBAL_METRONOME_CC', 'FLANGER_OLD_DRY_LPFREQ', 'FLANGER_OLD_DRY_HPFREQ',
  'REVERB_GLOBALMIX', 'DELAY_GLOBALMIX', 'PEQ_GLOBALMIX', 'CHORUS_GLOBALMIX', 'PHASER_GLOBALMIX', 'SYNTH_GLOBALMIX',
];
/** Knobs whose AM4 log10 hint contradicts the measured linear taper (typecode 0x52), even though their bounds were right. */
const LINEAR_KNOBS: readonly string[] = ['DISTORT_CLARITY', 'FLANGER_DRIVE', 'WAH_DRIVE'];

const cases: Array<() => void> = [];

for (const dev of DEVS) {
  // 1. The contract: no device row is contradicted by an inline params bound.
  cases.push(() => {
    const offenders: string[] = [];
    let compared = 0;
    for (const p of dev.params) {
      if (p.unit === 'enum' || p.displayMin === undefined || p.displayMax === undefined) continue;
      const r = dev.ranges[p.family]?.[p.paramId];
      const list = dev.lists[p.family]?.[String(p.paramId)];
      if (r !== undefined && (r.kind === 'enum' || (r.kind === 'float' && list !== undefined))) {
        offenders.push(`${p.name} ${p.unit} ${p.displayMin}..${p.displayMax} but the device row is an enum / carries a label list: must be 'enum', no bounds`);
        continue;
      }
      if (!informative(r)) continue;
      compared += 1;
      if (!(close(p.displayMin, r.displayMin) && close(p.displayMax, r.displayMax))) {
        offenders.push(`${p.name} ${p.unit} ${p.displayMin}..${p.displayMax} vs device ${r.displayMin}..${r.displayMax}`);
      }
    }
    assert(compared > 100, `${dev.label}: only ${compared} rows compared — table wiring broken?`);
    assert(offenders.length === 0, `${dev.label}: params rows contradict their device range row:\n  ${offenders.join('\n  ')}`);
  });

  // 2. Interval rows + the pole selector.
  cases.push(() => {
    let semis = 0;
    for (const p of dev.params) {
      const r = dev.ranges[p.family]?.[p.paramId];
      if (r === undefined || r.kind !== 'float' || r.typecode !== 0x10 || r.scale !== 1) continue;
      if (r.displayMin !== -24 || r.displayMax !== 24) continue;
      semis += 1;
      assert(
        p.unit === 'semitones' && p.displayMin === -24 && p.displayMax === 24,
        `${dev.label}: ${p.name} is the device's -24..24 semitone span but reads ${p.unit} ${p.displayMin}..${p.displayMax}`,
      );
    }
    assert(semis >= 30, `${dev.label}: expected the interval rows (pitch/plex/synth/steps), found ${semis}`);
    for (const name of dev.id === 'axe3' ? [...SELECTORS, ...AXE3_SELECTORS] : SELECTORS) {
      const sel = row(dev, name);
      assert(
        sel.unit === 'enum' && sel.displayMin === undefined && sel.displayMax === undefined,
        `${dev.label}: ${name} must be an enum selector, got ${sel.unit} ${sel.displayMin}..${sel.displayMax}`,
      );
    }
  });

  // 3. Named facts.
  cases.push(() => {
    const facts = dev.id === 'axe3' ? [...FACTS, ...AXE3_FACTS] : FACTS;
    for (const [name, unit, lo, hi] of facts) {
      const p = row(dev, name);
      assert(
        p.unit === unit && p.displayMin === lo && p.displayMax === hi,
        `${dev.label}: ${name} expected ${unit} ${lo}..${hi}, got ${p.unit} ${p.displayMin}..${p.displayMax}`,
      );
    }
    // a linear device knob carries no AM4 log hint, a log-style time keeps its (positive) one
    assert(row(dev, 'CHORUS_DRIVE').scaling === undefined && row(dev, 'ROTARY_DRIVE').scaling === undefined,
      `${dev.label}: the 0..10 drive knobs must not keep the AM4 log10 hint`);
    assert(row(dev, 'GATE_RELEASE').scaling === 'log10' && row(dev, 'GATE_RELEASE').displayMin! > 0,
      `${dev.label}: GATE_RELEASE keeps log10 over a positive range`);
    for (const name of LINEAR_KNOBS) {
      const p = dev.params.find((x) => x.name === name);
      if (p === undefined) continue; // not on this device
      assert(p.scaling === undefined, `${dev.label}: ${name} is a linear 0..10 knob and must not keep the AM4 log10 hint`);
    }
    // written bounds sit at the panel's two decimals
    for (const p of dev.params) {
      for (const v of [p.displayMin, p.displayMax]) {
        if (v !== undefined) assert(Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 || Math.abs(v) < 0.01, `${dev.label}: ${p.name} bound ${v} has more than 2 decimals`);
      }
    }
  });

  // 4. Typecode-0 stubs are not trusted (their 0..1 / 0..50 is a placeholder, not a device range).
  cases.push(() => {
    const keep: ReadonlyArray<readonly [string, Param['unit'], number, number]> =
      dev.id === 'fm3'
        ? []
        : dev.id === 'fm9'
          ? [['CROSSOVER_MIX', 'percent', 0, 100]]
          : [
              ['DISTORT_DYNPRES', 'knob_0_10', 0, 10],
              ['DISTORT_DYNDEPTH', 'knob_0_10', 0, 10],
              ['DISTORT_XFLEAKAGE', 'percent', 0, 100],
              ['CROSSOVER_MIX', 'percent', 0, 100],
            ];
    for (const [name, unit, lo, hi] of keep) {
      const p = row(dev, name);
      const r = dev.ranges[p.family]?.[p.paramId];
      assert(r !== undefined && r.kind === 'float' && r.typecode === 0 && r.displayMin !== r.displayMax,
        `${dev.label}: ${name} is expected to be a typecode-0 stub row (fixture assumption)`);
      assert(p.unit === unit && p.displayMin === lo && p.displayMax === hi,
        `${dev.label}: ${name} (typecode-0 stub ${r!.displayMin}..${r!.displayMax}) must keep its params bounds ${unit} ${lo}..${hi}, got ${p.unit} ${p.displayMin}..${p.displayMax}`);
    }
  });

  // 5. Descriptor: schema bounds + unit + display -> wire encode follow the device-true values.
  cases.push(() => {
    const blk = dev.desc.blocks;
    const sch = (b: string, p: string) => {
      const s = blk[b]?.params[p];
      assert(s !== undefined, `${dev.label}: ${b}.${p} missing from the descriptor`);
      return s!;
    };
    const comp = sch('amp', 'compression');
    assert(comp.unit === 'knob_0_10' && comp.display_min === 0 && comp.display_max === 10,
      `${dev.label}: amp.compression schema ${comp.unit} ${comp.display_min}..${comp.display_max}, expected knob_0_10 0..10`);
    assert(comp.encode(0) === 0 && comp.encode(10) === 65534, `${dev.label}: amp.compression must span the whole wire over 0..10`);
    assert(Math.abs((comp.encode(5) as number) - 32767) <= 1, `${dev.label}: amp.compression 5 must sit at mid-scale`);
    let threw = false;
    try { comp.encode(50); } catch { threw = true; }
    assert(threw, `${dev.label}: amp.compression 50 (the old percent scale) must be refused as out of range`);

    const drive = sch('chorus', 'drive');
    assert(drive.display_min === 0 && drive.display_max === 10 && Math.abs((drive.encode(5) as number) - 32767) <= 1,
      `${dev.label}: chorus.drive must be a linear 0..10 knob`);

    const time = sch('delay', 'time');
    assert(time.unit === 'ms' && time.display_min === 1 && time.display_max === 16000,
      `${dev.label}: delay.time schema ${time.unit} ${time.display_min}..${time.display_max}, expected ms 1..16000`);
    assert(time.encode(1) === 0 && time.encode(16000) === 65534, `${dev.label}: delay.time must span the wire over 1..16000 ms`);

    const fb = sch('phaser', 'feedback');
    assert(fb.unit === 'bipolar_percent' && fb.display_min === -99.99 && fb.display_max === 99.99,
      `${dev.label}: phaser.feedback schema ${fb.unit} ${fb.display_min}..${fb.display_max}`);

    const shift = sch('pitch', 'shift1');
    assert(shift.unit === 'semitones' && shift.display_min === -24 && shift.display_max === 24,
      `${dev.label}: pitch.shift1 schema ${shift.unit} ${shift.display_min}..${shift.display_max}`);
    assert(shift.encode(-24) === 0 && shift.encode(24) === 65534 && Math.abs((shift.encode(0) as number) - 32767) <= 1,
      `${dev.label}: pitch.shift1 must map -24..24 semitones linearly onto the wire`);
  });

  // 6. Converter: the range (already device-true) and the UNIT SYMBOL now agree with it.
  cases.push(() => {
    const comp = resolveTargetRange(dev.converter, 'amp', 'compression');
    assert(comp?.min === 0 && comp.max === 10 && comp.unit === undefined,
      `${dev.label}: converter amp.compression expected a unitless 0..10 knob, got ${JSON.stringify(comp)}`);
    const shift = resolveTargetRange(dev.converter, 'pitch', 'shift1');
    assert(shift?.min === -24 && shift.max === 24 && shift.unit === 'st',
      `${dev.label}: converter pitch.shift1 expected -24..24 st, got ${JSON.stringify(shift)}`);
    const tri = resolveTargetRange(dev.converter, 'amp', 'triode1ratio');
    assert(tri?.min === -200 && tri.max === 200 && tri.unit === '%',
      `${dev.label}: converter amp.triode1ratio expected -200..200 %, got ${JSON.stringify(tri)}`);
  });
}

export const PARAMS_RANGES_AGREE_CASE_COUNT = cases.length;

export function runParamsRangesAgreeTests(): void {
  for (const c of cases) c();
}
