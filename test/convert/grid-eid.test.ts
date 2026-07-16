/**
 * Cross-device FM3 target IR grid-eid assignment (FORGEFXMID-43 regression).
 *
 * convertPreset now assigns FM3 grid effect ids to the converted target IR at
 * CONVERSION time (assignFm3GridEffectIds), so every consumer — the Axis grid
 * editor (which keys cells by effectId) AND codec synthesis — sees distinct,
 * stable eids. Before, cross-device target cells carried NO effectId; the Axis
 * effectId→blockKey map collapsed every cell onto one block, so the edited-IR
 * export authored a single block → decode found no coherent chain → 422.
 *
 * This asserts (Axe-Fx III → FM3): every non-shunt target cell has a distinct
 * effect id, one per block; and authoring the target lands ALL blocks (not 1),
 * with distinct grid eids, valid CRC, validateGen3Preset ok, and route flags
 * preserved (the series connectivity survives).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGen3PresetDump, MODEL_FM3 } from '../../src/devices/gen3/presetBody.js';
import { liftGen3Preset } from '../../src/convert/adapters/gen3.js';
import { convertPreset } from '../../src/convert/engine.js';
import { authorGen3PresetFromIRFull } from '../../src/devices/gen3/presetAuthorIr.js';
import { validateGen3Preset } from '../../src/devices/gen3/presetValidate.js';
import { defaultScaffoldSyx, type SynthPreset } from '../../src/devices/gen3/presetSynth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const AXE3_FIXTURE = join(HERE, '..', 'gen3', 'axe-fx-iii', 'fixtures', 'devs-gift-of-tone.syx');
const AXE_FX_III = 0x10;

export const CONVERT_GRID_EID_CASE_COUNT = 1;

function fail(m: string): never {
  throw new Error(`[convert/grid-eid] ${m}`);
}

export function runConvertGridEidTests(): void {
  const bytes = new Uint8Array(readFileSync(AXE3_FIXTURE));
  const source = liftGen3Preset(decodeGen3PresetDump(bytes, AXE_FX_III), 'axe-fx-iii');
  const { target } = convertPreset(source, 'fm3');

  // (1) REGRESSION: cross-device fm3 target grid cells carry DISTINCT effect ids — one per
  // non-shunt block. The Axis effectId-keyed grid editor needs this; leaving them undefined
  // collapsed every cell onto one block.
  const cells = target.routing?.gridCells ?? [];
  const blockCells = cells.filter((c) => !c.isShunt && c.blockKey != null);
  if (blockCells.length < 2) fail(`expected multiple placed block cells, got ${blockCells.length}`);
  const eids = blockCells.map((c) => c.effectId);
  if (eids.some((e) => e == null || e <= 0)) fail(`a block cell has no effectId: ${JSON.stringify(eids)}`);
  if (new Set(eids).size !== eids.length) fail(`block-cell effectIds not distinct: ${JSON.stringify(eids)}`);
  if (new Set(blockCells.map((c) => c.blockKey)).size !== blockCells.length) fail('block cells not 1:1 with blocks');

  // (2) E2E: author the FM3 body from the (now addressed) target IR → decode → ALL blocks land.
  const r = authorGen3PresetFromIRFull(defaultScaffoldSyx(), target as unknown as SynthPreset, MODEL_FM3);
  if (r.blocks.length < 2) fail(`only ${r.blocks.length} block(s) landed (the pre-fix bug landed 1)`);
  const dd = decodeGen3PresetDump(r.syx, MODEL_FM3);
  if (dd.crc_valid !== true) fail('authored .syx failed CRC');
  const vr = validateGen3Preset(r.syx, MODEL_FM3);
  if (!vr.ok) fail(`validateGen3Preset failed: ${vr.issues.join('; ')}`);
  const placedEids = (dd.grid ?? []).filter((c) => !c.is_shunt && c.effect_id > 0).map((c) => c.effect_id);
  if (new Set(placedEids).size !== placedEids.length) fail(`decoded grid eids not distinct: ${JSON.stringify(placedEids)}`);
  const connected = (dd.grid ?? []).filter((c) => (c.from_rows?.length ?? 0) > 0).length;
  if (connected < 1) fail('no route flags in the authored grid (routing lost)');

  console.log(`  [convert/grid-eid] Axe3→FM3: ${blockCells.length} distinct-eid cells, ${r.blocks.length} blocks landed, ${connected} connected; crc+validate ok`);
}
