/**
 * Author a loadable FM3 preset `.syx` OFFLINE from a converted `ConverterPreset`
 * intermediate representation (IR), by EDIT-IN-PLACE on a base FM3 dump.
 *
 * ─── SCOPE / SAFETY (read before use) ────────────────────────────────────
 *  - FM3 ONLY (gen-3 model byte 0x11). The block-param layout is live-hardware
 *    calibrated for the FM3 alone (see blockParams.ts). FM9/III/AM4/VP4 are
 *    intentionally refused — reusing FM3 tables on another body gives
 *    plausible-but-wrong bytes, the worst failure mode.
 *  - EDIT-IN-PLACE on a REQUIRED base dump. This never synthesizes a preset from
 *    nothing. It retypes existing blocks, writes their params, and renames — all
 *    without changing the body length, because `reframeRawPatch` requires the
 *    re-packed body to keep the SAME chunk count/length. No block-chain
 *    synthesis, no free re-layout, no add/remove of blocks.
 *  - IR blocks with no matching base block are SKIPPED (recorded in the report),
 *    never synthesized.
 *  - FILE-LEVEL round-trip validity (valid CRC, decodes back to the written
 *    values) does NOT prove DEVICE acceptance. A HARDWARE load test on a real
 *    FM3 is still required before trusting any authored preset.
 *
 * ─── TWO-ANCHOR RECONCILIATION ───────────────────────────────────────────
 * A block is addressed two independent ways, and this module confirms both
 * resolve to the SAME physical block instance before writing:
 *   1. TYPE addressing — `presetBody.ts` `walkBlocks` walks the block chain by
 *      body geometry (cols/rows) and `typeFieldByteOffset` gives the type id's
 *      byte offset relative to the block header (`block.offset`) / param array
 *      (`block.params_offset = block.offset + 0x2e`).
 *   2. PARAM addressing — `blockParams.ts` `findBlockHeader` scans the param
 *      region for `effectId + >=8 zero bytes` (`header`), and params live at
 *      `header + paramArrayBase(0x2e) + 2*paramId (+ channel stride for amp)`.
 * On the FM3, `findBlockHeader(eid) === block.offset - 12` (the effectId + zero
 * signature sits 12 bytes / 6 words below the walk header, ahead of the
 * per-scene channel words). Consequently the READER's type-param offset
 * (`header + 0x2e + 2*typePid`) lands on the EXACT byte the walk type field
 * occupies — DISTORT_TYPE(6)/DELAY_MODEL(6) → `params_offset+0`,
 * FUZZ_TYPE(0)/REVERB_TYPE(0) → header word 17. `reconcileBlockAnchors` builds
 * this correlation and asserts the type-byte coincidence; a mismatch throws
 * rather than risk writing the type to one block and its params to another.
 */

import { parsePresetDump, serializePresetDump } from './presetDump.js';
import { decodeRawPatch, reencodeRawPatch } from './presetHuffman.js';
import {
  decodeGen3Body,
  decodeGen3PresetDump,
  getProfile,
  typeFieldByteOffset,
  EFFECT_BASES,
  MODEL_FM3,
  type Gen3Block,
  type DeviceProfile,
} from './presetBody.js';
import { reframeRawPatch } from './presetAuthor.js';
import {
  gen3BlockParamModel,
  findBlockHeader,
  paramByteOffset,
  writeBlockParam,
  valueToRaw,
  typeParamForFamily,
  type Gen3BodyLayout,
  type Gen3BlockParamTables,
} from './blockParams.js';
import {
  buildGen3Body,
  hasSynthModel,
  type SynthPreset,
  type SynthPlacedBlock,
  type SynthSkip,
} from './presetSynth.js';
import { resolveFamily } from '../../convert/families.js';

/** FM3 gap (bytes) between the param-region header signature (effectId + zeros,
 *  found by `findBlockHeader`) and the walk block header (`block.offset`). */
const FM3_HEADER_PRELUDE_GAP = 12;

const CHANNEL_LETTERS = ['A', 'B', 'C', 'D'] as const;

// ── IR input shape (permissive `ConverterPreset`-like) ─────────────────

/** One param carried on an IR block. `paramId` (the catalog/`readBlockParams`
 *  paramId) wins; else `nativeName` is looked up in the family's catalog. Value
 *  source priority is `normalized` → range-inverted `value` → raw `value`
 *  (see `valueToRaw`). */
export interface IrAuthorParam {
  paramId?: number;
  nativeName?: string;
  normalized?: number;
  value?: number;
  min?: number;
  max?: number;
  log?: boolean;
}

/** One block to write. Matched to a base block by `blockName` (a device block
 *  display name, e.g. "Amp"/"Reverb") or `family` (a converter family slug,
 *  e.g. "amp"/"reverb"/"compressor"), plus optional 1-based `instance`. */
export interface IrAuthorBlock {
  family?: string;
  blockName?: string;
  /** 1-based instance within the family (default: first unmatched instance). */
  instance?: number;
  /** Block type/model ordinal to write (skipped for Cab / un-typed families). */
  typeValue?: number;
  /** Amp per-channel target (letter A-D or 0-based index); default channel A. */
  channel?: string | number;
  params?: IrAuthorParam[];
}

/** The `ConverterPreset`-like slice this author consumes. */
export interface IrAuthorPreset {
  name?: string;
  blocks?: IrAuthorBlock[];
}

// ── report shapes ──────────────────────────────────────────────────────

export interface AuthoredParamRecord {
  blockKey: string;
  family: string;
  paramId: number;
  nativeName?: string;
  channel: number;
  raw: number;
}
export interface AuthoredBlockRecord {
  blockKey: string;
  family: string;
  displayName: string;
  instance: number;
  eid: number;
  /** Type ordinal written (absent when no type was written). */
  typeWritten?: number;
  params: AuthoredParamRecord[];
}
export interface AuthoredSkip {
  /** What was requested (family/blockName/paramId), for the caller to surface. */
  blockKey?: string;
  family?: string;
  paramId?: number;
  nativeName?: string;
  reason: string;
}
export interface AuthorIrResult {
  /** The re-encoded device-valid `.syx` bytes (FILE-level valid; NOT hw-proven). */
  syx: Uint8Array;
  /** Blocks (and their params/type) that landed in the output. */
  written: AuthoredBlockRecord[];
  /** IR blocks/params that had no base match and were skipped (never synthesized). */
  skipped: AuthoredSkip[];
  /** The preset name written into the header (absent when the IR carried none). */
  nameWritten?: string;
  /** True when every matched block's two anchors reconciled (always true on
   *  success; a failure throws before this is returned). */
  anchorsReconciled: boolean;
}

// ── block-anchor correlation (the two-anchor reconciliation) ───────────

/** Reverse of `EFFECT_BASES`: block display name → base grid effect id. */
const REVERSE_EFFECT_BASES: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const [eid, name] of Object.entries(EFFECT_BASES)) out[name] = Number(eid);
  return out;
})();

/** One reconciled block: the walk block, its grid eid, the param-region header,
 *  and the two type-byte anchors (equal when reconciled). */
export interface BlockAnchor {
  block: Gen3Block;
  displayName: string;
  /** Converter family slug (canonical), or the display name lower-cased. */
  family: string;
  /** Catalog family symbol (e.g. DISTORT), for param lookups. */
  catalogFamily: string | undefined;
  instance: number;
  eid: number;
  /** Param-region header (from `findBlockHeader`). */
  header: number;
  /** Type-byte offset via the walk anchor (undefined for un-typed blocks). */
  walkTypeOffset?: number;
  /** Type-byte offset via the param anchor (undefined for un-typed families). */
  paramTypeOffset?: number;
  /**
   * True when the block's TYPE may be safely written: either it has a
   * reference-validated walk type-location and no competing catalog type param,
   * or both anchors agree on the exact type byte. False when the two anchors
   * DISAGREE (e.g. FM3 Enhancer: catalog type paramId points 12 bytes past the
   * walk type word) — the author then refuses the type write and reports it,
   * while still writing the block's PARAMS (those use the golden param anchor).
   * Undefined when the block has no walk type-location rule at all.
   */
  typeReconciled?: boolean;
}

function canonicalFamily(name: string): string {
  return resolveFamily(name) ?? name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Correlate every walk block with its param-region header, confirming the two
 * anchors reference the same instance (the eid signature must sit exactly the
 * prelude gap below the walk header — a block that fails this is OMITTED, never
 * treated as writable). For each correlated block, `typeReconciled` records
 * whether its TYPE byte is safe to write (walk + param anchors agree, or there
 * is no competing catalog type param). Blocks with no eid mapping (system /
 * utility blocks absent from `EFFECT_BASES`) are omitted, not an error. This
 * function never throws on a per-block anchor disagreement — it flags it.
 */
export function reconcileBlockAnchors(
  body: Uint8Array,
  modelId: number,
): BlockAnchor[] {
  if (modelId !== MODEL_FM3) {
    throw new Error(`reconcileBlockAnchors: FM3 (0x11) only, got 0x${modelId.toString(16)}`);
  }
  const profile = getProfile(modelId);
  const { tables, layout } = gen3BlockParamModel(modelId);
  const decoded = decodeGen3Body(body, modelId);
  const blocks = decoded.blocks ?? [];

  const anchors: BlockAnchor[] = [];
  const famCounts: Record<string, number> = {};
  for (const block of blocks) {
    const base = REVERSE_EFFECT_BASES[block.block];
    if (base == null) continue; // no grid-eid mapping → not param-addressable here

    // Resolve the eid whose param-region header sits exactly the prelude gap
    // below this walk block's header — this IS the anchor reconciliation.
    let eid: number | null = null;
    let header: number | null = null;
    for (let d = 0; d < 4; d++) {
      const h = findBlockHeader(body, base + d, layout.paramRegionFloor);
      if (h != null && h === block.offset - FM3_HEADER_PRELUDE_GAP) {
        eid = base + d;
        header = h;
        break;
      }
    }
    if (eid == null || header == null) {
      // Anchors do not reconcile for this block: refuse to treat it as writable.
      continue;
    }

    const fam = canonicalFamily(block.block);
    famCounts[fam] = (famCounts[fam] ?? 0) + 1;
    const instance = famCounts[fam];
    const catalogFamily = tables.familyByEffectId[String(eid)];

    const anchor: BlockAnchor = {
      block,
      displayName: block.block,
      family: fam,
      catalogFamily,
      instance,
      eid,
      header,
    };

    // Explicit type-byte reconciliation: when the block has BOTH a type-location
    // rule (walk anchor) AND a catalog type paramId (param anchor), the two must
    // land on the SAME byte to be safe to write. This is the guard the round-trip
    // test asserts; a mismatch is FLAGGED (typeReconciled=false), not thrown, so
    // the block's params stay writable and the author can skip only the type.
    const hasTypeLoc = block.block !== 'Cab' && profile.typeLocations[block.block] != null;
    const typePid = catalogFamily != null ? typeParamForFamily(tables, catalogFamily) : null;
    if (hasTypeLoc) {
      anchor.walkTypeOffset = typeFieldByteOffset(block, 'A', profile);
      if (typePid != null) {
        anchor.paramTypeOffset = paramByteOffset(header, layout, typePid, 0);
        anchor.typeReconciled = anchor.walkTypeOffset === anchor.paramTypeOffset;
      } else {
        // No competing catalog type param: the walk type-location is the sole,
        // reference-validated location — safe to write.
        anchor.typeReconciled = true;
      }
    }

    anchors.push(anchor);
  }
  return anchors;
}

// ── author ──────────────────────────────────────────────────────────────

function channelIndex(ch: string | number | undefined): number {
  if (ch == null) return 0;
  if (typeof ch === 'number') return ch >= 0 && ch < 4 ? Math.trunc(ch) : 0;
  const i = CHANNEL_LETTERS.indexOf(ch.trim().toUpperCase() as (typeof CHANNEL_LETTERS)[number]);
  return i < 0 ? 0 : i;
}

/** Resolve an IR param to its `readBlockParams` paramId (explicit id wins, else
 *  a catalog `nativeName` lookup within the block's family). */
function resolveParamId(
  tables: Gen3BlockParamTables,
  catalogFamily: string | undefined,
  p: IrAuthorParam,
): number | null {
  if (p.paramId != null && Number.isInteger(p.paramId)) return p.paramId;
  if (p.nativeName != null && catalogFamily) {
    const hit = tables.paramsByFamily[catalogFamily]?.find((c) => c.name === p.nativeName);
    if (hit) return hit.paramId;
  }
  return null;
}

/**
 * Author an FM3 `.syx` from a `ConverterPreset`-like IR by editing a base FM3
 * dump in place. See the module header for the (important) scope + safety notes.
 *
 * @param baseDumpBytes an exported FM3 preset `.syx` (0x77/0x78/0x79 dump) to edit.
 * @param ir            the converted preset IR (name + blocks + params).
 * @param modelId       SysEx model byte; MUST be MODEL_FM3 (0x11).
 * @returns `{ syx, written, skipped, nameWritten, anchorsReconciled }`.
 */
export function authorGen3PresetFromIR(
  baseDumpBytes: Uint8Array,
  ir: IrAuthorPreset,
  modelId: number,
): AuthorIrResult {
  if (modelId !== MODEL_FM3) {
    throw new Error(
      `authorGen3PresetFromIR: FM3 (0x11) only — got 0x${modelId.toString(16)}. ` +
        `FM9/III/AM4/VP4 authoring is intentionally unimplemented (uncalibrated write model).`,
    );
  }
  const parsed = parsePresetDump(baseDumpBytes, 0, modelId);
  const decodedRaw = decodeRawPatch(parsed.chunkPayloads);
  const { rawPatch, body } = decodedRaw;
  const profile: DeviceProfile = getProfile(modelId);
  const { tables, layout } = gen3BlockParamModel(modelId);

  // Reconcile anchors on the ORIGINAL body (stable signatures) before writing.
  const anchors = reconcileBlockAnchors(body, modelId);

  const newBody = body.slice();
  const written: AuthoredBlockRecord[] = [];
  const skipped: AuthoredSkip[] = [];
  const usedAnchors = new Set<BlockAnchor>();

  for (const irBlock of ir.blocks ?? []) {
    const nameToken = irBlock.blockName ?? irBlock.family;
    if (nameToken == null) {
      skipped.push({ reason: 'IR block has neither `blockName` nor `family`' });
      continue;
    }
    const wantFamily = canonicalFamily(nameToken);
    const candidates = anchors.filter((a) => a.family === wantFamily && !usedAnchors.has(a));
    let anchor: BlockAnchor | undefined;
    if (irBlock.instance != null) {
      anchor = candidates.find((a) => a.instance === irBlock.instance);
    } else {
      anchor = candidates[0];
    }
    if (!anchor) {
      skipped.push({
        family: wantFamily,
        reason:
          irBlock.instance != null
            ? `no base block for family "${wantFamily}" instance ${irBlock.instance}`
            : `no base block for family "${wantFamily}"`,
      });
      continue;
    }
    usedAnchors.add(anchor);

    const blockKey = `${anchor.family}${anchor.instance}`;
    const rec: AuthoredBlockRecord = {
      blockKey,
      family: anchor.family,
      displayName: anchor.displayName,
      instance: anchor.instance,
      eid: anchor.eid,
      params: [],
    };

    // ── type ──
    if (irBlock.typeValue != null) {
      if (anchor.displayName === 'Cab') {
        skipped.push({ blockKey, family: anchor.family, reason: 'Cab type is not swappable (DynaCab indices)' });
      } else if (profile.typeLocations[anchor.displayName] == null) {
        skipped.push({ blockKey, family: anchor.family, reason: `no type-location rule for "${anchor.displayName}"` });
      } else if (anchor.typeReconciled !== true) {
        skipped.push({
          blockKey,
          family: anchor.family,
          reason:
            `two-anchor type mismatch for "${anchor.displayName}" ` +
            `(walk byte 0x${anchor.walkTypeOffset?.toString(16)} != param byte 0x${anchor.paramTypeOffset?.toString(16)}) — ` +
            `type write refused; params still written`,
        });
      } else {
        const chLetter = CHANNEL_LETTERS[channelIndex(irBlock.channel)];
        const off = typeFieldByteOffset(anchor.block, chLetter, profile);
        const v = irBlock.typeValue & 0xffff;
        newBody[off] = v & 0xff;
        newBody[off + 1] = (v >> 8) & 0xff;
        rec.typeWritten = irBlock.typeValue;
      }
    }

    // ── params ──
    const chIdx = channelIndex(irBlock.channel);
    const isAmp = anchor.catalogFamily === layout.ampFamily;
    for (const p of irBlock.params ?? []) {
      const paramId = resolveParamId(tables, anchor.catalogFamily, p);
      if (paramId == null) {
        skipped.push({
          blockKey,
          family: anchor.family,
          paramId: p.paramId,
          nativeName: p.nativeName,
          reason: 'param has no resolvable paramId (unknown nativeName / no id)',
        });
        continue;
      }
      let raw: number;
      try {
        raw = valueToRaw(p);
      } catch (e) {
        skipped.push({
          blockKey,
          family: anchor.family,
          paramId,
          nativeName: p.nativeName,
          reason: `valueToRaw failed: ${(e as Error).message}`,
        });
        continue;
      }
      const writeCh = isAmp ? chIdx : 0;
      writeBlockParam(newBody, anchor.header, layout, paramId, writeCh, raw);
      rec.params.push({
        blockKey,
        family: anchor.family,
        paramId,
        nativeName: p.nativeName,
        channel: writeCh,
        raw,
      });
    }

    written.push(rec);
  }

  // ── name (written into the uncompressed header; survives reencode) ──
  let namedRaw = rawPatch;
  let nameWritten: string | undefined;
  if (ir.name != null) {
    namedRaw = rawPatch.slice();
    const nameBytes = new TextEncoder().encode(ir.name).subarray(0, 31);
    namedRaw.fill(0, 0x08, 0x28);
    namedRaw.set(nameBytes, 0x08);
    nameWritten = ir.name;
  }

  const newRaw = reencodeRawPatch(namedRaw, newBody); // recompress body + recompute CRC
  const syx = serializePresetDump(reframeRawPatch(parsed, newRaw));

  return { syx, written, skipped, nameWritten, anchorsReconciled: true };
}

// ── full-body synthesis (the faithful alternative to edit-in-place) ─────────

const SYNTH_BLOCK_HEADER_WORDS = 23;
/** eid signature (findBlockHeader anchor) sits this far below a walk header. */
const SYNTH_HEADER_PRELUDE_GAP = 12;

/**
 * Slice a scaffold body into its carried regions: prelude [0..firstEffectBlock]
 * and trailing [lastEffectBlockEnd..decompSize]. Located by a CHAIN WALK (from the
 * two-consecutive-25×1-modifier chain start), keying each record by the grid
 * effect id in its signature (12 bytes below the walk header) — robust where
 * `decodeGen3Body` under-counts the walk block list (FM9/III, FORGEFXMID-41) and
 * where a family's header lacks the 8-zero findBlockHeader signature (Axe-Fx III
 * Output). The chain start (= prelude length) is thereby per-device (FM3 0x120e,
 * FM9 0x1eb6, III 0x141e for the bundled scaffolds).
 */
function sliceScaffoldRegions(
  body: Uint8Array,
  decompSize: number,
  gridBases: ReadonlySet<number>,
): { prelude: Uint8Array; trailing: Uint8Array } {
  const u16 = (o: number): number => (body[o]! | (body[o + 1]! << 8)) & 0xffff;
  const eidBaseOf = (eid: number): number | null => {
    if (eid in EFFECT_BASES) return eid;
    for (const baseStr of Object.keys(EFFECT_BASES)) {
      const base = Number(baseStr);
      if (eid > base && eid <= base + 3) return base;
    }
    return null;
  };
  // chain start = first of two consecutive 25×1 modifier records.
  const modSize = (SYNTH_BLOCK_HEADER_WORDS + 25) * 2;
  let chainStart = -1;
  for (let off = 0x200; off < body.length - 70; off += 2) {
    if (u16(off + 30) !== 25 || u16(off + 32) !== 1) continue;
    const next = off + modSize;
    if (next + 34 <= body.length && u16(next + 30) === 25 && u16(next + 32) === 1) { chainStart = off; break; }
  }
  if (chainStart < 0) throw new Error('authorGen3PresetFromIRFull: scaffold block-chain start not found');

  let firstEffect = -1;
  let lastEffectEnd = -1;
  let pos = chainStart;
  while (pos + SYNTH_BLOCK_HEADER_WORDS * 2 + 2 <= body.length) {
    const cols = u16(pos + 30);
    const rows = u16(pos + 32);
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    const size = (SYNTH_BLOCK_HEADER_WORDS + cols * rows) * 2;
    if (!(cols === 25 && rows === 1)) {
      const base = eidBaseOf(u16(pos - SYNTH_HEADER_PRELUDE_GAP));
      if (base != null && gridBases.has(base)) {
        if (firstEffect < 0) firstEffect = pos;
        lastEffectEnd = pos + size;
      }
    }
    pos += size;
  }
  if (firstEffect < 0 || lastEffectEnd < 0) {
    throw new Error('authorGen3PresetFromIRFull: scaffold chain has no grid-placed effect blocks');
  }
  return { prelude: body.slice(0, firstEffect), trailing: body.slice(lastEffectEnd, decompSize) };
}

export interface AuthorIrFullResult {
  /** The re-encoded device-valid `.syx` bytes (FILE-level valid; NOT hw-proven). */
  syx: Uint8Array;
  /** Blocks synthesized into the chain (template clone + overlay). */
  blocks: SynthPlacedBlock[];
  /** IR blocks/params/types that had no template/rule and were skipped. */
  skipped: SynthSkip[];
  /** The preset name written into the raw_patch header (absent if none). */
  nameWritten?: string;
}

/**
 * SYNTHESIZE a full gen-3 preset `.syx` from a converted IR by CLONING a clean
 * scaffold and replacing its scene names, grid, and entire block chain — the
 * faithful alternative to `authorGen3PresetFromIR` (edit-in-place). Supports
 * FM3 (0x11, live-hardware calibrated), FM9 (0x12) and Axe-Fx III (0x10)
 * (community-beta, harvested from the single "Devs Gift Of Tone" preset each).
 *
 * Pipeline: parse the scaffold dump → decode its raw patch → carry its prelude
 * [0x000..firstEffectBlock] + trailing region → `buildGen3Body` assembles a fresh
 * chain of per-family template clones overlaid with the IR's type + params → write
 * the preset name into the raw-patch header → recompress (`reencodeRawPatch`,
 * which tolerates a body of ANY length) → re-frame (`reframeRawPatch`) →
 * serialize.
 *
 * @param scaffoldDumpBytes a clean `.syx` (of `modelId`) whose prelude + trailing are carried.
 * @param ir                the converted preset IR (a `ConverterPreset` is structurally accepted).
 * @param modelId           SysEx model byte; 0x10 (III) / 0x11 (FM3) / 0x12 (FM9).
 */
export function authorGen3PresetFromIRFull(
  scaffoldDumpBytes: Uint8Array,
  ir: SynthPreset,
  modelId: number = MODEL_FM3,
): AuthorIrFullResult {
  if (!hasSynthModel(modelId)) {
    throw new Error(
      `authorGen3PresetFromIRFull: unsupported model 0x${modelId.toString(16)} ` +
        `(supported: 0x10 Axe-Fx III, 0x11 FM3, 0x12 FM9). AM4/VP4 have no harvested templates.`,
    );
  }
  const parsed = parsePresetDump(scaffoldDumpBytes, 0, modelId);
  const decodedRaw = decodeRawPatch(parsed.chunkPayloads);
  const { rawPatch, body: scaffoldBody, decompSize } = decodedRaw;

  // Slice the scaffold's carried prelude + trailing via a robust chain walk keyed
  // on the scaffold's OWN grid effect ids (decodeGen3Body's block list under-counts
  // on FM9/III, so it cannot be trusted for the region boundaries).
  const scaffoldDecoded = decodeGen3PresetDump(scaffoldDumpBytes, modelId);
  const gridBases = new Set<number>();
  for (const c of scaffoldDecoded.grid ?? []) {
    if (c.is_shunt || c.effect_id <= 0 || c.effect_id > 1000) continue;
    // resolve to a base eid (a family occupies base..base+3)
    let base: number | null = c.effect_id in EFFECT_BASES ? c.effect_id : null;
    if (base == null) {
      for (const baseStr of Object.keys(EFFECT_BASES)) {
        const bb = Number(baseStr);
        if (c.effect_id > bb && c.effect_id <= bb + 3) { base = bb; break; }
      }
    }
    if (base != null) gridBases.add(base);
  }
  const { prelude, trailing } = sliceScaffoldRegions(scaffoldBody, decompSize, gridBases);

  const { body: newBody, placed, skipped } = buildGen3Body(ir, { prelude, trailing }, modelId);

  // Write the preset name into the uncompressed raw-patch header (survives reencode).
  let namedRaw = rawPatch;
  let nameWritten: string | undefined;
  if (ir.name != null) {
    namedRaw = rawPatch.slice();
    const nameBytes = new TextEncoder().encode(ir.name).subarray(0, 31);
    namedRaw.fill(0, 0x08, 0x28);
    namedRaw.set(nameBytes, 0x08);
    nameWritten = ir.name;
  }

  const newRaw = reencodeRawPatch(namedRaw, newBody);
  const syx = serializePresetDump(reframeRawPatch(parsed, newRaw));
  return { syx, blocks: placed, skipped, nameWritten };
}
