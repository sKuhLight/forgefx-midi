/**
 * Cross-device preset-converter block-family taxonomy.
 *
 * The converter needs ONE vocabulary of block "families" that spans every
 * Fractal generation, so an amp on an Axe-Fx II, an FM3, and an AM4 all read
 * as the same family (`'amp'`) and the conversion engine (P1/P2) can decide
 * how to place it on the target. This module is the P0 foundation: it derives
 * that family vocabulary + the per-device native→family mappings MECHANICALLY
 * from the existing per-device block tables, so there is a single source of
 * protocol truth and no hand-copied roster data.
 *
 * Derivation rule (see `docs/PRESET-CONVERTER-IR.md`):
 *   - Each device's OWN block table is imported and every entry's display
 *     identity is normalized (`normalizeBlockToken`) and looked up in one
 *     small alias table (`FAMILY_ALIASES`). Because the alias table is keyed
 *     by the normalized token, it simultaneously covers gen-3 display names,
 *     the gen-3 body-decoder's own block vocabulary, gen-2 display names,
 *     gen-1 slugs, and the AM4 lowercase names — one table, every generation.
 *   - VP4 has no block table of its own (its chain carries shared gen-3
 *     effect IDs), so its family PRESENCE is expressed as an explicit,
 *     documented effect roster (`VP4_FAMILIES`). Its per-slot native decode
 *     resolves through the gen-3 table at adapter time.
 *
 * If any device-table entry fails to resolve to a family, it lands in
 * `UNMAPPED_NATIVES` and the families test fails — that array must stay empty.
 */

import { AXE_FX_III_BLOCKS } from '../gen3/axe-fx-iii/blockTypes.js';
import { AXE_FX_II_BLOCKS } from '../gen2/axe-fx-ii/blockTypes.js';
import { AXE_FX_GEN1_BLOCKS } from '../gen1/blockTypes.js';
import { BLOCK_TYPE_VALUES } from '../am4/blockTypes.js';

// ── Device identity ──────────────────────────────────────────────────

/** Every device the converter can lift FROM or (eventually) place ONTO. */
export type ConverterDeviceId =
  | 'axe-fx-iii'
  | 'fm9'
  | 'fm3'
  | 'vp4'
  | 'am4'
  | 'axe-fx-ii'
  | 'axe-fx-gen1';

/** All converter device ids, in stack order (gen-3 → VP4 → AM4 → gen-2 → gen-1). */
export const CONVERTER_DEVICE_IDS: readonly ConverterDeviceId[] = [
  'axe-fx-iii',
  'fm9',
  'fm3',
  'vp4',
  'am4',
  'axe-fx-ii',
  'axe-fx-gen1',
] as const;

/** The three model bytes that share the gen-3 (Axe-Fx III) block roster + body decode. */
export const GEN3_DEVICE_IDS = ['axe-fx-iii', 'fm9', 'fm3'] as const;
export type Gen3DeviceId = (typeof GEN3_DEVICE_IDS)[number];

// ── Family vocabulary ────────────────────────────────────────────────

/**
 * The universal block-family vocabulary. One entry per DISTINCT block
 * identity found across all generations — cross-family equivalence (e.g.
 * routing a `plex` onto a target that only has `delay`) is deliberately NOT
 * collapsed here; that is the conversion engine's job (P1/P2). Keeping one
 * family per block identity guarantees a lossless, unambiguous lift.
 */
export const CONVERTER_FAMILIES = [
  // ── Core tone chain ──
  'amp',
  'cab',
  'drive',
  // ── Dynamics / EQ ──
  'compressor',
  'multicomp', // Multiband Compressor
  'gate',
  'geq',
  'peq',
  'filter',
  // ── Time-based ──
  'delay',
  'multitap', // Multitap / Multi Delay
  'tentap', // Ten-Tap Delay
  'megatap', // Megatap Delay
  'plex', // Plex Delay
  'reverb',
  // ── Modulation ──
  'chorus', // incl. Quad Chorus
  'flanger',
  'phaser',
  'rotary',
  'tremolo', // Pan/Tremolo, Tremolo/Panner
  // ── Pitch / filter FX ──
  'pitch',
  'wah',
  'formant',
  'ringmod',
  'resonator',
  'synth',
  'vocoder',
  // ── Utility / level / routing ──
  'volpan',
  'enhancer',
  'mixer',
  'crossover',
  'looper',
  'fxloop', // FX Loop / Effects Loop (gen-1/gen-2)
  'multiplexer',
  'send',
  'return',
  'shunt', // grid pass-through primitive (routing-only)
  'input',
  'output',
  // ── Control / analysis / capture (non-signal) ──
  'controllers',
  'scenemidi',
  'footcontroller',
  'presetfc',
  'tuner',
  'tonematch',
  'irplayer',
  'ircapture',
  'rta', // Real-Time Analyzer
  // ── Modern gen-3 additions (post-1.13, no v1.4 effect id) ──
  'nam', // Neural Amp Modeler
  'dynadist', // Dynamic Distortion
  'globalblock',
] as const;

export type ConverterFamily = (typeof CONVERTER_FAMILIES)[number];

const FAMILY_SET: ReadonlySet<string> = new Set(CONVERTER_FAMILIES);

/** True when `f` is a member of the family vocabulary. */
export function isConverterFamily(f: string): f is ConverterFamily {
  return FAMILY_SET.has(f);
}

// ── Native → family resolution ───────────────────────────────────────

/**
 * Normalize a block identity token to a comparison key: lowercase, drop every
 * non-alphanumeric character (spaces, slashes, dashes, underscores), then
 * strip a trailing instance number. This folds "Amp 1", "AMP", "amp",
 * "Vol/Pan 2", "vol_pan", "Graphic EQ 1" and "graphic_eq" onto stable keys
 * so ONE alias table serves every generation's naming convention.
 */
export function normalizeBlockToken(name: string): string {
  const compact = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return compact.replace(/\d+$/, '');
}

/**
 * Normalized-token → family. This is the single hand-maintained mapping in the
 * module. Each key is the output of `normalizeBlockToken` for one of the
 * spellings a device table uses; grouped by family with the reason a spelling
 * needs an entry (a divergent word, not just a case/spacing variant).
 */
const FAMILY_ALIASES: Readonly<Record<string, ConverterFamily>> = Object.freeze({
  // amp / cab / drive
  amp: 'amp',
  cab: 'cab',
  cabinet: 'cab', // gen-1 "Cabinet"
  drive: 'drive',
  fuzz: 'drive', // gen-3 groupCode family word (FUZ)
  // dynamics / eq
  comp: 'compressor', // gen-3 body-decoder name
  compressor: 'compressor',
  multicomp: 'multicomp', // gen-3 body-decoder name
  multibandcompressor: 'multicomp',
  multibandcomp: 'multicomp', // gen-1 slug "multiband_comp"
  gate: 'gate',
  gateexpander: 'gate', // gen-2 "Gate Expander" / gen-1 "gate_expander"
  noisegate: 'gate', // gen-1 "noise_gate"
  inputnoisegate: 'gate', // gen-2 "Input Noise Gate"
  geq: 'geq',
  graphiceq: 'geq',
  peq: 'peq',
  parametriceq: 'peq',
  filter: 'filter',
  // time-based
  delay: 'delay',
  multitap: 'multitap', // gen-3 body-decoder name
  multitapdelay: 'multitap',
  multidelay: 'multitap', // gen-2 "Multi Delay" / gen-1 "multi_delay"
  tentap: 'tentap', // gen-3 body-decoder name
  tentapdelay: 'tentap',
  megatap: 'megatap', // gen-3 body-decoder name
  megatapdelay: 'megatap',
  plex: 'plex',
  plexdelay: 'plex',
  reverb: 'reverb',
  // modulation
  chorus: 'chorus',
  quadchorus: 'chorus', // gen-1/gen-2 "Quad Chorus"
  flanger: 'flanger',
  phaser: 'phaser',
  rotary: 'rotary',
  rotaryspeaker: 'rotary', // gen-2 "Rotary Speaker"
  tremolo: 'tremolo',
  pantremolo: 'tremolo', // gen-3 "Pan/Tremolo"
  tremolopanner: 'tremolo', // gen-2 "Tremolo/Panner"
  pannertremolo: 'tremolo', // gen-1 "Panner/Tremolo"
  pantrem: 'tremolo', // gen-1 slug "pan_trem"
  // pitch / filter FX
  pitch: 'pitch',
  wah: 'wah',
  wahwah: 'wah', // gen-1 "Wahwah"
  formant: 'formant',
  ringmod: 'ringmod', // gen-3 body-decoder name / gen-1 slug
  ringmodulator: 'ringmod',
  resonator: 'resonator',
  synth: 'synth',
  vocoder: 'vocoder',
  // utility / level / routing
  volpan: 'volpan', // gen-3 body-decoder name / AM4 / gen-1 slug "vol_pan"
  volumepan: 'volpan',
  enhancer: 'enhancer',
  mixer: 'mixer',
  multiplexer: 'multiplexer',
  crossover: 'crossover',
  looper: 'looper',
  fxloop: 'fxloop', // gen-2 "FX Loop"
  effectsloop: 'fxloop', // gen-1 "Effects Loop"
  send: 'send',
  feedbacksend: 'send', // gen-2 "Feedback Send"
  return: 'return',
  feedbackreturn: 'return', // gen-2 "Feedback Return" / gen-1 slug
  shunt: 'shunt',
  input: 'input',
  output: 'output',
  // control / analysis / capture
  controllers: 'controllers',
  scenemidi: 'scenemidi',
  footcontroller: 'footcontroller',
  presetfc: 'presetfc',
  tuner: 'tuner',
  tonematch: 'tonematch',
  irplayer: 'irplayer',
  ircapture: 'ircapture',
  rta: 'rta',
  realtimeanalyzer: 'rta',
  // modern gen-3 additions
  nam: 'nam',
  dynamicdistortion: 'dynadist',
  globalblock: 'globalblock',
});

/**
 * Resolve any device block identity (display name, gen-3 body name, gen-1 slug,
 * AM4 lowercase name) to a converter family, or `undefined` if unknown.
 */
export function resolveFamily(name: string): ConverterFamily | undefined {
  return FAMILY_ALIASES[normalizeBlockToken(name)];
}

// ── Per-device native → family tables (built from the source tables) ──

/** One device-native block identity paired with its resolved family. */
export interface NativeFamilyEntry {
  /** The device-native block identity (display name, slug, or AM4 name). */
  readonly native: string;
  /** The resolved family (`undefined` only when unmapped — a taxonomy bug). */
  readonly family: ConverterFamily | undefined;
  /** Availability tag, gen-3 only (`undefined` = shipped on III + FM9 + FM3). */
  readonly availability?: string;
}

/** gen-3 shared roster (III / FM9 / FM3), native = AxeEdit-III display name. */
export const GEN3_NATIVE_FAMILIES: readonly NativeFamilyEntry[] = AXE_FX_III_BLOCKS.map(
  (b) => ({ native: b.name, family: resolveFamily(b.name), availability: b.availability }),
);

/** Axe-Fx II roster, native = display name. */
export const GEN2_NATIVE_FAMILIES: readonly NativeFamilyEntry[] = AXE_FX_II_BLOCKS.map(
  (b) => ({ native: b.name, family: resolveFamily(b.name) }),
);

/** gen-1 (Standard/Ultra) roster, native = block slug. */
export const GEN1_NATIVE_FAMILIES: readonly NativeFamilyEntry[] = AXE_FX_GEN1_BLOCKS.map(
  (b) => ({ native: b.slug, family: resolveFamily(b.slug) }),
);

/** AM4 roster, native = lowercase block name ("none" is the empty slot, dropped). */
export const AM4_NATIVE_FAMILIES: readonly NativeFamilyEntry[] = Object.keys(BLOCK_TYPE_VALUES)
  .filter((k) => k !== 'none')
  .map((k) => ({ native: k, family: resolveFamily(k) }));

/**
 * Every native-table entry whose identity failed to resolve to a family. MUST
 * stay empty — the families test asserts it. A non-empty array means a device
 * table gained a block spelling with no `FAMILY_ALIASES` entry.
 */
export const UNMAPPED_NATIVES: ReadonlyArray<{ device: ConverterDeviceId; native: string }> = (() => {
  const out: { device: ConverterDeviceId; native: string }[] = [];
  const push = (device: ConverterDeviceId, entries: readonly NativeFamilyEntry[]): void => {
    for (const e of entries) if (e.family === undefined) out.push({ device, native: e.native });
  };
  // gen-3 devices share one roster; report it once under axe-fx-iii.
  push('axe-fx-iii', GEN3_NATIVE_FAMILIES);
  push('axe-fx-ii', GEN2_NATIVE_FAMILIES);
  push('axe-fx-gen1', GEN1_NATIVE_FAMILIES);
  push('am4', AM4_NATIVE_FAMILIES);
  return out;
})();

/**
 * The native block table for a device (the raw source rows, each with its
 * resolved family). gen-3 model bytes share the Axe-Fx III roster.
 */
export function deviceNativeFamilies(device: ConverterDeviceId): readonly NativeFamilyEntry[] {
  switch (device) {
    case 'axe-fx-iii':
    case 'fm9':
    case 'fm3':
      return GEN3_NATIVE_FAMILIES;
    case 'axe-fx-ii':
      return GEN2_NATIVE_FAMILIES;
    case 'axe-fx-gen1':
      return GEN1_NATIVE_FAMILIES;
    case 'am4':
      return AM4_NATIVE_FAMILIES;
    case 'vp4':
      // VP4 has no native table — its slots carry shared gen-3 effect IDs.
      // Present its roster as the gen-3 entries within VP4's effect subset.
      return GEN3_NATIVE_FAMILIES.filter(
        (e) => e.family !== undefined && VP4_FAMILIES.has(e.family),
      );
  }
}

// ── Family presence per device ───────────────────────────────────────

/**
 * gen-3 availability gate: which model bytes ship a given roster entry. The
 * table's `availability` field is authoritative; absent = all three.
 */
function gen3EntryOnDevice(availability: string | undefined, device: Gen3DeviceId): boolean {
  if (availability === undefined) return true; // III + FM9 + FM3
  switch (availability) {
    case 'iii-only':
      return device === 'axe-fx-iii';
    case 'iii+fm9':
      return device === 'axe-fx-iii' || device === 'fm9';
    case 'iii+fm9+fm3':
      return true;
    case 'utility-only':
      return true; // present as a utility block on all gen-3 units
    default:
      return true;
  }
}

/**
 * VP4 effect roster. The VP4 ("Virtual Pedalboard") is a 4-slot serial
 * multi-effects unit with NO amp/cab modeling and none of the III-only
 * utility/analysis/routing blocks. Expressed explicitly because the VP4 has
 * no block table of its own (its chain carries shared gen-3 effect IDs).
 *
 * COMMUNITY-BETA: derived from the VP4's product scope (pedalboard effects),
 * not a captured roster — the exact hosted set is capture-pending. The two
 * load-bearing facts the converter relies on are firm: VP4 has NO `amp` and
 * DOES host `pitch`.
 */
export const VP4_FAMILIES: ReadonlySet<ConverterFamily> = new Set<ConverterFamily>([
  'drive',
  'compressor',
  'multicomp',
  'gate',
  'geq',
  'peq',
  'filter',
  'delay',
  'multitap',
  'tentap',
  'megatap',
  'plex',
  'reverb',
  'chorus',
  'flanger',
  'phaser',
  'rotary',
  'tremolo',
  'pitch',
  'wah',
  'formant',
  'ringmod',
  'resonator',
  'synth',
  'vocoder',
  'volpan',
  'enhancer',
  'looper',
]);

const PRESENCE_CACHE = new Map<ConverterDeviceId, ReadonlySet<ConverterFamily>>();

/** The set of families a device exposes. */
export function familyPresence(device: ConverterDeviceId): ReadonlySet<ConverterFamily> {
  const cached = PRESENCE_CACHE.get(device);
  if (cached) return cached;

  let set: Set<ConverterFamily>;
  if (device === 'vp4') {
    set = new Set(VP4_FAMILIES);
  } else if (device === 'axe-fx-iii' || device === 'fm9' || device === 'fm3') {
    set = new Set();
    for (const e of GEN3_NATIVE_FAMILIES) {
      if (e.family !== undefined && gen3EntryOnDevice(e.availability, device)) set.add(e.family);
    }
  } else {
    set = new Set();
    for (const e of deviceNativeFamilies(device)) {
      if (e.family !== undefined) set.add(e.family);
    }
  }
  const frozen: ReadonlySet<ConverterFamily> = set;
  PRESENCE_CACHE.set(device, frozen);
  return frozen;
}

/** True when `device` can host `family`. */
export function deviceHasFamily(device: ConverterDeviceId, family: ConverterFamily): boolean {
  return familyPresence(device).has(family);
}

// ── Device topology / capacity ───────────────────────────────────────

/**
 * A device's block-hosting capacity model.
 *   - `grid`  — routing grid of `rows × cols` cells (gen-3, gen-2, gen-1).
 *   - `slots` — a fixed number of slots, one instance per family (AM4).
 *   - `chain` — a fixed-length serial chain (VP4).
 *   - `unknown` — shape not established.
 */
export type ConverterTopology =
  | { readonly kind: 'grid'; readonly rows: number; readonly cols: number; readonly confirmed: boolean }
  | { readonly kind: 'slots'; readonly slots: number; readonly instancing: 'single-per-family' }
  | { readonly kind: 'chain'; readonly slots: number }
  | { readonly kind: 'unknown' };

/** Count of AM4 block families (its single-instance slots), excluding "none". */
const AM4_SLOT_COUNT = Object.keys(BLOCK_TYPE_VALUES).filter((k) => k !== 'none').length;

/** The capacity model for a device. */
export function deviceTopology(device: ConverterDeviceId): ConverterTopology {
  switch (device) {
    case 'axe-fx-iii':
    case 'fm9':
      return { kind: 'grid', rows: 6, cols: 14, confirmed: true };
    case 'fm3':
      return { kind: 'grid', rows: 4, cols: 12, confirmed: true };
    case 'axe-fx-ii':
      return { kind: 'grid', rows: 4, cols: 12, confirmed: true };
    case 'axe-fx-gen1':
      // Axe-Fx Standard/Ultra grid; community-documented 4×12 layout,
      // not confirmed against an in-repo capture (no gen-1 adapter yet).
      return { kind: 'grid', rows: 4, cols: 12, confirmed: false };
    case 'am4':
      return { kind: 'slots', slots: AM4_SLOT_COUNT, instancing: 'single-per-family' };
    case 'vp4':
      return { kind: 'chain', slots: 4 };
  }
}

// ── Shared type-roster identity ──────────────────────────────────────
//
// The gen-3 trio (III / FM9 / FM3) and the VP4 run the same gen-3 effect
// codec: block/type ordinals AND display names are one shared vocabulary
// (mirroring how `normalizeConceptPort` folds these model ids onto the one
// `axe-fx-iii` concept-key column). When source and target share the roster,
// the P2 engine passes types through VERBATIM instead of re-matching them —
// except where the target's reduced roster genuinely lacks a specific model.

/** Device → type-roster slug. Devices with the same slug share one block/type vocabulary. */
export const TYPE_ROSTER_SLUGS: Readonly<Record<ConverterDeviceId, string>> = Object.freeze({
  'axe-fx-iii': 'gen3',
  fm9: 'gen3',
  fm3: 'gen3',
  vp4: 'gen3',
  am4: 'am4',
  'axe-fx-ii': 'axe-fx-ii',
  'axe-fx-gen1': 'axe-fx-gen1',
});

/** True when `a` and `b` share one block/type roster (types transfer verbatim). */
export function sharesTypeRoster(a: ConverterDeviceId, b: ConverterDeviceId): boolean {
  return TYPE_ROSTER_SLUGS[a] === TYPE_ROSTER_SLUGS[b];
}

// ── Scene / channel capacity per device ──────────────────────────────
//
// These two constants drive the P2 engine's scene- and channel-collapse
// steps. They are device FACTS (how many scenes a preset carries; how many
// per-block channels the device exposes), kept here as named exports so the
// ForgeFX/Axis layers reference one source of truth rather than re-deriving.

/**
 * How many scenes a device's preset carries.
 *   - gen-3 (III / FM9 / FM3) + Axe-Fx II: 8 scenes.
 *   - AM4 + VP4: 4 scenes.
 *   - gen-1 (Standard/Ultra): no scene system — a single implicit scene.
 */
export function deviceSceneCount(device: ConverterDeviceId): number {
  switch (device) {
    case 'axe-fx-iii':
    case 'fm9':
    case 'fm3':
    case 'axe-fx-ii':
      return 8;
    case 'am4':
    case 'vp4':
      return 4;
    case 'axe-fx-gen1':
      return 1;
  }
}

/**
 * How many channels a single block exposes on a device (per-block preset
 * variations, NOT scenes).
 *   - gen-3 + AM4 + VP4: 4 channels (A/B/C/D).
 *   - Axe-Fx II: 2 channels (X/Y).
 *   - gen-1: no per-block channels (a single implicit channel).
 */
export function deviceChannelCount(device: ConverterDeviceId): number {
  switch (device) {
    case 'axe-fx-iii':
    case 'fm9':
    case 'fm3':
    case 'am4':
    case 'vp4':
      return 4;
    case 'axe-fx-ii':
      return 2;
    case 'axe-fx-gen1':
      return 1;
  }
}
