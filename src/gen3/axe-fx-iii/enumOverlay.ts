/**
 * Axe-Fx III enum vocabulary overlay.
 *
 * The III params catalog (`params.ts`) tags each enum-typed parameter
 * with `unit: 'enum'` but cannot ship a `enumValues: {0: 'OFF', ...}`
 * table inline — III enum vocabularies are not in the public v1.4 spec
 * and have not been mined from the Axe-Edit III binary's `.rdata`
 * string pools yet (a substantial Ghidra workstream).
 *
 * This overlay fills the gap with three layers of evidence-tagged data:
 *
 *   1. **Hardware-verified AM4 join**. Symbols whose stem matches an
 *      AM4 entry with a confirmed `enumValues` table are reused
 *      verbatim. Tag: `'am4-shared'`. Caveat: III firmware may extend
 *      these (e.g. adding amp models post-AM4); the AM4 vocabulary
 *      is the verified *subset*, not necessarily the complete list.
 *   2. **Universal Fractal convention** (suffix-driven). Every
 *      Fractal device uses the same vocabulary for binary toggles
 *      (`_BYP`, `_MUTE`, `_ENABLE`), channel pickers (A/B/C/D),
 *      slope tables, and standard LFO waveforms. Tag: `'fractal-
 *      convention'`. Confidence: high — these vocabularies are
 *      stable across every Fractal product since the original
 *      Axe-Fx Standard (2006).
 *   3. **III-specific direct entries**. Hand-curated for III-only
 *      params with values lifted from the v1.4 PDF (where it documents
 *      a vocabulary inline) or from the AxeEdit III XML when
 *      `<EditorControl type="dropdown*">` carries an inline value
 *      list. Tag: `'iii-spec'`.
 *
 *   4. **Device-true entries**. Vocabularies that are identical on the FM3,
 *      FM9 and Axe-Fx III device label lists (LFO waveforms, tempo divisions,
 *      the delay routing list, the phaser pole count). Tag: `'device-true'`.
 *
 * Consumers use `resolveEnumValues(paramName)` to look up the
 * vocabulary; the function checks direct names first, then suffix
 * conventions.
 *
 * **The overlay is a FALLBACK, never an authority.** Every device ships its own
 * complete label lists (`*_ENUM_OVERRIDES`, one list per enum parameter), and
 * the descriptor catalog uses such a list as the whole vocabulary (it replaces
 * the overlay and the shared rosters, it is not merged with them). An overlay
 * entry that contradicted a complete device list was therefore either dead or a
 * defect: those entries are retired (see the audit notes at each rule) and
 * `test/gen3/enum-overlay-device-truth.test.ts` fails if one comes back. What
 * remains labels parameters without a device list (the VP4, symbols a device
 * lacks) and is consistent with every device list that exists.
 *
 * **Hardware verification is the user's responsibility.** A wrong
 * label in this overlay produces a misleading display but does NOT
 * misroute wire bytes (the codec layer uses raw integer values). File
 * a GitHub issue with a capture if your III shows a different label
 * for a given wire value.
 */

import {
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  GEQ_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
} from '../../am4/cacheEnums.js';

/** Provenance tag for each overlay entry. */
export type EnumProvenance = 'am4-shared' | 'fractal-convention' | 'iii-spec' | 'device-true';

/** Overlay entry — values map + provenance. */
export interface EnumOverlayEntry {
  values: Readonly<Record<number, string>>;
  provenance: EnumProvenance;
  /** Optional note explaining the entry's limitations / sources. */
  note?: string;
}

// ── Universal Fractal vocabularies ───────────────────────────────

/** Binary OFF/ON toggle — every Fractal product uses this. */
const BINARY_OFF_ON: EnumOverlayEntry = {
  values: { 0: 'OFF', 1: 'ON' },
  provenance: 'fractal-convention',
};

/** Bypassed/engaged toggle — bypass state. */
const BYPASS_STATE: EnumOverlayEntry = {
  values: { 0: 'ENGAGED', 1: 'BYPASSED' },
  provenance: 'fractal-convention',
};

/** Slope table — filter slopes in dB/octave. */
const FILTER_SLOPE: EnumOverlayEntry = {
  values: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '24 dB/OCT', 3: '36 dB/OCT' },
  provenance: 'fractal-convention',
};

/** Reverb low/high cut slope — Normal/Steep (AM4-verified, shared with III). */
const REVERB_CUT_SLOPE: EnumOverlayEntry = {
  values: { 0: 'Normal', 1: 'Steep' },
  provenance: 'am4-shared',
};

/** Input-select stereo picker (L+R / LEFT / RIGHT) — the stereo effect blocks; the amp and volume blocks define their own (see DEVICE_DEFINED). */
const INPUT_SELECT_3WAY: EnumOverlayEntry = {
  values: { 0: 'L+R', 1: 'LEFT', 2: 'RIGHT' },
  provenance: 'fractal-convention',
};

/** Mute/thru toggle. */
const MUTE_THRU: EnumOverlayEntry = {
  values: { 0: 'Thru', 1: 'Mute' },
  provenance: 'fractal-convention',
};

/** Pre/Post/Mid/End/Pre-Mid block placement. */
const PRE_POST_MID: EnumOverlayEntry = {
  values: { 0: 'PRE', 1: 'POST', 2: 'MID', 3: 'END', 4: 'PRE-MID' },
  provenance: 'fractal-convention',
};

/** Pan / NONE / RIGHT / LEFT / BOTH. */
const PAN_4WAY: EnumOverlayEntry = {
  values: { 0: 'NONE', 1: 'RIGHT', 2: 'LEFT', 3: 'BOTH' },
  provenance: 'fractal-convention',
};

/**
 * LFO waveform table — the SAME ten labels on every LFO parameter of the FM3, FM9
 * and Axe-Fx III (35 + 17 parameters, all three devices). The previous list (AM4
 * heritage: Smooth / Log / Exp / Pulse at 6..9) disagreed with the device from
 * ordinal 6 on.
 */
const LFO_WAVEFORMS: EnumOverlayEntry = {
  values: {
    0: 'SINE',
    1: 'TRIANGLE',
    2: 'SQUARE',
    3: 'SAW UP',
    4: 'SAW DOWN',
    5: 'RANDOM',
    6: 'LOG',
    7: 'EXP',
    8: 'TRAPEZOID',
    9: 'ASTABLE',
  },
  provenance: 'device-true',
  note: 'Identical on every LFO-type label list of the FM3, FM9 and Axe-Fx III.',
};

/**
 * Tempo divisions — the device's 79-entry table (0 = NONE, then 1/64 triplet up to
 * 4, then the 64th-note grid). Identical on every tempo parameter of the FM3, FM9
 * and Axe-Fx III except the pitch block's, which has no NONE entry (PITCH_TEMPO
 * below). Replaces the 23-entry AM4-heritage prefix ('4x Whole', 'Whole', ...),
 * which named different divisions at the same ordinals.
 */
const TEMPO_DIVISION_LABELS: readonly string[] = [
  'NONE ', '1/64 TRIP', '1/64', '1/64 DOT',
  '1/32 TRIP', '1/32', '1/32 DOT', '1/16 TRIP',
  '1/16', '1/16 DOT', '1/8 TRIP', '1/8',
  '1/8 DOT', '1/4 TRIP', '1/4', '1/4 DOT',
  '1/2 TRIP', '1/2', '1/2 DOT', '1 TRIP',
  '1', '1 DOT', '2', '3',
  '4', '4/3', '5/4', '5/64',
  '7/64', '9/64', '10/64 (5/32)', '11/64',
  '13/64', '14/64 (7/32)', '15/64', '17/64',
  '18/64 (9/32)', '19/64', '20/64 (5/16)', '21/64',
  '22/64 (11/32)', '23/64', '25/64', '26/64 (13/32)',
  '27/64', '28/64 (7/16)', '29/64', '30/64 (15/32)',
  '31/64', '33/64', '34/64 (17/32)', '35/64',
  '36/64 (9/16)', '37/64', '38/64 (19/32)', '39/64',
  '40/64 (5/8)', '41/64', '42/64 (21/32)', '43/64',
  '44/64 (11/16)', '45/64', '46/64 (23/32)', '47/64',
  '49/64', '50/64 (25/32)', '51/64', '52/64 (13/16)',
  '53/64', '54/64 (27/32)', '55/64', '56/64 (7/8)',
  '57/64', '58/64 (29/32)', '59/64', '60/64 (15/16)',
  '61/64', '62/64 (31/32)', '63/64',
];

const labelTable = (labels: readonly string[]): Readonly<Record<number, string>> =>
  Object.fromEntries(labels.map((l, i) => [i, l] as const));

const TEMPO_DIVISIONS: EnumOverlayEntry = {
  values: labelTable(TEMPO_DIVISION_LABELS),
  provenance: 'device-true',
  note: '79 entries, identical on every tempo label list of the FM3, FM9 and Axe-Fx III (except PITCH_TEMPO).',
};

// ── Suffix → vocabulary map ─────────────────────────────────────
//
// Order matters: more-specific suffixes first, then catch-alls.
// Each tuple is [suffix, entry] — matched against the *end* of a
// param's `name` field. The first match wins.

const SUFFIX_RULES: Array<readonly [string, EnumOverlayEntry]> = [
  // Most specific first.
  ['_LOWCUTSLOPE', REVERB_CUT_SLOPE],
  ['_HIGHCUTSLOPE', REVERB_CUT_SLOPE],
  ['_LOW_CUT_SLOPE', REVERB_CUT_SLOPE],
  ['_HIGH_CUT_SLOPE', REVERB_CUT_SLOPE],

  ['_LFO1TYPE', LFO_WAVEFORMS],
  ['_LFO2TYPE', LFO_WAVEFORMS],
  ['_LFO3TYPE', LFO_WAVEFORMS],
  ['_LFO4TYPE', LFO_WAVEFORMS],
  ['_LFO_1_TYPE', LFO_WAVEFORMS],
  ['_LFO_2_TYPE', LFO_WAVEFORMS],
  ['_LFO_3_TYPE', LFO_WAVEFORMS],
  ['_LFO_4_TYPE', LFO_WAVEFORMS],
  ['_LFO_TYPE', LFO_WAVEFORMS],
  ['_LFOTYPE', LFO_WAVEFORMS],

  ['_TEMPO', TEMPO_DIVISIONS],

  ['_SLOPE', FILTER_SLOPE],

  // `_CHANNEL` / `_CHAN` (an A/B/C/D picker) are RETIRED: every match on the device
  // lists defines its own vocabulary (MOD_CHANNEL = ALL / CHAN A..D, GLOBAL_MIDI_CHAN
  // = 1..16 / OMNI), none was the A..D picker.

  ['_INPUT_SELECT', INPUT_SELECT_3WAY],
  ['_INPUTSELECT', INPUT_SELECT_3WAY],
  ['_INSEL', INPUT_SELECT_3WAY],

  // Binary toggles — catch-all suffix tail. Apply last so more-specific
  // suffixes win.
  ['_BYP', BYPASS_STATE],
  ['_BYPASS', BYPASS_STATE],
  ['_MUTE', MUTE_THRU],
  // `_MUTE1..4` (Thru/Mute), `_ENABLE` (OFF/ON) and `_HOLD` (OFF/ON) are RETIRED:
  // every match defines its own list on the devices (CABINET_MUTEn = -- / MUTE /
  // SOLO, MULTICOMP_MUTEn = OFF / MUTE, GLOBAL_CS1_ENABLE = YES / NO, DELAY_HOLD and
  // PLEX_HOLD = OFF / STACK / HOLD; REVERB_HOLD has its direct entry below).
  ['_DISABLE', BINARY_OFF_ON],
  ['_AUTOON', BINARY_OFF_ON],
  ['_AUTOENABLE', BINARY_OFF_ON],
  ['_AUTO', BINARY_OFF_ON],
  ['_INVERT', BINARY_OFF_ON],
];

/**
 * Parameters whose vocabulary the devices define themselves, differently from the
 * generic suffix vocabulary above — the suffix rules never label these (the device
 * lists are the only truth). Audit: every name here matched a suffix rule and
 * contradicted the complete label list of the FM3, FM9 and Axe-Fx III.
 */
const DEVICE_DEFINED: ReadonlySet<string> = new Set([
  'DISTORT_INPUTSELECT', // LEFT / RIGHT / SUM L+R (the amp has no L+R entry)
  'VOLUME_INPUTSELECT', // STEREO / LEFT ONLY / RIGHT ONLY
  'CHORUS_AUTO', // OFF / LOW / HIGH
  'FLANGER_AUTO', // OFF / LOW / MED / HIGH
  'FLANGER_OLD_AUTO',
  'OLD_FLANGER_AUTO',
]);

// ── Effect-type model lists (gen-3 read leg, BK-093) ─────────────
//
// An effect block's `*_TYPE` selector is an enum whose ORDINAL index is the value
// the gen-3 state-broadcast / GET wire carries, and the discrete-SET value (a
// gen-3 discrete SET carries float32(read-ordinal) at payload pos 12, sub 09 00:
// set-by-name resolves off the same table). The lists below are the effect types
// whose AM4-heritage table AGREES with the complete label list of the FM3, FM9 and
// Axe-Fx III (audited ordinal by ordinal). They are a fallback for parameters
// without a device list; a device list always replaces them.
//
// RETIRED (the AM4-heritage list contradicted all three device lists, so it was
// wrong or dead wherever a device list exists): REVERB_TYPE (naming: 'Room, Small'
// vs the device's 'Small Room'; 78 of 79 labels differ), CHORUS_TYPE (the device
// lists carry 18 / 27 models, the AM4 table 20), FLANGER_TYPE (31 models on the
// device, 32 in the AM4 table), COMP_TYPE (the two VCA names are worded the other
// way round), FUZZ_TYPE (43 of 86 labels differ from ordinal 31 on) and DELAY_TYPE
// (this symbol is the delay ROUTING list on every gen-3 device - MONO / STEREO /
// PING-PONG / DUAL / REVERSE / SWEEP / TAPE / SURROUND - the delay models are the
// separate DELAY_MODEL parameter, whose lists differ per device and are never an
// overlay). The VP4 has no device label lists; its AM4-heritage type tables live in
// the VP4 config (`enum_overrides`), unverified, instead of in this shared overlay.

const EFFECT_TYPE_NOTE =
  'Effect-type ordinals reused from AM4 by family where they agree with the FM3/FM9/Axe-Fx III ' +
  'device lists (audited). The ordinal is also the discrete-SET value, so these set by name.';

function effectType(values: Readonly<Record<number, string>>): EnumOverlayEntry {
  return { values, provenance: 'am4-shared', note: EFFECT_TYPE_NOTE };
}

const EFFECT_TYPE_OVERRIDES: Record<string, EnumOverlayEntry> = {
  PHASER_TYPE: effectType(PHASER_TYPES_VALUES),
  WAH_TYPE: effectType(WAH_TYPES_VALUES),
  // DISTORT_TYPE deliberately has NO entry. On gen-3 the DISTORT family is
  // the AMP block, so DISTORT_TYPE is the amp MODEL selector, not a drive-
  // pedal picker. The AM4 DRIVE/AMP_TYPES tables are NOT a valid ordinal
  // oracle for gen-3 amp ordinals (FM9 ordinals 65/179/264 exceed AM4's 248
  // entries and the names disagree), so labeling it from AM4 would fabricate
  // wrong amp model names. The amp model names come from the device label list
  // (and, below it, the shared gen-3 read roster); this overlay just stays out
  // of amp's way. FUZZ_TYPE (the drive/fuzz pedal selector) has no entry either:
  // the AM4 drive table disagrees with the device list from ordinal 31 on.
  GEQ_TYPE: effectType(GEQ_TYPES_VALUES),
  FILTER_TYPE: effectType(FILTER_TYPES_VALUES),
  TREMOLO_TYPE: effectType(TREMOLO_TYPES_VALUES),
  ENHANCER_TYPE: effectType(ENHANCER_TYPES_VALUES),
  GATE_TYPE: effectType(GATE_TYPES_VALUES),
};

// ── Direct-name overrides ────────────────────────────────────────
//
// Entries for params where a suffix rule would be wrong or where the vocabulary
// is non-standard. RETIRED (contradicted the device lists): GLOBAL_CABINETBYP,
// GLOBAL_PWRAMPBYP, GLOBAL_TUNERMUTE, GLOBAL_DELAYSPILL (each has its own device
// list: ACTIVE / ... , ON / OFF, three- and five-entry lists) and
// REVERB_NUMSPRINGS (an integer 2..6 on the device, not a 1..3 enum).

const DIRECT_OVERRIDES: Record<string, EnumOverlayEntry> = {
  ...EFFECT_TYPE_OVERRIDES,
  GLOBAL_USETUNEOFFSETS: BINARY_OFF_ON,
  REVERB_HOLD: {
    values: { 0: 'OFF', 1: 'STACK', 2: 'HOLD' },
    provenance: 'am4-shared',
  },
  // The delay ROUTING list (the model list is DELAY_MODEL, see the effect-type notes).
  DELAY_TYPE: {
    values: { 0: 'MONO', 1: 'STEREO', 2: 'PING-PONG', 3: 'DUAL', 4: 'REVERSE', 5: 'SWEEP', 6: 'TAPE', 7: 'SURROUND' },
    provenance: 'device-true',
    note: 'Delay routing (identical on the FM3, FM9 and Axe-Fx III). The delay models are DELAY_MODEL.',
  },
  // Phaser pole count: an enum of 6 labels (ordinal 0..5 = 2..12 poles), not a 1..12 count.
  PHASER_ORDER: {
    values: { 0: '2', 1: '4', 2: '6', 3: '8', 4: '10', 5: '12' },
    provenance: 'device-true',
    note: 'Pole count; identical on the FM3, FM9 and Axe-Fx III.',
  },
  // The pitch block's tempo list is the shared table without its leading NONE entry.
  PITCH_TEMPO: {
    values: labelTable(TEMPO_DIVISION_LABELS.slice(1)),
    provenance: 'device-true',
    note: '78 entries: the tempo table without NONE.',
  },
  PRESET_BAND: {
    values: { 0: 'Low', 1: 'Mid', 2: 'High' },
    provenance: 'iii-spec',
    note: 'Multiband processor band-index — inferred from editor layout.',
  },
};

// ── Public API ────────────────────────────────────────────────────

/**
 * Look up an enum vocabulary for an III parameter by its symbol name.
 *
 *   resolveEnumValues('GLOBAL_USETUNEOFFSETS')
 *     → { values: { 0: 'OFF', 1: 'ON' }, provenance: 'fractal-convention' }
 *
 *   resolveEnumValues('CHORUS_LFOTYPE')
 *     → { values: { 0: 'SINE', 1: 'TRIANGLE', ... }, provenance: 'device-true', note: ... }
 *
 *   resolveEnumValues('GLOBAL_TUNERMUTE')   // the devices define their own list: no overlay
 *     → undefined
 *
 *   resolveEnumValues('NOT_A_REAL_PARAM')
 *     → undefined
 *
 * Lookup order: direct overrides first, then suffix rules in
 * declaration order (never for a name the devices define themselves).
 */
export function resolveEnumValues(name: string): EnumOverlayEntry | undefined {
  const direct = DIRECT_OVERRIDES[name];
  if (direct) return direct;
  if (DEVICE_DEFINED.has(name)) return undefined;
  for (const [suffix, entry] of SUFFIX_RULES) {
    if (name.endsWith(suffix)) return entry;
  }
  return undefined;
}

/**
 * Strict effect-type-only resolver: returns the byte-anchored `*_TYPE` model
 * list for a param ONLY if its symbol is one of the curated effect-type
 * overrides. Unlike `resolveEnumValues`, it does NOT apply the broad suffix
 * conventions (`_BYP`, `_CHAN`, `_TEMPO`, `_SLOPE`, ...).
 *
 * Consumers that wire enum labels onto a catalog whose params are NOT reliably
 * tagged `unit: 'enum'` (the FM3/FM9 device-true catalogs are all
 * `unit: 'unverified'`) use this to label the high-confidence effect-type
 * selectors without over-matching a continuous param that merely shares a
 * suffix. The full `resolveEnumValues` is correct only when the param is known
 * to be an enum (e.g. the III, whose catalog tags `unit: 'enum'`).
 */
export function resolveEffectTypeEnum(name: string): EnumOverlayEntry | undefined {
  return EFFECT_TYPE_OVERRIDES[name];
}

/**
 * Audit-friendly statistics for a calibration verifier or coverage
 * report. Returns the number of entries in each tier.
 */
export function enumOverlayStats(): {
  directOverrides: number;
  suffixRules: number;
} {
  return {
    directOverrides: Object.keys(DIRECT_OVERRIDES).length,
    suffixRules: SUFFIX_RULES.length,
  };
}
