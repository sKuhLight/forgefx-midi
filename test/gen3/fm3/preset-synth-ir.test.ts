/**
 * FM3 full-body preset SYNTHESIS round-trip — the correctness gate for
 * `authorGen3PresetFromIRFull` (src/devices/gen3/presetAuthorIr.ts +
 * presetSynth.ts).
 *
 * FM3-IDENTITY test: take a real FM3 fixture (the SUBJECT), lift it to a
 * ConverterPreset IR (convert/adapters/gen3.ts `liftGen3Preset`), then SYNTHESIZE
 * a new `.syx` from that IR using a DIFFERENT fixture as the scaffold (so the
 * carried prelude/trailing and every block template come from other presets,
 * genuinely exercising the template-clone + overlay). Decode the result and
 * assert it reproduces the subject faithfully:
 *   1. crc_valid (device-validity file gate);
 *   2. validateGen3Preset ok (coherent gen-3 dump);
 *   3. preset name + scene names match the subject;
 *   4. grid placed effect ids + route flags match the subject;
 *   5. every subject block present with a matching walk type id (per grid eid);
 *   6. every IR-carried param reads back byte-exact (channel A; readBlockParams).
 *
 * The subject (preset-5) has one block per family with a single geometry and no
 * two-anchor-irreconcilable families, so type + params round-trip cleanly.
 * Template families come from OTHER fixtures (see harvest preference order), so
 * a pass proves the assembly, not an identity byte-copy.
 *
 * FILE-level validity is NOT device acceptance — a hardware load test on a real
 * FM3 is still required.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../../../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../../../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body, decodeGen3PresetDump } from '../../../src/devices/gen3/presetBody.js';
import { readBlockParamsForModel } from '../../../src/devices/gen3/blockParams.js';
import { validateGen3Preset } from '../../../src/devices/gen3/presetValidate.js';
import { authorGen3PresetFromIRFull } from '../../../src/devices/gen3/presetAuthorIr.js';
import { liftGen3Preset } from '../../../src/convert/adapters/gen3.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FM3 = 0x11;
const SYNTHETIC_FLOOR = 0xff00;

export const PRESET_SYNTH_IR_CASE_COUNT = 1;

function fail(msg: string): never {
  throw new Error(`[fm3/preset-synth-ir] ${msg}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) & 0xffff;

/** Body from a dump. */
function bodyOf(bytes: Uint8Array): Uint8Array {
  return decodeRawPatch(parsePresetDump(bytes, 0, FM3).chunkPayloads).body;
}

/** grid → set of "eid|row|col|flag". */
function gridSet(bytes: Uint8Array): Set<string> {
  const d = decodeGen3PresetDump(bytes, FM3);
  return new Set((d.grid ?? []).map((c) => `${c.effect_id}|${c.row}|${c.col}|${c.route_flag}`));
}

/** walk blocks → map eid → "displayName:typeId" (amp type from channel A). */
function walkTypeByEid(body: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  for (const b of decodeGen3Body(body, FM3).blocks ?? []) {
    const eid = u16(body, b.offset - 12);
    const tid = b.type_id ?? (b.channels?.A?.type_id as number | undefined);
    out.set(eid, `${b.block}:${tid ?? '-'}`);
  }
  return out;
}

/** readBlockParams → map "eid|channel|paramId" → raw (real body params only). */
function paramMapByEid(body: Uint8Array): Map<string, number> {
  const decoded = decodeGen3Body(body, FM3);
  const placed = new Set<number>(
    (decoded.grid ?? []).filter((c) => !c.is_shunt && c.effect_id).map((c) => c.effect_id),
  );
  const raws = new Map<string, number>();
  for (const b of readBlockParamsForModel(body, placed, FM3)) {
    for (const p of b.params) {
      if (p.paramId >= SYNTHETIC_FLOOR) continue; // UI-only pseudo params, not body slots
      raws.set(`${b.effectId}|${b.channel ?? 'x'}|${p.paramId}`, p.raw);
    }
  }
  return raws;
}

export function runPresetSynthIrTests(): void {
  const subjectBytes = new Uint8Array(readFileSync(join(FIXTURES, 'preset-5.syx')));
  const scaffoldBytes = new Uint8Array(readFileSync(join(FIXTURES, 'preset-96.syx')));

  // ── lift the subject to IR ──
  const subjectDecoded = decodeGen3PresetDump(subjectBytes, FM3);
  const ir = liftGen3Preset(subjectDecoded, 'fm3');
  assert(ir.blocks.length > 0, 'subject IR carried no blocks');

  // ── synthesize from a DIFFERENT scaffold ──
  const result = authorGen3PresetFromIRFull(scaffoldBytes, ir, FM3);
  assert(result.blocks.length > 0, 'synthesis placed no blocks');
  // The only template-less skips must be Input/Output — grid + prelude-resident
  // I/O nodes that are NOT block-chain records (no fixture carries them as walk
  // blocks; their params live in the scaffold-carried prelude, by design). Any
  // OTHER missing template is a real gap.
  const PRELUDE_RESIDENT = new Set(['Input', 'Output']);
  const missingTemplate = result.skipped.filter(
    (s) => s.reason.includes('no harvested template') && !PRELUDE_RESIDENT.has(s.displayName ?? ''),
  );
  assert(missingTemplate.length === 0, `subject chain blocks skipped for missing template: ${JSON.stringify(missingTemplate)}`);

  // The template clones must come from OTHER fixtures (not preset-5) — proving
  // this is not an identity byte-copy.
  const fromSubject = result.blocks.filter((b) => b.templateFrom === 'preset-5.syx');
  assert(fromSubject.length === 0, `templates unexpectedly sourced from the subject: ${JSON.stringify(fromSubject.map((b) => b.displayName))}`);

  // ── wrong-model guard ──
  let threw = false;
  try { authorGen3PresetFromIRFull(scaffoldBytes, ir, 0x12); } catch { threw = true; }
  assert(threw, 'authorGen3PresetFromIRFull must refuse a non-FM3 model');

  // ── 1. crc + 2. coherence ──
  const authoredDecoded = decodeGen3PresetDump(result.syx, FM3);
  assert(authoredDecoded.crc_valid === true, 'synthesized .syx failed CRC (would be rejected by device)');
  const vr = validateGen3Preset(result.syx, FM3);
  assert(vr.ok, `validateGen3Preset failed: ${vr.issues.join('; ')}`);

  // ── 3. name + scene names ──
  assert(
    authoredDecoded.preset_name === subjectDecoded.preset_name,
    `preset name "${authoredDecoded.preset_name}" != subject "${subjectDecoded.preset_name}"`,
  );
  const srcScenes = subjectDecoded.scene_names ?? [];
  const authScenes = authoredDecoded.scene_names ?? [];
  assert(srcScenes.length === authScenes.length, `scene name count ${authScenes.length} != ${srcScenes.length}`);
  for (let i = 0; i < srcScenes.length; i++) {
    assert(authScenes[i] === srcScenes[i], `scene ${i + 1} name "${authScenes[i]}" != "${srcScenes[i]}"`);
  }

  // ── 4. grid ──
  const srcGrid = gridSet(subjectBytes);
  const authGrid = gridSet(result.syx);
  assert(srcGrid.size === authGrid.size, `grid cell count ${authGrid.size} != ${srcGrid.size}`);
  for (const cell of srcGrid) assert(authGrid.has(cell), `grid cell missing/changed: ${cell}`);

  // The set of chain blocks the synthesizer placed = the subject's walk blocks.
  const placedEids = new Set(result.blocks.map((b) => b.eid));

  // ── 5. per-eid walk block type (chain blocks only) ──
  const srcBody = bodyOf(subjectBytes);
  const authBody = bodyOf(result.syx);
  const srcTypes = walkTypeByEid(srcBody);
  const authTypes = walkTypeByEid(authBody);
  assert(srcTypes.size === authTypes.size, `block count ${authTypes.size} != subject ${srcTypes.size}`);
  for (const [eid, desc] of srcTypes) {
    assert(placedEids.has(eid), `subject chain block eid ${eid} ("${desc}") was not synthesized`);
    const got = authTypes.get(eid);
    assert(got === desc, `block eid ${eid}: "${got}" != subject "${desc}"`);
  }

  // ── 6. IR-carried params read back byte-exact (chain blocks, channel A) ──
  // Input/Output params are prelude-resident (scaffold-carried), so restrict to
  // synthesized chain-block eids.
  const srcParams = paramMapByEid(srcBody);
  const authParams = paramMapByEid(authBody);
  let compared = 0;
  for (const [key, srcRaw] of srcParams) {
    const [eidStr, ch] = key.split('|');
    if (!placedEids.has(Number(eidStr))) continue; // prelude-resident (Input/Output)
    if (ch !== '0' && ch !== 'x') continue; // amp channels B/C/D are template-carried
    const got = authParams.get(key);
    assert(got === srcRaw, `param ${key}: read-back raw ${got} != subject ${srcRaw}`);
    compared++;
  }
  assert(compared > 50, `too few params compared (${compared}) — the round-trip is not meaningful`);
}
