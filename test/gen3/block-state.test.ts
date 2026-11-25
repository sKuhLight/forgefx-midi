/**
 * Gen-3 block-state params (Scene Ignore + Bypass Mode) goldens.
 *
 * `blockStateParams(model, family)` resolves `<FAMILY>_SCENEIGNORE` and
 * `<FAMILY>_BYPASSMODE` BY NAME in the model's own catalog. This suite pins:
 *   1. the per-device ids that differ (FM9's shared block header id 6 vs the
 *      FM3's 83 / 137 / 51 vs the Axe-Fx III's 83 / 135 / 60) — no id leaks
 *      across model bytes;
 *   2. every catalog family with a `_SCENEIGNORE` / `_BYPASSMODE` row resolves,
 *      to exactly that row (27 Scene Ignore families per model);
 *   3. the Scene Ignore firmware gates (model-wide + RINGMOD / MULTIPLEXER),
 *      cross-checked against every control-level `fw.gtet` in the package's
 *      `*_LAYOUTS` data, and Bypass Mode carrying no gate;
 *   4. models without writable block-state params resolve to nothing (VP4 —
 *      whose catalog names Scene Ignore but whose discrete writes are not
 *      decoded — AM4, gen-2, gen-1), unknown families too;
 *   5. which bypass-mode labels silence a block, and that every bypass-mode
 *      label list in the shipped catalogs stays inside the known vocabulary;
 *   6. the firmware comparison + display helpers.
 */
import {
  blockStateParams,
  hasBlockStateParams,
  firmwareAtLeast,
  formatBlockStateFirmware,
  BLOCK_STATE_MODELS,
  isMutingBypassMode,
  mutingBypassOrdinals,
  MUTING_BYPASS_MODES,
  type BlockStateFirmware,
} from '../../src/devices/gen3/index.js';
import { FM3_PARAMS, FM3_LAYOUTS, FM3_ENUM_OVERRIDES } from '../../src/gen3/fm3/index.js';
import { FM9_PARAMS, FM9_LAYOUTS, FM9_ENUM_OVERRIDES } from '../../src/gen3/fm9/index.js';
import { PARAMS as AXE3_PARAMS, AXE3_LAYOUTS, AXE3_ENUM_OVERRIDES } from '../../src/gen3/axe-fx-iii/index.js';
import { VP4_PARAMS } from '../../src/gen3/vp4/index.js';
import type { DeviceEditorLayouts } from '../../src/editorLayouts.js';

export const BLOCK_STATE_CASE_COUNT = 6;

const AXE3 = 0x10;
const FM3 = 0x11;
const FM9 = 0x12;
const VP4 = 0x14;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[block-state] ${msg}`);
}
function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`[block-state] ${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

interface CatalogRow { family: string; paramId: number; name: string }
interface Device {
  label: string;
  model: number;
  params: readonly CatalogRow[];
  layouts: DeviceEditorLayouts;
  enums: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}
const DEVICES: Device[] = [
  { label: 'Axe-Fx III', model: AXE3, params: AXE3_PARAMS, layouts: AXE3_LAYOUTS, enums: AXE3_ENUM_OVERRIDES },
  { label: 'FM3', model: FM3, params: FM3_PARAMS, layouts: FM3_LAYOUTS, enums: FM3_ENUM_OVERRIDES },
  { label: 'FM9', model: FM9, params: FM9_PARAMS, layouts: FM9_LAYOUTS, enums: FM9_ENUM_OVERRIDES },
];

const fwKey = (v: BlockStateFirmware | undefined): string => (v ? formatBlockStateFirmware(v) : 'none');
/** A layout firmware gate `"maj,min"` (minor 0..99, `"5,3"` == `"5,03"`) as a firmware version. */
function parseGate(s: string): BlockStateFirmware {
  const [maj, min] = s.split(',');
  return { major: Number(maj), minor: Number(min ?? 0) };
}
const fwCompare = (a: BlockStateFirmware, b: BlockStateFirmware): number => (a.major - b.major) || (a.minor - b.minor);

function caseDeviceIds(): void {
  const want: Record<number, Record<string, number>> = {
    [FM9]: { DELAY: 6, DISTORT: 6, REVERB: 6 },
    [FM3]: { DELAY: 83, DISTORT: 137, REVERB: 51, CABINET: 84 },
    [AXE3]: { DELAY: 83, DISTORT: 135, REVERB: 60 },
  };
  for (const [model, fams] of Object.entries(want)) {
    for (const [family, pid] of Object.entries(fams)) {
      eq(blockStateParams(Number(model), family).sceneIgnore?.paramId, pid, `model 0x${Number(model).toString(16)} ${family} Scene Ignore id`);
    }
  }
  // the same family resolves differently per model byte — a III id never answers for an FM3
  assert(blockStateParams(FM3, 'DISTORT').sceneIgnore!.paramId !== blockStateParams(AXE3, 'DISTORT').sceneIgnore!.paramId, 'FM3 vs III DISTORT ids differ');
  assert(blockStateParams(FM9, 'REVERB').sceneIgnore!.paramId !== blockStateParams(FM3, 'REVERB').sceneIgnore!.paramId, 'FM9 vs FM3 REVERB ids differ');
  // Bypass Mode ids are per device too (FM3 DISTORT 3 vs III 23)
  eq(blockStateParams(FM3, 'DISTORT').bypassMode?.paramId, 3, 'FM3 DISTORT bypass mode id');
  eq(blockStateParams(AXE3, 'DISTORT').bypassMode?.paramId, 23, 'III DISTORT bypass mode id');
  eq(blockStateParams(FM9, 'REVERB').bypassMode?.paramId, 3, 'FM9 REVERB bypass mode id');
  eq(blockStateParams(FM3, 'REVERB').bypassMode?.paramId, 16, 'FM3 REVERB bypass mode id');
  // family case is normalised; the shared-id FLANGER row resolves to the current symbol, not the OLD_ alias
  eq(blockStateParams(FM3, 'distort').sceneIgnore?.paramId, 137, 'lower-case family');
  eq(blockStateParams(FM3, 'FLANGER').bypassMode?.name, 'FLANGER_BYPASSMODE', 'FLANGER resolves its own symbol');
}

function caseEveryFamilyResolves(): void {
  for (const d of DEVICES) {
    let si = 0;
    let bm = 0;
    for (const row of d.params) {
      if (row.name === `${row.family}_SCENEIGNORE`) {
        si++;
        const got = blockStateParams(d.model, row.family).sceneIgnore;
        assert(!!got, `${d.label} ${row.family}: Scene Ignore resolves`);
        eq(got!.paramId, row.paramId, `${d.label} ${row.family}: Scene Ignore id is the catalog row`);
        eq(got!.name, row.name, `${d.label} ${row.family}: Scene Ignore symbol`);
      }
      if (row.name === `${row.family}_BYPASSMODE`) {
        bm++;
        const got = blockStateParams(d.model, row.family).bypassMode;
        assert(!!got, `${d.label} ${row.family}: Bypass Mode resolves`);
        eq(got!.paramId, row.paramId, `${d.label} ${row.family}: Bypass Mode id is the catalog row`);
      }
    }
    eq(si, 27, `${d.label}: Scene Ignore families`);
    assert(bm >= 36, `${d.label}: at least 36 Bypass Mode families (got ${bm})`);
    // a family without the row resolves without the key
    const vol = blockStateParams(d.model, 'VOLUME');
    eq(vol.sceneIgnore, undefined, `${d.label} VOLUME has no Scene Ignore`);
    assert(!!vol.bypassMode, `${d.label} VOLUME has a bypass mode`);
    const enh = blockStateParams(d.model, 'ENHANCER');
    assert(!!enh.sceneIgnore && enh.bypassMode === undefined, `${d.label} ENHANCER: Scene Ignore but no bypass mode`);
  }
}

function caseFirmwareGates(): void {
  const expected: Record<number, { all: string; extra: Record<string, string> }> = {
    [AXE3]: { all: '19.05', extra: { RINGMOD: '29.02', MULTIPLEXER: '19.06' } },
    [FM3]: { all: '5.03', extra: { RINGMOD: '11.01' } },
    [FM9]: { all: '2.03', extra: { RINGMOD: '10.01' } },
  };
  for (const d of DEVICES) {
    const exp = expected[d.model]!;
    for (const row of d.params) {
      if (row.name !== `${row.family}_SCENEIGNORE`) continue;
      eq(fwKey(blockStateParams(d.model, row.family).sceneIgnore?.minFw), exp.extra[row.family] ?? exp.all, `${d.label} ${row.family} Scene Ignore gate`);
    }
    // Cross-check against the package's layout data (`*_LAYOUTS`): the highest control-level gate on each
    // `<FAMILY>_SCENEIGNORE` control is the table's gate; no Bypass Mode control carries a gate.
    const gateByName = new Map<string, BlockStateFirmware>();
    const seen = new Set<string>();
    for (const block of Object.values(d.layouts)) {
      for (const v of block.variants) for (const pg of v.pages) for (const r of pg.rows) for (const c of r.controls) {
        if (!c.paramName) continue;
        if (/_BYPASSMODE$/.test(c.paramName)) {
          eq(c.fw?.gtet, undefined, `${d.label} ${c.paramName}: Bypass Mode has no control gate in the layouts`);
        }
        if (!/_SCENEIGNORE$/.test(c.paramName)) continue;
        seen.add(c.paramName);
        if (!c.fw?.gtet) continue;
        const g = parseGate(c.fw.gtet);
        const cur = gateByName.get(c.paramName);
        if (!cur || fwCompare(g, cur) > 0) gateByName.set(c.paramName, g);
      }
    }
    eq(seen.size, 27, `${d.label}: every Scene Ignore family appears in the layouts`);
    for (const name of seen) {
      const family = name.replace(/_SCENEIGNORE$/, '');
      const table = blockStateParams(d.model, family).sceneIgnore?.minFw;
      eq(fwKey(table), fwKey(gateByName.get(name)), `${d.label} ${name}: gate matches the layouts`);
    }
    for (const row of d.params) {
      if (row.name !== `${row.family}_BYPASSMODE`) continue;
      eq(blockStateParams(d.model, row.family).bypassMode?.minFw, undefined, `${d.label} ${row.family}: Bypass Mode has no gate`);
    }
  }
}

function caseUnsupportedModels(): void {
  // VP4's catalog names Scene Ignore on four families, but its discrete writes are not decoded
  const vp4Si = VP4_PARAMS.filter((p) => p.name === `${p.family}_SCENEIGNORE`).map((p) => p.family);
  eq(vp4Si.length, 4, 'the VP4 catalog has 4 Scene Ignore rows (the check is not vacuous)');
  for (const family of [...vp4Si, 'REVERB', 'DELAY']) {
    eq(JSON.stringify(blockStateParams(VP4, family)), '{}', `VP4 ${family}: nothing writable`);
  }
  for (const model of [VP4, 0x15 /* AM4 */, 0x07 /* Axe-Fx II XL+ */, 0x03 /* Axe-Fx II */, 0x01 /* gen-1 */, 0x00]) {
    eq(hasBlockStateParams(model), false, `model 0x${model.toString(16)} has no block-state params`);
    eq(JSON.stringify(blockStateParams(model, 'DISTORT')), '{}', `model 0x${model.toString(16)} DISTORT: nothing`);
  }
  eq(BLOCK_STATE_MODELS.join(','), [AXE3, FM3, FM9].join(','), 'exactly the III / FM3 / FM9');
  for (const model of BLOCK_STATE_MODELS) {
    eq(hasBlockStateParams(model), true, `model 0x${model.toString(16)} has block-state params`);
    eq(JSON.stringify(blockStateParams(model, 'NOSUCHFAMILY')), '{}', `model 0x${model.toString(16)}: unknown family`);
  }
}

function caseMutingModes(): void {
  for (const l of ['MUTE', 'MUTE OUT', 'MUTE IN', 'Mute Out', ' mute  in ']) assert(isMutingBypassMode(l), `'${l}' silences the block`);
  for (const l of ['THRU', 'MUTE FX OUT', 'MUTE FX IN', 'Thru', '2', '', null, undefined]) assert(!isMutingBypassMode(l), `'${String(l)}' does not silence the block`);
  eq([...MUTING_BYPASS_MODES].sort().join('|'), 'MUTE|MUTE IN|MUTE OUT', 'the shared muting set is unchanged');
  eq(mutingBypassOrdinals(['THRU', 'MUTE FX OUT', 'MUTE OUT', 'MUTE FX IN', 'MUTE IN']).join(','), '2,4', '5-mode list: MUTE OUT + MUTE IN');
  eq(mutingBypassOrdinals(['THRU', 'MUTE']).join(','), '1', '2-mode list: MUTE');
  eq(mutingBypassOrdinals(['THRU', 'MUTE FX OUT']).join(','), '', 'FX-only list: nothing silences');
  // every bypass-mode label list the catalogs ship stays inside the known vocabulary, and starts with THRU
  const vocabulary = new Set(['THRU', 'MUTE', 'MUTE IN', 'MUTE OUT', 'MUTE FX IN', 'MUTE FX OUT']);
  let lists = 0;
  for (const d of DEVICES) {
    for (const row of d.params) {
      if (row.name !== `${row.family}_BYPASSMODE`) continue;
      const labels = d.enums[row.family]?.[String(row.paramId)];
      if (!labels) continue;
      lists++;
      eq(labels[0], 'THRU', `${d.label} ${row.family}: ordinal 0 is THRU`);
      for (const l of labels) assert(vocabulary.has(l), `${d.label} ${row.family}: '${l}' is a known bypass mode`);
      assert(labels.length >= 2 && labels.length <= 5, `${d.label} ${row.family}: 2..5 modes`);
    }
  }
  assert(lists >= 90, `bypass-mode label lists checked (got ${lists})`);
  // the FM3 delay (5 modes) silences on MUTE OUT + MUTE IN
  const fm3Delay = FM3_ENUM_OVERRIDES['DELAY']![String(blockStateParams(FM3, 'DELAY').bypassMode!.paramId)]!;
  eq(mutingBypassOrdinals(fm3Delay).join(','), '2,4', 'FM3 DELAY muting ordinals');
}

function caseFirmwareHelpers(): void {
  const g = { major: 5, minor: 3 };
  eq(firmwareAtLeast({ major: 5, minor: 3 }, g), true, '5.03 >= 5.03');
  eq(firmwareAtLeast({ major: 5, minor: 2 }, g), false, '5.02 < 5.03');
  eq(firmwareAtLeast({ major: 4, minor: 99 }, g), false, '4.99 < 5.03');
  eq(firmwareAtLeast({ major: 6, minor: 0 }, g), true, '6.00 >= 5.03');
  eq(firmwareAtLeast(null, g), true, 'unknown firmware is not below a gate');
  eq(firmwareAtLeast({ major: 1, minor: 0 }, undefined), true, 'no gate');
  eq(formatBlockStateFirmware({ major: 19, minor: 5 }), '19.05', 'display 19.05');
  eq(formatBlockStateFirmware({ major: 11, minor: 1 }), '11.01', 'display 11.01');
}

export function runBlockStateTests(): void {
  caseDeviceIds();
  caseEveryFamilyResolves();
  caseFirmwareGates();
  caseUnsupportedModels();
  caseMutingModes();
  caseFirmwareHelpers();
}
