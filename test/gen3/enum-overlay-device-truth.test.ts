/**
 * Gen-3 enum label overlay vs the device label lists (FM3 / FM9 / Axe-Fx III).
 *
 * The curated overlay (`enumOverlay.ts`: suffix vocabularies, direct entries, the
 * effect-type tables) is a FALLBACK for parameters that have no device list. Every
 * device ships a complete label list per enum parameter (`*_ENUM_OVERRIDES`); the
 * descriptor catalog uses such a list as the whole vocabulary. This suite fails if an
 * overlay entry contradicts a complete device list again, and pins the runtime
 * contract that makes the device list win without leaking overlay labels past its end.
 *
 *   1. AUDIT (data): for every parameter with a complete device list (list length ==
 *      the device range row's enumCount), the full overlay (`resolveEnumValues`) and
 *      the strict effect-type overlay (`resolveEffectTypeEnum`) either have no entry or
 *      agree label-for-label and never extend past the device's last ordinal.
 *   2. RUNTIME (descriptor, all three devices): the schema's `enum_values` of such a
 *      parameter IS the device list, exactly (no overlay or roster labels beyond it),
 *      so decode/encode follow the unit: unit 'enum', discrete. The table is dated to
 *      one firmware (a newer one appends models: FM3 fw 13 has amp 336 / drive 87 /
 *      chorus 27), so the vocabulary stays 'partial' and a numeric ordinal past the last
 *      label is ACCEPTED, never refused (a static catalog cannot tell the connected
 *      unit's firmware).
 *   3. The retired entries stay retired; the corrected vocabularies (LFO waveforms,
 *      tempo divisions, delay routing, phaser poles) are device-true.
 *   4. Merge rule: a complete device table replaces (no foreign labels; unbounded, partial); a sparse
 *      (captured-points) or short one still merges over the overlay as 'partial'; the VP4,
 *      which has no device lists, keeps its explicit unverified fallback (incl. the delay
 *      routing selector, discrete) and nothing else.
 */
import { PARAMS as AXE3_PARAMS, AXE3_RANGES, AXE3_ENUM_OVERRIDES, resolveEnumValues, resolveEffectTypeEnum } from '../../src/gen3/axe-fx-iii/index.js';
import { FM3_PARAMS, FM3_PARAMS_BY_FAMILY, FM3_RANGES, FM3_ENUM_OVERRIDES } from '../../src/gen3/fm3/index.js';
import { FM9_PARAMS, FM9_PARAMS_BY_FAMILY, FM9_RANGES, FM9_ENUM_OVERRIDES } from '../../src/gen3/fm9/index.js';
import type { Param } from '../../src/gen3/types.js';
import { createModernFractalDescriptor } from '../../src/devices/gen3/factory.js';
import { toSymbolEnumOverrides } from '../../src/devices/gen3/catalog.js';
import { AXE_FX_III_CONFIG } from '../../src/devices/gen3/configs/axe-fx-iii.js';
import { FM3_CONFIG } from '../../src/devices/gen3/configs/fm3.js';
import { FM9_CONFIG } from '../../src/devices/gen3/configs/fm9.js';
import { VP4_CONFIG } from '../../src/devices/gen3/configs/vp4.js';
import type { DeviceDescriptor, ParamSchema } from '../../src/core/protocol-generic/types.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[enum-overlay-device-truth] ${msg}`);
}

type RangeTable = Readonly<Record<string, Readonly<Record<number, { kind: 'enum' | 'float'; enumCount?: number }>>>>;
type ListTable = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

interface Dev {
  readonly label: string;
  readonly params: readonly Param[];
  readonly ranges: RangeTable;
  readonly lists: ListTable;
  readonly desc: DeviceDescriptor;
}

const DEVS: readonly Dev[] = [
  { label: 'FM3', params: FM3_PARAMS, ranges: FM3_RANGES as unknown as RangeTable, lists: FM3_ENUM_OVERRIDES, desc: createModernFractalDescriptor(FM3_CONFIG) },
  { label: 'FM9', params: FM9_PARAMS, ranges: FM9_RANGES as unknown as RangeTable, lists: FM9_ENUM_OVERRIDES, desc: createModernFractalDescriptor(FM9_CONFIG) },
  { label: 'Axe-Fx III', params: AXE3_PARAMS, ranges: AXE3_RANGES as unknown as RangeTable, lists: AXE3_ENUM_OVERRIDES, desc: createModernFractalDescriptor(AXE_FX_III_CONFIG) },
];

/** [param, complete device list] for every enum parameter whose list covers its whole range. */
function completeLists(dev: Dev): Array<{ p: Param; list: readonly string[] }> {
  const out: Array<{ p: Param; list: readonly string[] }> = [];
  for (const p of dev.params) {
    const r = dev.ranges[p.family]?.[p.paramId];
    const list = dev.lists[p.family]?.[String(p.paramId)];
    if (r === undefined || r.kind !== 'enum' || list === undefined || list.length !== r.enumCount) continue;
    out.push({ p, list });
  }
  return out;
}

function bySymbol(desc: DeviceDescriptor): Map<string, ParamSchema> {
  const out = new Map<string, ParamSchema>();
  for (const block of Object.values(desc.blocks)) {
    for (const schema of Object.values(block.params)) {
      const name = schema.parameter_name;
      if (typeof name === 'string' && !out.has(name)) out.set(name, schema);
    }
  }
  return out;
}

const cases: Array<() => void> = [];

for (const dev of DEVS) {
  const complete = completeLists(dev);

  // 1. AUDIT: no overlay entry contradicts (or extends past) a complete device list.
  cases.push(() => {
    assert(complete.length > 400, `${dev.label}: only ${complete.length} complete device lists — table wiring broken?`);
    const offenders: string[] = [];
    for (const { p, list } of complete) {
      for (const [tag, entry] of [['overlay', resolveEnumValues(p.name)], ['effect-type', resolveEffectTypeEnum(p.name)]] as const) {
        if (entry === undefined) continue;
        const bad: string[] = [];
        for (const [ordStr, label] of Object.entries(entry.values)) {
          const ord = Number(ordStr);
          if (ord >= list.length) bad.push(`${ord}:${JSON.stringify(label)} past the device end (${list.length})`);
          else if (list[ord] !== label) bad.push(`${ord}:${JSON.stringify(label)} != device ${JSON.stringify(list[ord])}`);
        }
        if (bad.length > 0) offenders.push(`${p.name} (${tag}): ${bad.slice(0, 3).join(' | ')}${bad.length > 3 ? ` (+${bad.length - 3})` : ''}`);
      }
    }
    assert(offenders.length === 0, `${dev.label}: overlay entries contradict a complete device list:\n  ${offenders.join('\n  ')}`);
  });

  // 2. RUNTIME: the schema vocabulary of such a parameter IS the device list.
  cases.push(() => {
    const schemas = bySymbol(dev.desc);
    let checked = 0;
    const offenders: string[] = [];
    for (const { p, list } of complete) {
      const s = schemas.get(p.name);
      if (s === undefined) continue; // block not exposed on this device
      const values = s.enum_values;
      if (values === undefined) { offenders.push(`${p.name}: no enum_values`); continue; }
      checked += 1;
      const keys = Object.keys(values).map(Number);
      if (keys.length !== list.length) offenders.push(`${p.name}: ${keys.length} labels, device list has ${list.length}`);
      else if (list.some((label, i) => values[i] !== label)) offenders.push(`${p.name}: labels differ from the device list`);
      else {
        if (s.decode(0) !== list[0] || s.decode(list.length - 1) !== list[list.length - 1]) offenders.push(`${p.name}: decode`);
        // a numeric-looking label ('12' poles) is taken as an ordinal by encode — only named labels resolve by name
        const last = list[list.length - 1]!;
        if (!Number.isFinite(Number(last)) && s.encode(last) !== list.length - 1) offenders.push(`${p.name}: encode(last)`);
        if (s.encode(list.length - 1) !== list.length - 1) offenders.push(`${p.name}: encode(ordinal)`);
        // a complete device list is the whole vocabulary of LABELS, but it is dated to one firmware:
        // ordinals past it are accepted (a newer firmware appends entries), the vocabulary is partial
        let past: unknown;
        try { past = s.encode(list.length); } catch { past = 'refused'; }
        if (past !== list.length) offenders.push(`${p.name}: ordinal ${list.length} (past the static list) must be accepted, got ${String(past)}`);
        if (s.enum_partial !== true) offenders.push(`${p.name}: a static device list must stay 'partial'`);
        if (s.unit !== 'enum') offenders.push(`${p.name}: unit ${s.unit}, expected 'enum' for a labelled parameter`);
        if (s.wire_kind !== 'discrete') offenders.push(`${p.name}: wire_kind ${s.wire_kind}`);
      }
    }
    assert(checked > 300, `${dev.label}: only ${checked} enum schemas matched a device list`);
    assert(offenders.length === 0, `${dev.label}: schema vocabulary is not the device list:\n  ${offenders.slice(0, 12).join('\n  ')}`);
  });
}

// 3a. Corrected vocabularies are the device's, on every device.
cases.push(() => {
  const lfo = ['SINE', 'TRIANGLE', 'SQUARE', 'SAW UP', 'SAW DOWN', 'RANDOM', 'LOG', 'EXP', 'TRAPEZOID', 'ASTABLE'];
  const lfoOverlay = resolveEnumValues('CHORUS_LFOTYPE')!.values;
  assert(lfo.every((l, i) => lfoOverlay[i] === l) && Object.keys(lfoOverlay).length === 10, 'LFO waveform overlay is the device list');
  const tempo = resolveEnumValues('DELAY_TEMPO')!.values;
  assert(Object.keys(tempo).length === 79 && tempo[0] === 'NONE ' && tempo[1] === '1/64 TRIP' && tempo[78] === '63/64', 'tempo overlay is the 79-entry device table');
  const pitch = resolveEnumValues('PITCH_TEMPO')!.values;
  assert(Object.keys(pitch).length === 78 && pitch[0] === '1/64 TRIP' && pitch[77] === '63/64', 'PITCH_TEMPO is the table without NONE');
  const routing = resolveEnumValues('DELAY_TYPE')!.values;
  assert(Object.keys(routing).length === 8 && routing[0] === 'MONO' && routing[2] === 'PING-PONG' && routing[7] === 'SURROUND', 'DELAY_TYPE overlay is the routing list');
  const order = resolveEnumValues('PHASER_ORDER')!.values;
  assert([0, 1, 2, 3, 4, 5].map((i) => order[i]).join() === '2,4,6,8,10,12' && order[6] === undefined, 'PHASER_ORDER overlay is the pole list');
  // every tempo / LFO label list of every device equals the overlay table (same table on all of them)
  for (const dev of DEVS) {
    for (const { p, list } of completeLists(dev)) {
      if (/_LFO[0-9]?TYPE$/.test(p.name)) assert(list.join('|') === lfo.join('|'), `${dev.label}: ${p.name} is not the shared LFO list`);
      if (/_TEMPO$/.test(p.name) && p.name !== 'PITCH_TEMPO') assert(list.join('|') === Object.values(tempo).join('|'), `${dev.label}: ${p.name} is not the shared tempo table`);
    }
  }
});

// 3b. Retired entries stay retired; the audited survivors still resolve.
cases.push(() => {
  const retired = [
    'REVERB_TYPE', 'CHORUS_TYPE', 'FLANGER_TYPE', 'COMP_TYPE', 'FUZZ_TYPE',
    'GLOBAL_CABINETBYP', 'GLOBAL_PWRAMPBYP', 'GLOBAL_TUNERMUTE', 'GLOBAL_DELAYSPILL', 'REVERB_NUMSPRINGS',
    'DISTORT_INPUTSELECT', 'VOLUME_INPUTSELECT', 'CHORUS_AUTO', 'FLANGER_AUTO', 'FLANGER_OLD_AUTO', 'OLD_FLANGER_AUTO',
    'CABINET_MUTE1', 'CABINET_MUTE4', 'MULTICOMP_MUTE1', 'MOD_CHANNEL', 'GLOBAL_MIDI_CHAN', 'GLOBAL_CS1_ENABLE',
    'DELAY_HOLD', 'PLEX_HOLD',
  ];
  for (const name of retired) assert(resolveEnumValues(name) === undefined, `${name}: retired overlay entry is back`);
  assert(resolveEffectTypeEnum('REVERB_TYPE') === undefined && resolveEffectTypeEnum('DELAY_TYPE') === undefined, 'effect-type overlay: REVERB_TYPE / DELAY_TYPE retired');
  // survivors (consistent with every device list that exists)
  for (const name of ['PHASER_TYPE', 'WAH_TYPE', 'GEQ_TYPE', 'FILTER_TYPE', 'TREMOLO_TYPE', 'ENHANCER_TYPE', 'GATE_TYPE', 'REVERB_HOLD', 'COMP_AUTO', 'MULTICOMP_AUTO', 'REVERB_INPUTSELECT', 'GLOBAL_USETUNEOFFSETS']) {
    assert(resolveEnumValues(name) !== undefined, `${name}: audited overlay entry is missing`);
  }
  assert(resolveEnumValues('REVERB_INPUTSELECT')!.values[0] === 'L+R', 'stereo input-select vocabulary kept for the stereo blocks');
});

// 3c. Newer firmware appends models (FM3 fw 13: amp 331 -> 336, drive 86 -> 87, chorus 18 -> 27): the static
//     descriptors must still accept those ordinals, on every device.
cases.push(() => {
  for (const dev of DEVS) {
    for (const [block, key, past] of [['amp', 'type', 400], ['drive', 'type', 100], ['chorus', 'type', 40], ['flanger', 'type', 40], ['wah', 'type', 20], ['reverb', 'type', 100], ['delay', 'model', 40]] as const) {
      const schema = dev.desc.blocks[block]?.params[key];
      assert(schema !== undefined, `${dev.label}: ${block}.${key} missing`);
      assert(schema!.encode(past) === past, `${dev.label}: ${block}.${key} must accept ordinal ${past} (newer firmware)`);
      assert(schema!.enum_partial === true, `${dev.label}: ${block}.${key} is a static, firmware-dated list: partial`);
    }
  }
});

// 4a. Merge rule: a complete device table replaces; a sparse or short one merges over the overlay.
cases.push(() => {
  // FM3 passes no enum row to the catalog, so its tables are judged by contiguity alone.
  const base3 = toSymbolEnumOverrides(FM3_PARAMS_BY_FAMILY, FM3_ENUM_OVERRIDES);
  const fm3 = (table: Readonly<Record<number, string>>) =>
    createModernFractalDescriptor({ ...FM3_CONFIG, enum_overrides: { ...base3, DELAY_TYPE: table } }).blocks['delay']!.params['type']!;
  const complete = fm3({ 0: 'A', 1: 'B' });
  assert(Object.keys(complete.enum_values!).length === 2, 'a complete device table must not gain overlay labels past its end');
  assert(complete.decode(7) === 7, 'ordinals past the device list decode as numbers');
  assert(complete.encode(1) === 1 && complete.encode(2) === 2, 'a static table never refuses a numeric ordinal past its last label (newer firmware appends entries)');
  assert(complete.enum_partial === true && complete.unit === 'enum' && complete.wire_kind === 'discrete', 'a static complete table is a discrete enum vocabulary, partial (dated to one firmware)');
  const sparse = fm3({ 0: 'A', 5: 'F' });
  assert(sparse.enum_values![0] === 'A' && sparse.enum_values![5] === 'F' && sparse.enum_values![7] === 'SURROUND',
    'a sparse (captured points) table is merged over the overlay: device points win, the rest fills in');
  assert(sparse.enum_partial === true && sparse.encode(7) === 7, 'a sparse table stays partial, ordinals are not bounded');
  // a table SHORTER than the device row's enumCount (FM9 reports 8 delay routings) is not complete either
  const base9 = toSymbolEnumOverrides(FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES);
  const fm9Short = createModernFractalDescriptor({ ...FM9_CONFIG, enum_overrides: { ...base9, DELAY_TYPE: { 0: 'A', 1: 'B' } } }).blocks['delay']!.params['type']!;
  assert(fm9Short.enum_values![1] === 'B' && fm9Short.enum_values![7] === 'SURROUND' && fm9Short.enum_partial === true,
    'a table that does not cover the device row enumCount is merged and partial, not "complete"');
});

// 4b. VP4 (no device lists): the explicit unverified fallback; the routing selector stays discrete.
cases.push(() => {
  const vp4 = createModernFractalDescriptor(VP4_CONFIG);
  const rev = vp4.blocks['reverb']!.params['type']!;
  assert(rev.enum_values !== undefined && typeof rev.enum_values[16] === 'string' && rev.enum_partial === true && rev.wire_kind === 'discrete',
    'VP4 reverb type keeps its AM4-heritage labels (unverified: partial, discrete) - no device list exists');
  const delay = vp4.blocks['delay']!.params['type']!;
  assert(delay.wire_kind === 'discrete', 'VP4 delay type (a discrete selector) must not become a continuous SET');
  assert(delay.enum_values !== undefined && Object.keys(delay.enum_values).length === 8 && delay.enum_values[0] === 'MONO' && delay.enum_values[7] === 'SURROUND',
    'VP4 delay type is the routing list, not the AM4 delay-model labels');
  assert(delay.encode(2) === 2 && delay.encode('PING-PONG') === 2 && delay.unit === 'enum' && delay.enum_partial === true,
    'VP4 delay type set-by-name / ordinal resolves (partial: ordinals are not bounded)');
  assert(vp4.blocks['phaser']!.params['type']!.enum_values !== undefined, 'VP4 phaser type keeps the audited overlay labels');
});

export const ENUM_OVERLAY_DEVICE_TRUTH_CASE_COUNT = cases.length;

export function runEnumOverlayDeviceTruthTests(): void {
  for (const c of cases) c();
}
