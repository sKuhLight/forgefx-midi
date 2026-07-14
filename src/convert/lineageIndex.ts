/**
 * Unified cross-device model-lineage index for the preset converter.
 *
 * The converter needs to answer one question repeatedly: given a model on a
 * source device (e.g. AM4 amp "USA MK IIC+"), which model on the TARGET device
 * is the same amp — or the closest relative? Every generation stores that
 * knowledge in a different shape:
 *
 *   - `src/shared/lineage/*.json`      — AM4 lineage, keyed by `am4Name`, with
 *                                        structured `basedOn` (manufacturer /
 *                                        model / productName).
 *   - `src/devices/gen2/lineageLookup` — Axe-Fx II lineage, keyed by
 *                                        `axefx2Name` + `wireIndex` (the native
 *                                        ordinal) + a cross-key `am4Name`.
 *   - `src/gen3/fm3/rosters.generated` — FM3 rosters carry inline `{value,
 *                                        name, manufacturer, basedOn}`.
 *   - FM9 rosters + III read rosters   — ordinal → name only (NO lineage). The
 *                                        III/FM9/FM3 amp/drive/reverb model
 *                                        NAMES overlap heavily, so III + FM9
 *                                        records inherit FM3's lineage by
 *                                        name-identity rather than duplicating
 *                                        it.
 *
 * `buildLineageIndex()` folds all of the above into ONE table of records keyed
 * by `(family, normalized-name)`. Records that share an exact name across the
 * gen-3 trio collapse into a single record carrying a `device → nativeValue`
 * map, so a name looked up once yields the ordinal on every device that hosts
 * it. `matchModel()` then ranks target candidates for a source model through a
 * fixed confidence ladder (exact → lineage → fuzzy → fallback).
 *
 * Pure data + pure functions; no runtime deps. The index is memoized.
 */

import type { ConverterDeviceId, ConverterFamily } from './families.js';
import { loadLineage, type LineageBlock } from '../shared/lineageLookup.js';
import {
  loadAxeFxIILineage,
  type AxeFxIILineageBlock,
} from '../devices/gen2/lineageLookup.js';
import { FM3_ROSTERS } from '../gen3/fm3/rosters.generated.js';
import {
  FM9_AMP_ROSTER,
  FM9_DRIVE_ROSTER,
  FM9_REVERB_TYPE_ROSTER,
} from '../gen3/fm9/rosters.generated.js';
import { GEN3_READ_ROSTERS } from '../gen3/axe-fx-iii/gen3ReadRosters.js';

// ── Public types ─────────────────────────────────────────────────────

/** Structured lineage ("based on" real gear), normalized across sources. */
export interface LineageBasedOn {
  /** Free-form primary description (AM4/FM3 wording). */
  primary?: string;
  manufacturer?: string;
  model?: string;
  productName?: string;
  /** Where the fact came from (corpus / roster tag). */
  source?: string;
}

/**
 * One model in the unified index. A model hosted on several devices under the
 * SAME name is a single record; `deviceValues` maps each hosting device to its
 * native ordinal (value `undefined` when the source carried no ordinal — e.g.
 * AM4 lineage records).
 */
export interface LineageIndexRecord {
  family: ConverterFamily;
  /** Canonical display name (first spelling seen; ties broken by device order). */
  nativeName: string;
  /** Hosting device → native ordinal value (undefined ordinal = name-only source). */
  deviceValues: Map<ConverterDeviceId, number | undefined>;
  /** Lineage, when any contributing source carried it. */
  basedOn?: LineageBasedOn;
  /** Convenience mirror of `basedOn.manufacturer`, when known. */
  manufacturer?: string;
}

/** The built index. */
export interface LineageIndex {
  /** All records. */
  readonly records: readonly LineageIndexRecord[];
  /** Records grouped by family. */
  readonly byFamily: ReadonlyMap<ConverterFamily, readonly LineageIndexRecord[]>;
}

/** How confidently a target model was matched to a source model. */
export type LineageConfidence = 'exact' | 'lineage' | 'fuzzy' | 'fallback';

/** One ranked candidate on the target device. */
export interface LineageMatch {
  targetTypeName: string;
  targetTypeValue?: number;
  confidence: LineageConfidence;
  /** Numeric fuzzy score (only present for `confidence: 'fuzzy'`). */
  score?: number;
  /** Short human note on why this matched. */
  via?: string;
}

/** A source model to match FROM. */
export interface LineageSource {
  device: ConverterDeviceId;
  family: ConverterFamily;
  typeName: string;
  typeValue?: number;
}

// ── Source → family maps ─────────────────────────────────────────────

/** FM3 roster key → converter family. */
const FM3_ROSTER_FAMILY: Readonly<Record<string, ConverterFamily>> = {
  amp: 'amp',
  cab: 'cab',
  comp: 'compressor',
  delay: 'delay',
  drive: 'drive',
  geq: 'geq',
  reverb: 'reverb',
  wah: 'wah',
};

/** III read-roster param key → converter family. */
const III_ROSTER_FAMILY: Readonly<Record<string, ConverterFamily>> = {
  DISTORT_TYPE: 'amp',
  FUZZ_TYPE: 'drive',
  REVERB_TYPE: 'reverb',
  DELAY_TYPE: 'delay',
  CHORUS_TYPE: 'chorus',
  COMP_TYPE: 'compressor',
  FLANGER_TYPE: 'flanger',
  PHASER_TYPE: 'phaser',
  TREMOLO_TYPE: 'tremolo',
  WAH_TYPE: 'wah',
  FILTER_TYPE: 'filter',
};

/** AM4 lineage block → converter family (block names already match). */
const AM4_LINEAGE_FAMILY: Readonly<Record<LineageBlock, ConverterFamily>> = {
  amp: 'amp',
  drive: 'drive',
  reverb: 'reverb',
  delay: 'delay',
  compressor: 'compressor',
  phaser: 'phaser',
  chorus: 'chorus',
  flanger: 'flanger',
  wah: 'wah',
};

/** Axe-Fx II lineage block → converter family. */
const GEN2_LINEAGE_FAMILY: Readonly<Record<AxeFxIILineageBlock, ConverterFamily>> = {
  amp: 'amp',
  drive: 'drive',
  reverb: 'reverb',
  delay: 'delay',
};

// ── Normalization helpers ────────────────────────────────────────────

const lc = (s: string): string => s.trim().toLowerCase();

/** Name key for dedup: lowercase, collapse runs of non-alphanumerics to one space. */
function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Word tokens (length ≥ 2) for fuzzy overlap. */
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

/** Prefer a structured basedOn over a bare one when merging duplicates. */
function basedOnRichness(b: LineageBasedOn | undefined): number {
  if (!b) return 0;
  return (
    (b.manufacturer ? 1 : 0) +
    (b.model ? 1 : 0) +
    (b.productName ? 1 : 0) +
    (b.primary ? 1 : 0)
  );
}

// ── Index construction ───────────────────────────────────────────────

interface RawEntry {
  family: ConverterFamily;
  device: ConverterDeviceId;
  nativeName: string;
  nativeValue?: number;
  basedOn?: LineageBasedOn;
}

function collectRawEntries(): RawEntry[] {
  const out: RawEntry[] = [];

  // FM3 rosters — inline lineage.
  for (const [key, models] of Object.entries(FM3_ROSTERS)) {
    const family = FM3_ROSTER_FAMILY[key];
    if (!family) continue;
    for (const m of models) {
      out.push({
        family,
        device: 'fm3',
        nativeName: m.name,
        nativeValue: m.value,
        basedOn:
          m.basedOn || m.manufacturer
            ? {
                primary: m.basedOn ?? undefined,
                manufacturer: m.manufacturer ?? undefined,
                source: 'fm3-roster',
              }
            : undefined,
      });
    }
  }

  // FM9 rosters — ordinal → name only.
  const fm9: Array<[ConverterFamily, Readonly<Record<number, string>>]> = [
    ['amp', FM9_AMP_ROSTER],
    ['drive', FM9_DRIVE_ROSTER],
    ['reverb', FM9_REVERB_TYPE_ROSTER],
  ];
  for (const [family, roster] of fm9) {
    for (const [ord, name] of Object.entries(roster)) {
      out.push({ family, device: 'fm9', nativeName: name, nativeValue: Number(ord) });
    }
  }

  // Axe-Fx III read rosters — ordinal → name only.
  for (const [key, roster] of Object.entries(GEN3_READ_ROSTERS)) {
    const family = III_ROSTER_FAMILY[key];
    if (!family) continue;
    for (const [ord, name] of Object.entries(roster)) {
      out.push({ family, device: 'axe-fx-iii', nativeName: name, nativeValue: Number(ord) });
    }
  }

  // AM4 lineage — structured basedOn, no ordinal.
  for (const block of Object.keys(AM4_LINEAGE_FAMILY) as LineageBlock[]) {
    const family = AM4_LINEAGE_FAMILY[block];
    for (const rec of loadLineage(block)) {
      out.push({
        family,
        device: 'am4',
        nativeName: rec.am4Name,
        basedOn: rec.basedOn
          ? {
              primary: rec.basedOn.primary,
              manufacturer: rec.basedOn.manufacturer,
              model: rec.basedOn.model,
              productName: rec.basedOn.productName,
              source: rec.basedOn.source,
            }
          : undefined,
      });
    }
  }

  // Axe-Fx II lineage — axefx2Name + wireIndex + structured basedOn.
  for (const block of Object.keys(GEN2_LINEAGE_FAMILY) as AxeFxIILineageBlock[]) {
    const family = GEN2_LINEAGE_FAMILY[block];
    for (const rec of loadAxeFxIILineage(block)) {
      if (rec.matchVia === 'unmatched' && !rec.basedOn) {
        // Still index the name/ordinal so exact-name matching works; just no lineage.
      }
      out.push({
        family,
        device: 'axe-fx-ii',
        nativeName: rec.axefx2Name,
        nativeValue: rec.wireIndex,
        basedOn: rec.basedOn
          ? {
              primary: rec.basedOn.primary,
              manufacturer: rec.basedOn.manufacturer,
              model: rec.basedOn.model,
              productName: rec.basedOn.productName,
              source: rec.basedOn.source,
            }
          : undefined,
      });
    }
  }

  return out;
}

/** Device precedence for choosing the canonical display spelling (richest first). */
const DEVICE_ORDER: readonly ConverterDeviceId[] = [
  'axe-fx-iii',
  'fm3',
  'fm9',
  'am4',
  'axe-fx-ii',
];

let CACHED: LineageIndex | undefined;

/** Build (and memoize) the unified lineage index. */
export function buildLineageIndex(): LineageIndex {
  if (CACHED) return CACHED;

  const byKey = new Map<string, LineageIndexRecord>();
  for (const e of collectRawEntries()) {
    const key = `${e.family} ${normName(e.nativeName)}`;
    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        family: e.family,
        nativeName: e.nativeName,
        deviceValues: new Map(),
        basedOn: e.basedOn,
        manufacturer: e.basedOn?.manufacturer,
      };
      byKey.set(key, rec);
    }
    // Record this device's ordinal (first non-undefined wins for a device).
    if (!rec.deviceValues.has(e.device) || rec.deviceValues.get(e.device) === undefined) {
      rec.deviceValues.set(e.device, e.nativeValue);
    }
    // Prefer the richest lineage seen.
    if (basedOnRichness(e.basedOn) > basedOnRichness(rec.basedOn)) {
      rec.basedOn = e.basedOn;
      rec.manufacturer = e.basedOn?.manufacturer ?? rec.manufacturer;
    } else if (!rec.manufacturer && e.basedOn?.manufacturer) {
      rec.manufacturer = e.basedOn.manufacturer;
    }
    // Prefer a canonical spelling from the higher-precedence device.
    const curDev = DEVICE_ORDER.indexOf(e.device);
    const bestDev = Math.min(
      ...[...rec.deviceValues.keys()].map((d) => {
        const i = DEVICE_ORDER.indexOf(d);
        return i < 0 ? DEVICE_ORDER.length : i;
      }),
    );
    if (curDev >= 0 && curDev <= bestDev) rec.nativeName = e.nativeName;
  }

  const records = [...byKey.values()];
  const byFamily = new Map<ConverterFamily, LineageIndexRecord[]>();
  for (const r of records) {
    const list = byFamily.get(r.family) ?? [];
    list.push(r);
    byFamily.set(r.family, list);
  }

  CACHED = { records, byFamily };
  return CACHED;
}

/** Test/tooling hook — drop the memoized index. */
export function resetLineageIndexCache(): void {
  CACHED = undefined;
}

// ── Roster membership ────────────────────────────────────────────────

/**
 * Whether a device's roster data can confirm a model.
 *   - `present` — the target's roster data carries the (normalized) name.
 *   - `absent`  — the target HAS roster data for the family, name not in it.
 *   - `unknown` — no roster data for (family, device); nothing to check.
 */
export type ModelPresence = 'present' | 'absent' | 'unknown';

/**
 * Cheap per-family roster-membership check, used by the P2 engine's
 * shared-roster short-circuit: on a same-roster device pair types pass through
 * verbatim UNLESS the target's (reduced) roster verifiably lacks the model.
 * Backed by the same folded index `matchModel` uses (FM3/FM9 generated
 * rosters, III read rosters, AM4 / Axe-Fx II lineage names).
 */
export function modelOnDevice(
  family: ConverterFamily,
  typeName: string,
  device: ConverterDeviceId,
): ModelPresence {
  const famRecords = buildLineageIndex().byFamily.get(family);
  if (!famRecords || famRecords.length === 0) return 'unknown';
  const targetRecords = famRecords.filter((r) => r.deviceValues.has(device));
  if (targetRecords.length === 0) return 'unknown';
  const n = normName(typeName);
  return targetRecords.some((r) => normName(r.nativeName) === n) ? 'present' : 'absent';
}

// ── Matching ─────────────────────────────────────────────────────────

/** A basedOn identity key for lineage matching, or `undefined` if too thin. */
function basedIdentity(b: LineageBasedOn | undefined): string | undefined {
  if (!b) return undefined;
  if (b.manufacturer && b.model) return `${lc(b.manufacturer)}|${lc(b.model)}`;
  return undefined;
}

/**
 * True when two lineages describe the same real gear. Strong path: identical
 * manufacturer+model. Bridge path (for FM3-style records that carry only a
 * free-text `primary` + manufacturer): same manufacturer AND the other side's
 * structured model appears as a whole word in this side's primary text.
 */
function sameLineage(a: LineageBasedOn | undefined, b: LineageBasedOn | undefined): boolean {
  if (!a || !b) return false;
  const ida = basedIdentity(a);
  const idb = basedIdentity(b);
  if (ida && idb) return ida === idb;
  if (!a.manufacturer || !b.manufacturer) return false;
  if (lc(a.manufacturer) !== lc(b.manufacturer)) return false;
  const containsModel = (text: string | undefined, model: string | undefined): boolean => {
    if (!text || !model || model.length < 2) return false;
    return new RegExp(`\\b${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
  };
  return (
    containsModel(a.primary, b.model) ||
    containsModel(b.primary, a.model) ||
    (a.primary !== undefined && b.primary !== undefined && lc(a.primary) === lc(b.primary))
  );
}

/** Fuzzy score of a target record against a source descriptor. Higher = closer. */
function fuzzyScore(
  src: { nativeName: string; basedOn?: LineageBasedOn; manufacturer?: string },
  tgt: LineageIndexRecord,
): number {
  let s = 0;
  const sn = normName(src.nativeName);
  const tn = normName(tgt.nativeName);
  if (sn && tn) {
    if (sn === tn) s += 12;
    else if (tn.includes(sn) || sn.includes(tn)) s += 6;
  }
  const tt = new Set(tokens(tgt.nativeName));
  for (const w of new Set(tokens(src.nativeName))) if (tt.has(w)) s += 2;
  const sMfr = src.manufacturer ?? src.basedOn?.manufacturer;
  if (sMfr && tgt.manufacturer && lc(sMfr) === lc(tgt.manufacturer)) s += 4;
  if (src.basedOn?.model && tgt.basedOn?.model && lc(src.basedOn.model) === lc(tgt.basedOn.model)) {
    s += 6;
  }
  return s;
}

/** Cap on fuzzy candidates returned. */
const MAX_FUZZY = 8;

/**
 * Rank target-device candidates for a source model. Ladder:
 *   1. `exact`    — identical (normalized) name on the target.
 *   2. `lineage`  — same real gear (basedOn identity / bridge).
 *   3. `fuzzy`    — token/name/manufacturer overlap, ranked by `score`.
 *   4. `fallback` — the family's lowest-ordinal target model (only when the
 *                   family has target data but nothing else matched).
 *
 * Returns `[]` when the target device hosts no models in the family (no roster
 * data) or the family is unknown — the P2 engine then emits an unresolved-type
 * event.
 */
export function matchModel(source: LineageSource, targetDevice: ConverterDeviceId): LineageMatch[] {
  const idx = buildLineageIndex();
  const famRecords = idx.byFamily.get(source.family);
  if (!famRecords || famRecords.length === 0) return [];

  const targetRecords = famRecords.filter((r) => r.deviceValues.has(targetDevice));
  if (targetRecords.length === 0) return [];

  // Locate the source record (by name, else by device+ordinal) for lineage/fuzzy.
  const srcNorm = normName(source.typeName);
  const srcRec =
    famRecords.find((r) => normName(r.nativeName) === srcNorm) ??
    (source.typeValue !== undefined
      ? famRecords.find((r) => r.deviceValues.get(source.device) === source.typeValue)
      : undefined);
  const srcDesc = {
    nativeName: srcRec?.nativeName ?? source.typeName,
    basedOn: srcRec?.basedOn,
    manufacturer: srcRec?.manufacturer,
  };

  const out: LineageMatch[] = [];
  const claimed = new Set<LineageIndexRecord>();
  const emit = (r: LineageIndexRecord, confidence: LineageConfidence, via: string, score?: number): void => {
    if (claimed.has(r)) return;
    claimed.add(r);
    out.push({
      targetTypeName: r.nativeName,
      targetTypeValue: r.deviceValues.get(targetDevice),
      confidence,
      ...(score !== undefined ? { score } : {}),
      via,
    });
  };

  // 1. exact name.
  for (const r of targetRecords) {
    if (normName(r.nativeName) === srcNorm) emit(r, 'exact', 'exact-name');
  }
  // 2. lineage identity (needs source lineage).
  if (srcDesc.basedOn) {
    for (const r of targetRecords) {
      if (sameLineage(srcDesc.basedOn, r.basedOn)) emit(r, 'lineage', 'based-on-identity');
    }
  }
  // 3. fuzzy.
  const scored = targetRecords
    .filter((r) => !claimed.has(r))
    .map((r) => ({ r, score: fuzzyScore(srcDesc, r) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FUZZY);
  for (const { r, score } of scored) emit(r, 'fuzzy', 'name/lineage-overlap', score);

  // 4. fallback (only if nothing matched at all).
  if (out.length === 0) {
    let best: LineageIndexRecord | undefined;
    let bestOrd = Number.POSITIVE_INFINITY;
    for (const r of targetRecords) {
      const ord = r.deviceValues.get(targetDevice);
      const o = ord ?? Number.MAX_SAFE_INTEGER;
      if (o < bestOrd) {
        bestOrd = o;
        best = r;
      }
    }
    if (best) emit(best, 'fallback', 'family-default');
  }

  return out;
}
