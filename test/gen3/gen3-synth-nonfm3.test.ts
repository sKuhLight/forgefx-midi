/**
 * FM9 (0x12) + Axe-Fx III (0x10) full-body preset SYNTHESIS round-trip — the
 * non-FM3 correctness gate for `authorGen3PresetFromIRFull` / `buildGen3Body`
 * (FORGEFXMID-44), mirroring test/gen3/fm3/preset-synth-ir.test.ts.
 *
 * For each device: lift its real "Devs Gift Of Tone" fixture to a ConverterPreset
 * IR (convert/adapters/gen3.ts), SYNTHESIZE a new `.syx` from that IR onto the
 * bundled default scaffold (defaultScaffoldSyx(model)), decode the result and
 * assert it reproduces the subject:
 *   1. crc_valid (device-validity file gate);
 *   2. validateGen3Preset ok (coherent gen-3 dump);
 *   3. preset name + scene names match;
 *   4. grid placed effect ids + route flags match;
 *   5. every placed block's geometry (cols×rows) equals the harvested geometry table;
 *   6. every IR-carried param reads back byte-exact (channel A; readBlockParams);
 *   7. the untemplated families (any not in the geometry table) carry NO geometry
 *      and `buildCatalogBlock` refuses to fabricate one (the FORGEFXMID-40 rigor rule);
 *   8. AM4/VP4 models are refused.
 *
 * DATA CAVEAT: only ONE preset per device is available (the same fixture is the
 * subject, the template source and the scaffold), so this proves the assembly +
 * geometry + write model, NOT a cross-fixture reconstruction. It is emphatically
 * NOT device acceptance — a hardware load test on a real FM9 / Axe-Fx III is still
 * the operator's final word.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeGen3PresetDump,
  EFFECT_BASES,
  MODEL_FM9,
  MODEL_AXE_FX_III,
} from '../../src/devices/gen3/presetBody.js';
import { readBlockParamsForModel, gen3BlockParamModel } from '../../src/devices/gen3/blockParams.js';
import { validateGen3Preset } from '../../src/devices/gen3/presetValidate.js';
import { authorGen3PresetFromIRFull } from '../../src/devices/gen3/presetAuthorIr.js';
import {
  defaultScaffoldSyx,
  buildCatalogBlock,
  FM9_BLOCK_GEOMETRY,
  AXE3_BLOCK_GEOMETRY,
} from '../../src/devices/gen3/presetSynth.js';
import { liftGen3Preset } from '../../src/convert/adapters/gen3.js';
import type { Gen3DeviceId } from '../../src/convert/families.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_FLOOR = 0xff00;

interface Case {
  name: string;
  model: number;
  device: Gen3DeviceId;
  fixture: string;
  geometry: Readonly<Record<number, { cols: number; rows: number }>>;
  /** Families this device's single preset places (has a template). */
  covered: number[];
}

const CASES: Case[] = [
  {
    name: 'FM9',
    model: MODEL_FM9,
    device: 'fm9',
    fixture: join(HERE, 'fm9/fixtures/devs-gift-of-tone.syx'),
    geometry: FM9_BLOCK_GEOMETRY,
    covered: [37, 42, 54, 58, 62, 70, 94, 102, 118],
  },
  {
    name: 'Axe-Fx III',
    model: MODEL_AXE_FX_III,
    device: 'axe-fx-iii',
    fixture: join(HERE, 'axe-fx-iii/fixtures/devs-gift-of-tone.syx'),
    geometry: AXE3_BLOCK_GEOMETRY,
    covered: [37, 42, 54, 58, 62, 70, 94, 102, 118],
  },
];

/** A handful of families NO Devs preset places — must carry no geometry (rigor). */
const UNTEMPLATED_SAMPLE = [46 /*Comp*/, 66 /*Reverb*/, 78 /*Chorus*/, 130 /*Synth*/, 146 /*Gate*/];

export const GEN3_SYNTH_NONFM3_CASE_COUNT = CASES.length;

function fail(msg: string): never {
  throw new Error(`[gen3-synth-nonfm3] ${msg}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

function eidBase(eid: number): number {
  if (eid in EFFECT_BASES) return eid;
  for (const baseStr of Object.keys(EFFECT_BASES)) {
    const base = Number(baseStr);
    if (eid > base && eid <= base + 3) return base;
  }
  return eid;
}

/** readBlockParams → map "eid|channel|paramId" → raw (real body params only). */
function paramMap(syx: Uint8Array, model: number): Map<string, number> {
  const d = decodeGen3PresetDump(syx, model);
  const placed = new Set<number>(
    (d.grid ?? []).filter((c) => !c.is_shunt && c.effect_id > 0 && c.effect_id <= 1000).map((c) => c.effect_id),
  );
  const m = new Map<string, number>();
  for (const b of readBlockParamsForModel(d.decompressed_body, placed, model)) {
    for (const p of b.params) {
      if (p.paramId >= SYNTHETIC_FLOOR) continue;
      m.set(`${b.effectId}|${b.channel ?? 'x'}|${p.paramId}`, p.raw);
    }
  }
  return m;
}

function runOne(c: Case): void {
  const { tables, layout } = gen3BlockParamModel(c.model);

  // (7) rigor: untemplated families have no geometry and refuse to build.
  for (const base of UNTEMPLATED_SAMPLE) {
    if (c.geometry[base] != null) fail(`${c.name}: untemplated family ${EFFECT_BASES[base]}(${base}) unexpectedly has geometry`);
    if (buildCatalogBlock(base, c.geometry, layout, tables) != null) {
      fail(`${c.name}: buildCatalogBlock fabricated a record for untemplated ${EFFECT_BASES[base]}(${base})`);
    }
  }
  // covered families all carry geometry.
  for (const base of c.covered) {
    if (c.geometry[base] == null) fail(`${c.name}: covered family ${EFFECT_BASES[base]}(${base}) missing geometry`);
  }
  assert(Object.keys(c.geometry).length === c.covered.length, `${c.name}: geometry table has ${Object.keys(c.geometry).length} families, expected ${c.covered.length}`);

  // ── lift subject → IR, synthesize onto the bundled default scaffold ──
  const subject = new Uint8Array(readFileSync(c.fixture));
  const subjectDecoded = decodeGen3PresetDump(subject, c.model);
  const ir = liftGen3Preset(subjectDecoded, c.device);
  assert(ir.blocks.length > 0, `${c.name}: subject IR carried no blocks`);

  const res = authorGen3PresetFromIRFull(defaultScaffoldSyx(c.model), ir as never, c.model);
  assert(res.blocks.length > 0, `${c.name}: synthesis placed no blocks`);
  // Every subject block must land (all 9 families are templated for these presets).
  assert(res.skipped.length === 0, `${c.name}: unexpected skips: ${JSON.stringify(res.skipped)}`);
  assert(res.blocks.length === c.covered.length, `${c.name}: placed ${res.blocks.length} blocks, expected ${c.covered.length}`);

  // ── AM4/VP4 refusal ──
  let threw = false;
  try { authorGen3PresetFromIRFull(defaultScaffoldSyx(c.model), ir as never, 0x08 /*AM4*/); } catch { threw = true; }
  assert(threw, `${c.name}: authorGen3PresetFromIRFull must refuse an uncalibrated model`);

  // ── 1. crc + 2. coherence ──
  const authored = decodeGen3PresetDump(res.syx, c.model);
  assert(authored.crc_valid === true, `${c.name}: synthesized .syx failed CRC`);
  const vr = validateGen3Preset(res.syx, c.model);
  assert(vr.ok, `${c.name}: validateGen3Preset failed: ${vr.issues.join('; ')}`);

  // ── 3. name + scene names ──
  assert(authored.preset_name === subjectDecoded.preset_name, `${c.name}: preset name "${authored.preset_name}" != "${subjectDecoded.preset_name}"`);
  const srcScenes = subjectDecoded.scene_names ?? [];
  const authScenes = authored.scene_names ?? [];
  assert(srcScenes.length === authScenes.length, `${c.name}: scene name count ${authScenes.length} != ${srcScenes.length}`);
  for (let i = 0; i < srcScenes.length; i++) {
    assert(authScenes[i] === srcScenes[i], `${c.name}: scene ${i + 1} "${authScenes[i]}" != "${srcScenes[i]}"`);
  }

  // ── 4. grid ──
  const srcGrid = new Set((subjectDecoded.grid ?? []).map((x) => `${x.effect_id}|${x.row}|${x.col}|${x.route_flag}`));
  const authGrid = new Set((authored.grid ?? []).map((x) => `${x.effect_id}|${x.row}|${x.col}|${x.route_flag}`));
  assert(srcGrid.size === authGrid.size, `${c.name}: grid cell count ${authGrid.size} != ${srcGrid.size}`);
  for (const cell of srcGrid) assert(authGrid.has(cell), `${c.name}: grid cell missing/changed: ${cell}`);

  // ── 5. per-block geometry matches the harvested table ──
  for (const b of res.blocks) {
    const g = c.geometry[eidBase(b.eid)];
    assert(g != null, `${c.name}: placed block eid ${b.eid} has no geometry entry`);
    assert(b.cols === g!.cols && b.rows === g!.rows, `${c.name}: eid ${b.eid} geometry ${b.cols}x${b.rows} != table ${g!.cols}x${g!.rows}`);
  }

  // ── 6. IR-carried params read back byte-exact (chain blocks, channel A) ──
  const placedEids = new Set(res.blocks.map((b) => b.eid));
  const srcParams = paramMap(subject, c.model);
  const authParams = paramMap(res.syx, c.model);
  let compared = 0;
  for (const [key, srcRaw] of srcParams) {
    const [eidStr, ch] = key.split('|');
    if (!placedEids.has(Number(eidStr))) continue;
    if (ch !== '0' && ch !== 'x') continue; // amp channels B/C/D are template-carried
    const got = authParams.get(key);
    assert(got === srcRaw, `${c.name}: param ${key}: read-back ${got} != subject ${srcRaw}`);
    compared++;
  }
  assert(compared > 100, `${c.name}: too few params compared (${compared})`);

  console.log(`  [gen3-synth-nonfm3] ${c.name}: ${res.blocks.length} blocks placed, ${compared} chA params byte-exact, geometry matched, validate ok`);
}

export function runGen3SynthNonFm3Tests(): void {
  for (const c of CASES) runOne(c);
}
