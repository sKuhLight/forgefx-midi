/**
 * FM3 full-body preset-body SYNTHESIS from a converted IR — the faithful
 * alternative to edit-in-place (presetAuthorIr.ts).
 *
 * ─── APPROACH: scaffold-anchored template-clone (NOT zero-build) ──────────
 * A clean FM3 scaffold supplies three regions VERBATIM:
 *   - the prelude [0x000 .. 0x120E]: word0/1, the scene-name region, the grid,
 *     the fixed setup, the scene controllers, and the 32 modifier slots;
 *   - the trailing region [after the last block .. decompSize];
 * and the synthesizer REPLACES wholesale, inside that carried image:
 *   - the scene names (body 0x004), the routing grid (body 0x104), and the
 *     ENTIRE block chain (0x120E →).
 * Each synthesized block is a CLONE of a real per-family block record
 * (blockTemplates.generated.ts) — so header words 18-22 and every UNCATALOGED
 * param slot keep the device's real defaults — overlaid with the IR block's
 * type (`typeFieldByteOffset`) and cataloged params (`writeBlockParam`), then
 * anchored by writing its grid eid signature (`[eid][8 zero bytes]`) 12 bytes
 * below the walk header so BOTH decoders (`walkBlocks` geometry walk and
 * `findBlockHeader` eid scan) resolve it.
 *
 * ─── SCOPE / SAFETY ───────────────────────────────────────────────────────
 *  - FM3 ONLY (model 0x11). FM9/III/AM4/VP4 refused (uncalibrated write model).
 *  - Families with no harvested template, or a geometry variant that was not
 *    templated, are SKIPPED and reported — never zero-built.
 *  - Cab IR selection + amp channels B/C/D are template-carried, not synthesized
 *    (the IR carries only channel A) — documented, not round-trip-asserted.
 *  - FILE-level round-trip validity is NOT device acceptance: a hardware load
 *    test on a real FM3 is still required.
 */

import {
  getProfile,
  typeFieldByteOffset,
  EFFECT_BASES,
  MODEL_FM3,
  type DeviceProfile,
  type Gen3Block,
} from './presetBody.js';
import {
  gen3BlockParamModel,
  writeBlockParam,
  valueToRaw,
  type Gen3BodyLayout,
  type Gen3BlockParamTables,
} from './blockParams.js';
import {
  FM3_BLOCK_TEMPLATES,
  FM3_SCAFFOLD_PRELUDE,
  FM3_SCAFFOLD_TRAILING,
  FM3_SCAFFOLD_SYX,
  type Fm3BlockTemplate,
} from './fm3/blockTemplates.generated.js';
import { resolveFamily } from '../../convert/families.js';

// ── layout constants (verified in presetBody.ts) ──────────────────────────
const BLOCK_HEADER_WORDS = 23;
/** The first real block is ALWAYS at this body offset (fixtures: 10/10). */
const CHAIN_START = 0x120e;
/** Scene-name region: 8 x 32-byte ASCII at body 0x004. */
const SCENE_NAME_BASE = 0x004;
const SCENE_NAME_SLOT = 32;
const SCENE_NAME_COUNT = 8;
/** Routing grid base (column-major, 2 words/cell). */
const GRID_BASE = 0x104;
/** The eid signature sits this many bytes below the walk header. */
const HEADER_PRELUDE_GAP = 12;

// ── IR-ish input (a permissive ConverterPreset slice) ─────────────────────

/** One param to overlay. `paramId` is the FM3 body param address. Value source
 *  priority follows `valueToRaw`: `normalized` → range-inverted `value` → raw. */
export interface SynthParam {
  paramId?: number;
  normalized?: number;
  value?: number;
  min?: number;
  max?: number;
  log?: boolean;
}

/** One IR grid cell (blocks AND shunts). */
export interface SynthGridCell {
  row: number;
  col: number;
  effectId?: number;
  routeFlag?: number;
  /** The block key this cell maps to (absent for shunts / unmatched cells). */
  blockKey?: string;
}

/** One IR block. Matched to a template + placement by its grid cell (`key`). */
export interface SynthBlock {
  /** Stable key `<family><instance>` (== a gridCell.blockKey). */
  key: string;
  /** Converter family slug (e.g. "amp"); used only for reporting. */
  family?: string;
  /** Type/model ordinal to write (skipped for Cab / un-typed families). */
  typeValue?: number;
  params?: SynthParam[];
}

/** The ConverterPreset slice this synthesizer consumes. */
export interface SynthPreset {
  name?: string;
  sceneNames?: string[];
  blocks?: SynthBlock[];
  routing?: { gridCells?: SynthGridCell[] };
}

// ── report shapes ──────────────────────────────────────────────────────────

export interface SynthPlacedParam {
  paramId: number;
  channel: number;
  raw: number;
}
export interface SynthPlacedBlock {
  key: string;
  displayName: string;
  eid: number;
  cols: number;
  rows: number;
  /** Body offset of the walk header. */
  offset: number;
  templateFrom: string;
  typeWritten?: number;
  params: SynthPlacedParam[];
}
export interface SynthSkip {
  key?: string;
  family?: string;
  displayName?: string;
  reason: string;
}
export interface SynthBodyResult {
  body: Uint8Array;
  placed: SynthPlacedBlock[];
  skipped: SynthSkip[];
}

// ── region writers ─────────────────────────────────────────────────────────

/** Write up to 8 scene names (ASCII, NUL-padded to 32 bytes) at body 0x004. */
export function writeSceneNames(body: Uint8Array, names: readonly string[] | undefined): void {
  if (!names) return;
  const enc = new TextEncoder();
  for (let i = 0; i < SCENE_NAME_COUNT; i++) {
    const start = SCENE_NAME_BASE + i * SCENE_NAME_SLOT;
    body.fill(0, start, start + SCENE_NAME_SLOT);
    const s = names[i];
    if (s == null) continue;
    const bytes = enc.encode(s).subarray(0, SCENE_NAME_SLOT - 1); // keep a NUL terminator
    body.set(bytes, start);
  }
}

/**
 * Poke the routing grid (inverse of `parseGrid`): clear the grid table, then
 * write each cell's effect id + route flag, column-major, 2 words/cell.
 */
export function synthGrid(
  body: Uint8Array,
  cells: readonly SynthGridCell[] | undefined,
  profile: DeviceProfile,
): void {
  const rows = profile.gridRows;
  const cols = profile.gridCols;
  const wordsPerCol = rows * 2;
  const tableWords = cols * wordsPerCol;
  body.fill(0, GRID_BASE, GRID_BASE + tableWords * 2);
  if (!cells) return;
  const w16 = (wordOff: number, v: number): void => {
    const o = GRID_BASE + wordOff * 2;
    body[o] = v & 0xff;
    body[o + 1] = (v >> 8) & 0xff;
  };
  for (const c of cells) {
    const eid = c.effectId ?? 0;
    if (eid === 0) continue;
    if (c.row < 0 || c.row >= rows || c.col < 0 || c.col >= cols) continue;
    const idx = c.col * wordsPerCol + c.row * 2;
    w16(idx, eid);
    w16(idx + 1, c.routeFlag ?? 0);
  }
}

/** Write a block's eid signature ([eid u16][8 zero bytes]) at `offset - 12` —
 *  the anchor `findBlockHeader` locates. Byte -2/-1 (scene-0 channel) is left. */
function writeEidSignature(body: Uint8Array, offset: number, eid: number): void {
  const sig = offset - HEADER_PRELUDE_GAP;
  body[sig] = eid & 0xff;
  body[sig + 1] = (eid >> 8) & 0xff;
  body.fill(0, sig + 2, sig + 10); // 8 zero bytes
}

// ── block-chain synthesis ──────────────────────────────────────────────────

interface Resolved {
  block: SynthBlock;
  /** Walk display name (from the template) — used for the type-location lookup. */
  displayName: string;
  /** The block's actual grid effect id (written as the record signature). */
  eid: number;
  template: Fm3BlockTemplate;
}

/** Base grid effect id for an eid (instances 1..4 occupy base..base+3). */
function eidBase(eid: number): number | null {
  if (eid in EFFECT_BASES) return eid;
  for (const baseStr of Object.keys(EFFECT_BASES)) {
    const base = Number(baseStr);
    if (eid > base && eid <= base + 3) return base;
  }
  return null;
}

/** Display label for a skip message (best-effort). */
function eidLabel(eid: number): string {
  const base = eidBase(eid);
  return base != null ? `${EFFECT_BASES[base]}(${eid})` : `eid_${eid}`;
}

/** Converter family slug → FM3 BASE grid effect id, inverted from `EFFECT_BASES`
 *  (the authoritative grid-eid → block table) via `resolveFamily`, RESTRICTED to
 *  eids with a harvested template so a cross-device block only ever lands on a
 *  real FM3 grid slot backed by a clone source. A family whose FM3 grid eid has
 *  no template (e.g. Vol/Pan @102, PEQ @54) is intentionally absent → its blocks
 *  are dropped + reported. Object key order is numeric-ascending, so the LOWEST
 *  eid for a family wins as its base (base..base+3 are the four instances). Cached. */
let _familyToBaseEid: Map<string, number> | null = null;
function familyToBaseEid(): Map<string, number> {
  if (_familyToBaseEid) return _familyToBaseEid;
  const m = new Map<string, number>();
  for (const [eidStr, label] of Object.entries(EFFECT_BASES)) {
    const eid = Number(eidStr);
    if (!(eid in FM3_BLOCK_TEMPLATES)) continue;
    const fam = resolveFamily(label);
    if (fam && !m.has(fam)) m.set(fam, eid);
  }
  _familyToBaseEid = m;
  return m;
}

/**
 * Normalize a converted IR so its grid cells carry FM3 grid EFFECT IDS.
 *
 * A same-device (FM3→FM3) IR already carries FM3 effect ids on its cells and is
 * returned untouched. A CROSS-DEVICE conversion (FM9 / Axe-Fx III → FM3) carries
 * cells with `blockKey` but NO `effectId` — the conversion engine strips the
 * source device's grid ids (they are not valid FM3 ids), leaving the FM3 layout
 * to us. This assigns each block an FM3 base eid from its FAMILY (with base+1..3
 * for repeated families, in grid signal order), fills the existing cells'
 * `effectId`, and appends a cell for any block that had none. Families FM3 has no
 * grid block for are dropped + reported (`no harvested template`).
 */
function ensureFm3GridEffectIds(ir: SynthPreset, skipped: SynthSkip[]): SynthPreset {
  const cells = ir.routing?.gridCells ?? [];
  const blocks = ir.blocks ?? [];
  if (blocks.length === 0) return ir;
  // Already FM3-addressed (any placed cell carries an effect id) → leave verbatim.
  if (cells.some((c) => c.effectId != null && c.effectId > 0 && c.blockKey != null)) return ir;

  const famToBase = familyToBaseEid();
  const blockByKey = new Map<string, SynthBlock>();
  for (const b of blocks) blockByKey.set(b.key, b);

  // Signal order = the cells' left-to-right / top-to-bottom order (the engine lays a
  // cross-device chain out this way); blocks with no cell fall to the end.
  const cellKeys = cells
    .filter((c) => c.blockKey != null)
    .slice()
    .sort((a, b) => a.col - b.col || a.row - b.row)
    .map((c) => c.blockKey!);
  const orderedKeys = [...cellKeys];
  for (const b of blocks) if (!orderedKeys.includes(b.key)) orderedKeys.push(b.key);

  const instanceByBase = new Map<number, number>();
  const eidByKey = new Map<string, number>();
  const seen = new Set<string>();
  for (const key of orderedKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const block = blockByKey.get(key);
    if (!block) continue;
    const base = block.family != null ? famToBase.get(block.family) : undefined;
    if (base == null) {
      skipped.push({ key, family: block.family, displayName: block.family ?? key, reason: `no harvested template for ${block.family ?? key}` });
      continue;
    }
    const inst = instanceByBase.get(base) ?? 0;
    instanceByBase.set(base, inst + 1);
    eidByKey.set(key, base + Math.min(inst, 3)); // instances 1..4 → base..base+3
  }

  const placedFromCells = new Set<string>();
  const newCells: SynthGridCell[] = cells.map((c) => {
    if (c.blockKey != null && eidByKey.has(c.blockKey)) {
      placedFromCells.add(c.blockKey);
      return { ...c, effectId: eidByKey.get(c.blockKey)! };
    }
    return c;
  });
  let nextCol = newCells.reduce((mx, c) => Math.max(mx, c.col), -1) + 1;
  for (const key of orderedKeys) {
    if (!eidByKey.has(key) || placedFromCells.has(key)) continue;
    newCells.push({ row: 0, col: nextCol++, effectId: eidByKey.get(key)!, blockKey: key });
  }

  return { ...ir, routing: { ...(ir.routing ?? {}), gridCells: newCells } };
}

/**
 * Resolve each IR block to a template + grid eid, in canonical (grid signal)
 * order; unresolvable blocks are recorded as skips. Blocks are matched to grid
 * cells by the cell's `blockKey` (carried straight from the IR). The TEMPLATE is
 * chosen by the cell's BASE GRID EFFECT ID (not the cols-based walk name), which
 * is how the grid + `readBlockParams` identify a block — so Input (eid 37) picks
 * the cols-10 record and Output (eid 42) the cols-26 record, unambiguously.
 */
function resolveBlocks(ir: SynthPreset, skipped: SynthSkip[]): Resolved[] {
  const cells = ir.routing?.gridCells ?? [];
  const resolved: Resolved[] = [];
  const placedCells = cells
    .filter((c) => c.effectId != null && c.effectId > 0 && c.effectId <= 1000 && c.blockKey != null)
    .slice()
    .sort((a, b) => a.col - b.col || a.row - b.row); // grid signal-ish order

  const blockByKey = new Map<string, SynthBlock>();
  for (const b of ir.blocks ?? []) blockByKey.set(b.key, b);

  const usedKeys = new Set<string>();
  for (const cell of placedCells) {
    const key = cell.blockKey!;
    if (usedKeys.has(key)) continue;
    const eid = cell.effectId!;
    const block = blockByKey.get(key);
    if (block == null) continue; // no IR block carries this cell
    const base = eidBase(eid);
    const template = base != null ? FM3_BLOCK_TEMPLATES[base] : undefined;
    if (!template) {
      skipped.push({ key, displayName: eidLabel(eid), family: block.family, reason: `no harvested template for ${eidLabel(eid)}` });
      continue;
    }
    usedKeys.add(key);
    resolved.push({ block, displayName: template.displayName, eid, template });
  }
  return resolved;
}

/**
 * Assemble the full decompressed FM3 body: carried prelude (scene names + grid
 * overwritten) + a fresh block chain (template clones with type + params +
 * eid signatures) + carried trailing. Returns the body and a placement report.
 */
export function buildGen3Body(
  ir: SynthPreset,
  scaffold: { prelude: Uint8Array; trailing: Uint8Array },
  modelId: number,
): SynthBodyResult {
  if (modelId !== MODEL_FM3) {
    throw new Error(`buildGen3Body: FM3 (0x11) only — got 0x${modelId.toString(16)}`);
  }
  const profile = getProfile(modelId);
  const { tables, layout } = gen3BlockParamModel(modelId);
  const skipped: SynthSkip[] = [];

  if (scaffold.prelude.length !== CHAIN_START) {
    throw new Error(`buildGen3Body: scaffold prelude must be ${CHAIN_START} bytes, got ${scaffold.prelude.length}`);
  }

  // Cross-device IRs carry cells without FM3 effect ids — assign them from each
  // block's family so the chain + grid synthesize (FM3-native IRs pass through).
  const normIr = ensureFm3GridEffectIds(ir, skipped);
  const resolved = resolveBlocks(normIr, skipped);
  const chainLen = resolved.reduce((n, r) => n + r.template.bytes.length, 0);

  const body = new Uint8Array(CHAIN_START + chainLen + scaffold.trailing.length);
  body.set(scaffold.prelude, 0);

  // Overwrite scene names + grid inside the carried prelude.
  writeSceneNames(body, normIr.sceneNames);
  synthGrid(body, normIr.routing?.gridCells, profile);

  // Place template clones back-to-back from CHAIN_START.
  const placed: SynthPlacedBlock[] = [];
  let offset = CHAIN_START;
  for (const r of resolved) {
    body.set(r.template.bytes, offset);
    placed.push({
      key: r.block.key,
      displayName: r.displayName,
      eid: r.eid,
      cols: r.template.cols,
      rows: r.template.rows,
      offset,
      templateFrom: r.template.sourceFixture,
      params: [],
    });
    offset += r.template.bytes.length;
  }
  const chainEnd = offset;
  body.set(scaffold.trailing, chainEnd);

  // Overlay type + params.
  for (let i = 0; i < resolved.length; i++) {
    const r = resolved[i];
    const p = placed[i];
    overlayBlock(body, r, p, profile, layout, tables, skipped);
  }

  // Anchor every block with its eid signature (final pass: block N's signature
  // lives in the reserved tail of block N-1's record, so write it last).
  for (const p of placed) writeEidSignature(body, p.offset, p.eid);

  return { body, placed, skipped };
}

function overlayBlock(
  body: Uint8Array,
  r: Resolved,
  p: SynthPlacedBlock,
  profile: DeviceProfile,
  layout: Gen3BodyLayout,
  tables: Gen3BlockParamTables,
  skipped: SynthSkip[],
): void {
  const displayName = r.displayName;
  // A Gen3Block-like view of the placed block for typeFieldByteOffset.
  const view: Gen3Block = {
    block: displayName,
    cols: r.template.cols,
    rows: r.template.rows,
    offset: p.offset,
    params_offset: p.offset + BLOCK_HEADER_WORDS * 2,
  };
  const header = p.offset - HEADER_PRELUDE_GAP;

  // ── type ──
  if (r.block.typeValue != null) {
    if (displayName === 'Cab') {
      skipped.push({ key: r.block.key, displayName, reason: 'Cab type is not swappable (DynaCab indices)' });
    } else if (profile.typeLocations[displayName] == null) {
      skipped.push({ key: r.block.key, displayName, reason: `no type-location rule for "${displayName}"` });
    } else {
      const off = typeFieldByteOffset(view, 'A', profile);
      const v = r.block.typeValue & 0xffff;
      body[off] = v & 0xff;
      body[off + 1] = (v >> 8) & 0xff;
      p.typeWritten = r.block.typeValue;
    }
  }

  // ── params ──
  for (const param of r.block.params ?? []) {
    if (param.paramId == null || !Number.isInteger(param.paramId)) {
      skipped.push({ key: r.block.key, displayName, reason: 'param has no integer paramId' });
      continue;
    }
    let raw: number;
    try {
      raw = valueToRaw(param);
    } catch (e) {
      skipped.push({ key: r.block.key, displayName, reason: `valueToRaw failed: ${(e as Error).message}` });
      continue;
    }
    const channel = 0; // the IR carries channel A only (amp B/C/D stay template-carried)
    try {
      writeBlockParam(body, header, layout, param.paramId, channel, raw);
    } catch (e) {
      skipped.push({ key: r.block.key, displayName, reason: `writeBlockParam failed (pid ${param.paramId}): ${(e as Error).message}` });
      continue;
    }
    p.params.push({ paramId: param.paramId, channel, raw });
  }
}

/** Default scaffold from the generated tables (used when no dump is supplied). */
export function defaultScaffold(): { prelude: Uint8Array; trailing: Uint8Array } {
  return {
    prelude: Uint8Array.from(FM3_SCAFFOLD_PRELUDE),
    trailing: Uint8Array.from(FM3_SCAFFOLD_TRAILING),
  };
}

/**
 * The full bundled default scaffold `.syx` dump bytes (a clean FM3 preset).
 * Pass to `authorGen3PresetFromIRFull` to synthesize a preset with NO
 * caller-supplied base — its raw-patch header + SysEx framing are carried,
 * while its scene names, grid and entire block chain are replaced from the IR.
 */
export function defaultScaffoldSyx(): Uint8Array {
  return Uint8Array.from(FM3_SCAFFOLD_SYX);
}
