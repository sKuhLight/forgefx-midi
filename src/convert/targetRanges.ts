/**
 * Target-device parameter range + enum-option resolution for the P2 engine.
 *
 * When the engine lowers a param onto a target device it range-validates the
 * value against whatever range data the codebase actually ships for that
 * device, and — where the data is clean — attaches the ordered enum option
 * labels so the offline editor can render a real dropdown. This module is
 * deliberately conservative: it returns data ONLY when the source is real and
 * keyed cleanly by native param name. Where no such data exists the resolver
 * returns `undefined` and the engine emits a `param-unverified` event instead
 * of guessing.
 *
 * Range coverage today:
 *   - `am4`               — real display ranges + units + taper from the AM4
 *                           param registry (`KNOWN_PARAMS`, keyed `<block>.<name>`).
 *   - gen-3 (III/FM9/FM3) — the device-true per-family display-range tables
 *                           (`*_RANGES`, keyed FAMILY→paramId), broadened from
 *                           amp-only to EVERY family the catalog covers. The
 *                           name→paramId join is the device's own param catalog
 *                           (`*_PARAMS_BY_FAMILY`). Amp tone knobs keep the
 *                           decoder's canonical 0..10 range as a fallback.
 *   - `vp4`               — no device-true range table ships, so ranges fall
 *                           back to the catalog's AM4-inferred `displayMin/Max`
 *                           where present; otherwise `undefined`.
 *   - everything else (gen-1/gen-2) → `undefined` (param-unverified).
 *
 * Enum coverage today:
 *   - `am4`               — from each enum param's `enumValues` map, when it
 *                           densely covers ordinals 0..N-1.
 *   - gen-3 (III/FM9/FM3) — from the shared Fractal enum vocabulary overlay
 *                           (`resolveEnumValues`), gated to params the
 *                           device-true table marks `kind: 'enum'` AND whose
 *                           overlay labels densely cover 0..enumCount-1.
 *   - `vp4`, gen-1/gen-2  → no enum options (reported as a remaining gap).
 */

import type { ConverterDeviceId, ConverterFamily } from './families.js';
import { normalizeConceptPort, resolveConceptKey } from '../core/protocol-generic/concept-keys.js';
import { KNOWN_PARAMS } from '../am4/params.js';
import type { Param as Gen3Param } from '../gen3/types.js';
import { PARAMS_BY_FAMILY as AXE3_PARAMS_BY_FAMILY } from '../gen3/axe-fx-iii/params.js';
import { AXE3_RANGES } from '../gen3/axe-fx-iii/ranges.generated.js';
import { FM3_PARAMS_BY_FAMILY } from '../gen3/fm3/params.js';
import { FM3_RANGES } from '../gen3/fm3/ranges.generated.js';
import { FM9_PARAMS_BY_FAMILY } from '../gen3/fm9/params.js';
import { FM9_RANGES } from '../gen3/fm9/ranges.generated.js';
import { VP4_PARAMS_BY_FAMILY } from '../gen3/vp4/params.js';
import { resolveEnumValues } from '../gen3/axe-fx-iii/enumOverlay.js';

/** A validated target range in the device's DISPLAY units. */
export interface TargetRange {
  readonly min: number;
  readonly max: number;
  /** Short display-unit symbol (e.g. `dB`, `Hz`, `ms`), when the table names one. */
  readonly unit?: string;
  /** Logarithmic taper (e.g. frequency / time knobs) — interpolate geometrically. */
  readonly log?: boolean;
}

/**
 * gen-3 amp tone knobs share a 0..10 display range (the body decoder's scale).
 * Used as a fallback when the device-true table has no row for the knob, so the
 * amp conversion path always clamps meaningfully in both directions.
 */
const GEN3_AMP_KNOB_RANGE: TargetRange = { min: 0, max: 10 };

/** Native amp-knob names (gen-3 display words) that use the 0..10 range. */
const GEN3_AMP_KNOB_NAMES: ReadonlySet<string> = new Set([
  'drive',
  'bass',
  'mid',
  'treble',
  'presence',
  'master',
  'level',
  'depth',
  'bright',
]);

/**
 * Converter family → gen-3 catalog FAMILY symbol. Mirrors the `GEN3_FAMILY`
 * map the concept-coverage test uses; families with no gen-3 catalog analog are
 * omitted (→ no range/enum, honestly reported as coarse).
 */
const GEN3_FAMILY: Partial<Record<ConverterFamily, string>> = {
  amp: 'DISTORT',
  cab: 'CABINET',
  drive: 'FUZZ',
  compressor: 'COMP',
  multicomp: 'MULTICOMP',
  gate: 'GATE',
  geq: 'GEQ',
  peq: 'PEQ',
  filter: 'FILTER',
  delay: 'DELAY',
  multitap: 'MULTITAP',
  tentap: 'TENTAP',
  megatap: 'MEGATAP',
  plex: 'PLEX',
  reverb: 'REVERB',
  chorus: 'CHORUS',
  flanger: 'FLANGER',
  phaser: 'PHASER',
  rotary: 'ROTARY',
  tremolo: 'TREMOLO',
  pitch: 'PITCH',
  wah: 'WAH',
  formant: 'FORMANT',
  ringmod: 'RINGMOD',
  resonator: 'RESONATOR',
  synth: 'SYNTH',
  vocoder: 'VOCODER',
  volpan: 'VOLUME',
  enhancer: 'ENHANCER',
  mixer: 'MIXER',
  crossover: 'CROSSOVER',
  looper: 'LOOPER',
  input: 'INPUT',
  output: 'OUTPUT',
  controllers: 'CONTROLLERS',
  tonematch: 'TONEMATCH',
  irplayer: 'IRPLAYER',
  ircapture: 'IRCAPTURE',
  rta: 'RTA',
};

/** One device-true gen-3 range row (structural shape shared by III/FM9/FM3). */
interface Gen3RangeRow {
  readonly kind: 'enum' | 'float';
  readonly displayMin: number;
  readonly displayMax: number;
  readonly enumCount?: number;
}
type Gen3RangeTable = Readonly<Record<string, Readonly<Record<number, Gen3RangeRow>>>>;
type Gen3ParamTable = Readonly<Record<string, readonly Gen3Param[]>>;

/** Per-device gen-3 tables: name→paramId catalog + (optional) device-true ranges. */
function gen3Tables(
  device: ConverterDeviceId,
): { params: Gen3ParamTable; ranges?: Gen3RangeTable } | undefined {
  switch (device) {
    case 'axe-fx-iii':
      return { params: AXE3_PARAMS_BY_FAMILY, ranges: AXE3_RANGES as Gen3RangeTable };
    case 'fm9':
      return { params: FM9_PARAMS_BY_FAMILY, ranges: FM9_RANGES as Gen3RangeTable };
    case 'fm3':
      return { params: FM3_PARAMS_BY_FAMILY, ranges: FM3_RANGES as Gen3RangeTable };
    case 'vp4':
      return { params: VP4_PARAMS_BY_FAMILY };
    default:
      return undefined;
  }
}

/** Strip the `FAMILY_` prefix and lowercase, mirroring the concept-coverage join. */
function stripFamily(family: string, name: string): string {
  const p = `${family}_`;
  return (name.startsWith(p) ? name.slice(p.length) : name).toLowerCase();
}

/**
 * Cache of `${device}|${FAMILY}` → (strippedName → Param) so a lookup is O(1)
 * after the first hit rather than re-scanning the (large) per-family arrays.
 */
const GEN3_NAME_INDEX = new Map<string, Map<string, Gen3Param>>();

function gen3ParamFor(
  device: ConverterDeviceId,
  fam: string,
  params: Gen3ParamTable,
  nativeName: string,
): Gen3Param | undefined {
  const cacheKey = `${device}|${fam}`;
  let idx = GEN3_NAME_INDEX.get(cacheKey);
  if (idx === undefined) {
    idx = new Map<string, Gen3Param>();
    for (const p of params[fam] ?? []) {
      const stripped = stripFamily(fam, p.name);
      if (!idx.has(stripped)) idx.set(stripped, p);
    }
    GEN3_NAME_INDEX.set(cacheKey, idx);
  }
  return idx.get(nativeName.toLowerCase());
}

/** gen-3 unit tag → short display symbol. Only meaningful, unitful tags map. */
const UNIT_SYMBOL: Readonly<Record<string, string>> = {
  db: 'dB',
  hz: 'Hz',
  ms: 'ms',
  seconds: 's',
  percent: '%',
  bipolar_percent: '%',
  semitones: 'st',
  degrees: '°',
  ratio: ':1',
};

function unitSymbol(unit: string | undefined): string | undefined {
  return unit === undefined ? undefined : UNIT_SYMBOL[unit];
}

/** True when a display pair is a usable (non-degenerate) range. */
function isRealRange(min: number | undefined, max: number | undefined): boolean {
  return typeof min === 'number' && typeof max === 'number' && max !== min;
}

/** Build an ordered `0..count-1` label array, or `undefined` if it isn't dense. */
function denseOptions(
  values: Readonly<Record<number, string>>,
  count: number,
): readonly string[] | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const label = values[i];
    if (typeof label !== 'string') return undefined; // sparse / partial → skip
    out.push(label);
  }
  return out;
}

// ── AM4 resolution ───────────────────────────────────────────────────

type Am4Param = {
  unit?: string;
  displayMin?: number;
  displayMax?: number;
  enumValues?: Record<number, string>;
  scaling?: 'linear' | 'log10';
};

function am4Param(family: ConverterFamily, nativeName: string): Am4Param | undefined {
  return (KNOWN_PARAMS as Record<string, Am4Param>)[`${family}.${nativeName}`];
}

// ── gen-3 resolution ───────────────────────────────────────────────────

interface Gen3Hit {
  param: Gen3Param;
  range?: Gen3RangeRow;
}

function gen3Hit(
  device: ConverterDeviceId,
  family: ConverterFamily,
  nativeName: string,
): Gen3Hit | undefined {
  const tables = gen3Tables(device);
  const fam = GEN3_FAMILY[family];
  if (tables === undefined || fam === undefined) return undefined;
  const param = gen3ParamFor(device, fam, tables.params, nativeName);
  if (param === undefined) return undefined;
  return { param, range: tables.ranges?.[fam]?.[param.paramId] };
}

/**
 * paramIds at/above this floor are SYNTHETIC UI-only catalog entries (cab IR
 * pickers, name fields, the amp "Zero All" control) with no addressable body
 * slot — never writable. Mirrors the same floor the gen-3 lift screens on
 * (`adapters/gen3.ts`), so a resolved synthetic id is reported as "no target
 * param" rather than handed to the encoder (which would overflow the body).
 */
const SYNTHETIC_PARAM_ID_FLOOR = 0xff00;

/**
 * Resolve the TARGET device's writable paramId for a cross-device concept on a
 * given family block, or `null` when the target does not expose the concept.
 *
 * This INVERTS the lift's `paramId` + `conceptKey` annotation: the source
 * param's concept key names WHICH knob it is; this returns the id the TARGET
 * device stores that same knob at, so the authoring encoder always writes the
 * target's own address rather than a foreign SOURCE id (gen-3 paramIds are
 * device-specific — `DISTORT_DRIVE` is a different id on FM3 / FM9 / III). It
 * reuses the very same device catalog join the range/enum resolvers use
 * (`gen3Hit` → the device's `*_PARAMS_BY_FAMILY`), so there is one source of
 * truth and no hand-maintained mapping.
 *
 * Returns `null` for: a missing/unknown concept key; a non-gen-3 target (no
 * shared param catalog); a concept the target's family does not expose; or a
 * synthetic UI-only id (the author must skip it). A `null` result is honest —
 * the author leaves the param unwritten rather than guessing an address.
 */
export function targetParamId(
  device: ConverterDeviceId,
  family: ConverterFamily,
  conceptKey: string | undefined,
): number | null {
  if (conceptKey === undefined) return null;
  const resolved = resolveConceptKey(device, conceptKey);
  if (resolved === undefined) return null;
  const hit = gen3Hit(device, family, resolved.localName);
  if (hit === undefined) return null;
  const id = hit.param.paramId;
  if (!Number.isInteger(id) || id < 0 || id >= SYNTHETIC_PARAM_ID_FLOOR) return null;
  return id;
}

/**
 * FULL-catalog-name → Param index per `${device}|${FAMILY}`, keyed by the exact
 * (un-stripped) symbol (e.g. `DISTORT_DRIVE`). `null` marks an AMBIGUOUS name —
 * one that appears on more than one row of the family — so the name-join refuses
 * it rather than guessing which row was meant. Separate from `GEN3_NAME_INDEX`
 * (which keys the stripped concept name and is first-wins) precisely because the
 * name-join must be EXACT and ambiguity-aware.
 */
const GEN3_FULLNAME_INDEX = new Map<string, Map<string, Gen3Param | null>>();

function gen3ParamByFullName(
  device: ConverterDeviceId,
  fam: string,
  params: Gen3ParamTable,
  fullName: string,
): Gen3Param | null {
  const cacheKey = `${device}|${fam}`;
  let idx = GEN3_FULLNAME_INDEX.get(cacheKey);
  if (idx === undefined) {
    idx = new Map<string, Gen3Param | null>();
    for (const p of params[fam] ?? []) {
      idx.set(p.name, idx.has(p.name) ? null : p); // second sighting → ambiguous
    }
    GEN3_FULLNAME_INDEX.set(cacheKey, idx);
  }
  return idx.get(fullName) ?? null; // missing OR ambiguous → null
}

/**
 * Display-unit tags whose raw 16-bit value is a DISCRETE ordinal (enum label
 * index), a count, or an UNCONFIRMED encoding — NOT a device-portable continuous
 * magnitude. The name-join refuses these: the same ordinal can select a
 * different option on the target than on the source (roster/mic/cab indices), so
 * carrying the source raw verbatim would silently pick the wrong thing. Only
 * continuous scales (`numeric`, `db`, `hz`, `ms`, `percent`, … — the shared u16
 * 0..65534 model) are safe to copy by raw across gen-3 devices.
 */
const NAME_JOIN_EXCLUDED_UNITS: ReadonlySet<string> = new Set(['enum', 'count', 'unverified']);

/**
 * A family-stripped name ending in one of these denotes a TYPE / MODEL / MODE /
 * roster SELECTOR (a device-specific ordinal index) even where the catalog tags
 * it `numeric` — e.g. `CABINET_TYPE1` (cab-IR index), `DISTORT_BIASTYPE`. These
 * are excluded from the name-join for the same ordinal-mismatch reason as
 * `enum`s: the index space differs across devices.
 */
const NAME_JOIN_SELECTOR_SUFFIX = /(?:type\d*|mode|bank|inputsel|voicing|select|source|version)$/;

/**
 * NAME-JOIN fallback for the TARGET paramId, used ONLY when the concept-key
 * resolution (`targetParamId`) returns null. gen-3 devices share the per-family
 * param NAME vocabulary (`DISTORT_DRIVE` is the same knob on FM3 / FM9 / III,
 * only at a different id), so a param the concept registry does not cover can
 * still be addressed on the target by matching its FULL catalog symbol against
 * the target's own family table and returning the target's paramId.
 *
 * SAFE BY CONSTRUCTION — returns the target id ONLY on an EXACT, UNAMBIGUOUS,
 * single, CONTINUOUS match; every uncertain case returns `null` (skip, never
 * guess):
 *   - no shared name, no gen-3 target, or the target family has no analog → null;
 *   - the name matches zero OR more than one row of the family (ambiguous) → null;
 *   - a discrete/ordinal/unconfirmed unit (`enum`/`count`/`unverified`) → null;
 *   - a type/model/roster SELECTOR name (ordinals differ across devices) → null;
 *   - a synthetic UI-only id (`>= 0xFF00`) or a non-integer id → null.
 * Continuous params only: enum/type selectors are deliberately left to the
 * concept/type handling so a foreign ordinal is never written as a target index.
 */
export function targetParamIdByName(
  device: ConverterDeviceId,
  family: ConverterFamily,
  sharedName: string | undefined,
): number | null {
  if (sharedName === undefined || sharedName === '') return null;
  const tables = gen3Tables(device);
  const fam = GEN3_FAMILY[family];
  if (tables === undefined || fam === undefined) return null;
  const param = gen3ParamByFullName(device, fam, tables.params, sharedName);
  if (param === null) return null; // no match OR ambiguous
  if (NAME_JOIN_EXCLUDED_UNITS.has(param.unit)) return null;
  if (NAME_JOIN_SELECTOR_SUFFIX.test(stripFamily(fam, param.name))) return null;
  const id = param.paramId;
  if (!Number.isInteger(id) || id < 0 || id >= SYNTHETIC_PARAM_ID_FLOOR) return null;
  return id;
}

// ── Public resolvers ───────────────────────────────────────────────────

/**
 * Resolve the display-unit range for `nativeName` on `device`'s `family` block,
 * or `undefined` when no real range data is available (→ param-unverified).
 */
export function resolveTargetRange(
  device: ConverterDeviceId,
  family: ConverterFamily,
  nativeName: string,
): TargetRange | undefined {
  const port = normalizeConceptPort(device);

  if (port === 'am4') {
    const rec = am4Param(family, nativeName);
    if (rec && isRealRange(rec.displayMin, rec.displayMax)) {
      const lo = Math.min(rec.displayMin!, rec.displayMax!);
      const hi = Math.max(rec.displayMin!, rec.displayMax!);
      const unit = unitSymbol(rec.unit);
      const log = rec.scaling === 'log10';
      return { min: lo, max: hi, ...(unit ? { unit } : {}), ...(log ? { log } : {}) };
    }
    return undefined;
  }

  // gen-3 family (III / FM9 / FM3 / VP4 all normalize to the 'axe-fx-iii' port).
  if (port === 'axe-fx-iii') {
    const hit = gen3Hit(device, family, nativeName);
    if (hit) {
      const { param, range } = hit;
      // Prefer the device-true range; fall back to the catalog's AM4-inferred pair.
      let lo: number | undefined;
      let hi: number | undefined;
      if (range && isRealRange(range.displayMin, range.displayMax)) {
        lo = Math.min(range.displayMin, range.displayMax);
        hi = Math.max(range.displayMin, range.displayMax);
      } else if (isRealRange(param.displayMin, param.displayMax)) {
        lo = Math.min(param.displayMin!, param.displayMax!);
        hi = Math.max(param.displayMin!, param.displayMax!);
      }
      if (lo !== undefined && hi !== undefined) {
        const unit = unitSymbol(param.unit);
        const log = param.scaling === 'log10';
        return { min: lo, max: hi, ...(unit ? { unit } : {}), ...(log ? { log } : {}) };
      }
    }
    // Amp tone knobs: the decoder scales them to 0..10 — guarantee a range even
    // when the catalog join misses (keeps the amp path meaningful in both dirs).
    if (family === 'amp' && GEN3_AMP_KNOB_NAMES.has(nativeName.toLowerCase())) {
      return GEN3_AMP_KNOB_RANGE;
    }
  }

  return undefined;
}

/**
 * Resolve the ordered enum option labels for `nativeName` on `device`'s
 * `family` block (index = ordinal), or `undefined` when the param is not a
 * cleanly-labelled enum on that device. Only returns when the labels densely
 * cover ordinals `0..N-1` — a partial vocabulary is treated as "no clean data".
 */
export function resolveTargetEnumOptions(
  device: ConverterDeviceId,
  family: ConverterFamily,
  nativeName: string,
): readonly string[] | undefined {
  const port = normalizeConceptPort(device);

  if (port === 'am4') {
    const rec = am4Param(family, nativeName);
    if (rec && rec.unit === 'enum' && rec.enumValues) {
      const keys = Object.keys(rec.enumValues).map(Number);
      const max = keys.length ? Math.max(...keys) : -1;
      return denseOptions(rec.enumValues, max + 1);
    }
    return undefined;
  }

  if (port === 'axe-fx-iii') {
    const hit = gen3Hit(device, family, nativeName);
    // The device-true table is the authoritative enum signal (the FM3/FM9
    // catalogs tag every param 'unverified'); only trust an enum row.
    if (hit?.range?.kind === 'enum' && typeof hit.range.enumCount === 'number') {
      const entry = resolveEnumValues(hit.param.name);
      if (entry) return denseOptions(entry.values, hit.range.enumCount);
    }
    return undefined;
  }

  return undefined;
}
