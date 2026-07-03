/**
 * Gen-3 preset-body GENERIC per-block parameter extraction.
 *
 * The decompressed preset body stores each PLACED block's parameters as a flat
 * array of u16 LE values, in paramId order, at stride 2, starting at
 * `block header + paramArrayBase`. Values use the device's 0..65534 model
 * (continuous params normalized to that range; enum/type params hold a raw
 * ordinal):
 *
 *   value(block, P) = u16LE at (header + paramArrayBase + 2*P)
 *   header          = effectId u16 LE + >=8 zero bytes, scanned from the
 *                     param-region floor (below it is the setup/global prelude)
 *   amp             = repeats its whole param array per channel A-D at
 *                     +ampChannelStride
 *
 * PROVENANCE / DISCIPLINE: this layout was live-validated on FM3 hardware by
 * the ForgeFX server (100% enum-fit across 15 block instances spanning
 * Input/Output/Comp/PEQ/Amp/Cab/Reverb/Wah/Pitch/Synth/Gate/RingMod/Filter…)
 * and is frozen as golden fixtures under test/gen3/fm3/fixtures/ (real preset
 * dumps + the exact decode the live-validated implementation produced).
 * `decodeGen3Body` (presetBody.ts) deliberately does NOT do generic per-param
 * value extraction because it lacked value-scale ground truth — those fixtures
 * are that ground truth, for the FM3. Other gen-3 models are REFUSED until
 * their layout is calibrated the same way (paramIds are device-specific:
 * reusing FM3 tables on an Axe-Fx III / FM9 body would give plausible-but-wrong
 * values, the worst failure mode).
 *
 * Unlike presetBody.ts (which classifies blocks by their body geometry), this
 * module addresses blocks by their GRID effect id, so callers pass the placed
 * effectId set (from `decodeGen3Body(...).grid` or a live grid read) — required
 * to avoid phantom headers (a small effectId can match the header signature
 * inside another block's data).
 */

import type { Param } from '../../gen3/types.js';
import {
  FM3_PARAMS_BY_FAMILY,
  FM3_RANGES,
  FM3_ENUM_OVERRIDES,
  FM3_ROSTERS,
  FM3_FAMILY_BY_EFFECT_ID,
} from '../../gen3/fm3/index.js';

// ── table + layout contracts (device-parameterized) ───────────────────

/** Catalog slice a device must provide: params per family, display ranges,
 *  enum label overrides, clean type/model rosters, and the effectId→family map. */
export interface Gen3BlockParamTables {
  paramsByFamily: Record<string, readonly Pick<Param, 'paramId' | 'name' | 'displayLabel' | 'unit'>[]>;
  ranges: Record<string, Record<number, { kind?: string; displayMin: number; displayMax: number }>>;
  enumOverrides: Record<string, Record<string, readonly string[]>>;
  /** Per UI slug: clean model roster ({ value: ordinal, name }) for TYPE params. */
  rosters: Record<string, readonly { value: number; name: string }[]>;
  familyByEffectId: Record<string, string>;
  /** Catalog family symbol → UI slug, for families whose slug isn't just the lower-cased symbol. */
  familyToSlug?: Record<string, string>;
}

/** Byte layout of the param region inside the decompressed body. */
export interface Gen3BodyLayout {
  /** Scan floor for block headers (below it is the setup/global prelude). */
  paramRegionFloor: number;
  /** u16-array base, relative to a block's header. */
  paramArrayBase: number;
  /** The amp family symbol (repeats its param array per channel). */
  ampFamily: string;
  /** Byte stride between the amp's per-channel param arrays. */
  ampChannelStride: number;
  ampChannels: number;
}

/** FM3 layout — live-validated (see module header). */
export const FM3_BODY_LAYOUT: Gen3BodyLayout = {
  paramRegionFloor: 0x1202,
  paramArrayBase: 0x2e,
  ampFamily: 'DISTORT',
  ampChannelStride: 0x120,
  ampChannels: 4,
};

/** FM3 catalog tables pre-wired for `readBlockParams`. */
export const FM3_BLOCK_PARAM_TABLES: Gen3BlockParamTables = {
  paramsByFamily: FM3_PARAMS_BY_FAMILY as Gen3BlockParamTables['paramsByFamily'],
  ranges: FM3_RANGES as unknown as Gen3BlockParamTables['ranges'],
  enumOverrides: FM3_ENUM_OVERRIDES as unknown as Gen3BlockParamTables['enumOverrides'],
  rosters: FM3_ROSTERS as unknown as Gen3BlockParamTables['rosters'],
  familyByEffectId: FM3_FAMILY_BY_EFFECT_ID as Record<string, string>,
  familyToSlug: {
    DISTORT: 'amp',
    CABINET: 'cab',
    COMP: 'comp',
    DELAY: 'delay',
    FUZZ: 'drive',
    GEQ: 'geq',
    REVERB: 'reverb',
    WAH: 'wah',
  },
};

/** Verified (tables, layout) pairs by SysEx model byte. III (0x10) and FM9
 *  (0x12) are ABSENT on purpose: their param-region layout has not been
 *  calibrated against hardware ground truth yet (see module header). */
const VERIFIED_MODELS: Record<number, { tables: Gen3BlockParamTables; layout: Gen3BodyLayout }> = {
  0x11: { tables: FM3_BLOCK_PARAM_TABLES, layout: FM3_BODY_LAYOUT },
};

/** Tables + layout for a model byte; throws for models without a verified
 *  calibration (never silently falls back to another device's tables). */
export function gen3BlockParamModel(modelId: number): { tables: Gen3BlockParamTables; layout: Gen3BodyLayout } {
  const m = VERIFIED_MODELS[modelId];
  if (!m) {
    throw new Error(
      `gen-3 block-param extraction is not calibrated for model 0x${modelId.toString(16)} ` +
      `(verified: ${Object.keys(VERIFIED_MODELS).map((k) => '0x' + Number(k).toString(16)).join(', ')}). ` +
      `Gen-3 paramIds and body layouts are device-specific — refusing beats plausible-but-wrong values.`,
    );
  }
  return m;
}

/** True when `readBlockParams` has a verified calibration for this model. */
export function hasBlockParamModel(modelId: number): boolean {
  return modelId in VERIFIED_MODELS;
}

// ── output shapes (unchanged from the live-validated implementation) ──

export interface DecodedBlockParam {
  paramId: number;
  /** Catalog symbol, e.g. DISTORT_TYPE. */
  name: string;
  /** Human label, e.g. "Type", "Drive". */
  label: string;
  /** 'enum' | 'float' | … from the device ranges (undefined if un-ranged). */
  kind?: string;
  /** Raw stored u16 (0..65534 model). */
  raw: number;
  /** Display value for numeric params (display units); null for enums / un-ranged params. */
  value: number | null;
  unit?: string;
  /** Resolved label for enum params (type/model/mode names). */
  enumLabel?: string;
}

export interface DecodedBlock {
  effectId: number;
  family: string;
  slug: string;
  /** 1-based instance (a family can place up to 4). */
  instance: number;
  /** Amp only: channel index 0-3 (A-D). Undefined for single-channel blocks. */
  channel?: number;
  /** The block's type/model name, when it has a single type selector. */
  typeName: string | null;
  params: DecodedBlockParam[];
}

// ── decode ─────────────────────────────────────────────────────────────

const INSTANCE_SPAN = 4; // a family reserves eid..eid+3 (instances 1..4) in the grid id space
const VALUE_MODEL_MAX = 65534;

const u16 = (body: Uint8Array, o: number): number => (o + 1 < body.length ? body[o]! | (body[o + 1]! << 8) : 0);

/** Locate a block's header in the param region: effectId u16 LE + >=8 zero bytes, at/after the floor. */
function findHeader(body: Uint8Array, eid: number, floor: number): number | null {
  for (let i = floor; i + 10 < body.length; i++) {
    if ((body[i]! | (body[i + 1]! << 8)) !== eid) continue;
    let zeros = true;
    for (let k = 2; k < 10; k++) if (body[i + k] !== 0) { zeros = false; break; }
    if (zeros) return i;
  }
  return null;
}

/** The single TYPE/model selector paramId per family (the `<FAMILY>_TYPE` catalog entry).
 *  Families whose type is multi-slot (CABINET = 4 IR slots, SYNTH = 3 voices) have none → null. */
function typeParamFor(tables: Gen3BlockParamTables, family: string): number | null {
  const exact = tables.paramsByFamily[family]?.find((p) => p.name === `${family}_TYPE`);
  return exact ? exact.paramId : null;
}

/** Resolve an enum ordinal to a label: device enum overrides first, then a clean model roster
 *  (for the type param of rostered families), else a `#ordinal` fallback. */
function enumLabel(tables: Gen3BlockParamTables, family: string, slug: string, paramId: number, isType: boolean, ord: number): string {
  const fromOverride = tables.enumOverrides[family]?.[String(paramId)]?.[ord];
  if (fromOverride) return fromOverride;
  if (isType) {
    const hit = tables.rosters[slug]?.find((r) => r.value === ord);
    if (hit) return hit.name;
  }
  return `#${ord}`;
}

function decodeOne(
  body: Uint8Array,
  tables: Gen3BlockParamTables,
  layout: Gen3BodyLayout,
  eid: number,
  family: string,
  header: number,
  instance: number,
  channel?: number,
): DecodedBlock {
  const slug = tables.familyToSlug?.[family] ?? family.toLowerCase();
  const typePid = typeParamFor(tables, family);
  const chOff = channel == null ? 0 : channel * layout.ampChannelStride;
  const ranges = tables.ranges[family] ?? {};
  const catalog = tables.paramsByFamily[family] ?? [];

  const params: DecodedBlockParam[] = [];
  let typeName: string | null = null;
  for (const { paramId, name, displayLabel, unit } of catalog) {
    const r = ranges[paramId];
    const raw = u16(body, header + layout.paramArrayBase + 2 * paramId + chOff);
    const isType = typePid != null && paramId === typePid;
    let value: number | null = null;
    let eLabel: string | undefined;
    if (r?.kind === 'enum') {
      eLabel = enumLabel(tables, family, slug, paramId, isType, raw);
    } else if (r && r.displayMax !== r.displayMin) {
      value = r.displayMin + (raw / VALUE_MODEL_MAX) * (r.displayMax - r.displayMin);
    } else {
      value = raw; // un-ranged / scale-0 param: surface the raw value
    }
    if (isType && eLabel) typeName = eLabel;
    params.push({ paramId, name, label: displayLabel ?? name, kind: r?.kind, raw, value, unit, enumLabel: eLabel });
  }
  return { effectId: eid, family, slug, instance, channel, typeName, params };
}

/**
 * Decode all placed blocks' full params from a decompressed preset body
 * (`decodeRawPatch(...).body`). `placedEids` (the grid's placed effectIds)
 * gates which instances are read — required to avoid phantom headers.
 *
 * Prefer `readBlockParamsForModel(body, placedEids, modelId)` unless you are
 * calibrating a new device.
 */
export function readBlockParams(
  body: Uint8Array,
  placedEids: ReadonlySet<number>,
  tables: Gen3BlockParamTables,
  layout: Gen3BodyLayout,
): DecodedBlock[] {
  const out: DecodedBlock[] = [];
  for (const eid of [...placedEids].sort((a, b) => a - b)) {
    const family = tables.familyByEffectId[String(eid)];
    if (!family || !tables.paramsByFamily[family]) continue;
    const header = findHeader(body, eid, layout.paramRegionFloor);
    if (header == null) continue;
    // instance number = 1 + count of same-family eids below this one that are also placed
    // (a family occupies the contiguous range eid_base..eid_base+3 in the grid id space).
    let instance = 1;
    for (let k = 1; k <= INSTANCE_SPAN; k++) {
      if (placedEids.has(eid - k) && tables.familyByEffectId[String(eid - k)] === family) instance++;
    }
    if (family === layout.ampFamily) {
      for (let ch = 0; ch < layout.ampChannels; ch++) out.push(decodeOne(body, tables, layout, eid, family, header, instance, ch));
    } else {
      out.push(decodeOne(body, tables, layout, eid, family, header, instance));
    }
  }
  return out;
}

/** Model-byte convenience over `readBlockParams`; throws for uncalibrated models. */
export function readBlockParamsForModel(body: Uint8Array, placedEids: ReadonlySet<number>, modelId: number): DecodedBlock[] {
  const { tables, layout } = gen3BlockParamModel(modelId);
  return readBlockParams(body, placedEids, tables, layout);
}

/** Compact, search-oriented projection: per family slug, the distinct TYPE/model names in use. */
export function modelsFromBlocks(blocks: readonly DecodedBlock[]): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const b of blocks) {
    if (!b.typeName || b.typeName.startsWith('#')) continue;
    (out[b.slug] ??= new Set()).add(b.typeName);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}
