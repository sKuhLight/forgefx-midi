/**
 * Axe-Fx III effectId <-> family map.
 *
 * The FM3 and FM9 ship such a table (`../fm3/effectIds.ts`); the Axe-Fx III did not, so the
 * driver could only name the virtual blocks and the audio blocks it already had slugs for.
 * This table closes the gap. It is built from the shared gen-3 block roster
 * (`AXE_FX_III_BLOCKS`, whose `firstId`s are device-independent) and the Axe-Fx III family
 * symbols (`FAMILIES` in `./params.ts`, the keys of the III range and enum catalogs), with the
 * III's own instance counts.
 *
 * Each entry says how far the binding is trusted:
 *   - `verified`: a binding that was already in use for the Axe-Fx III before this table
 *     existed: a spec-documented block id the III driver addresses through its block slugs, or
 *     a virtual id shared with the FM3 / FM9.
 *   - `roster`: the id is documented in the shared roster, but no definition read or capture
 *     has bound it to its family on an Axe-Fx III yet. For five of the six the III catalog's
 *     section tag equals the roster's effect-type position, which is a hint, not a binding
 *     (IR Capture has no section). Consumers serve a `roster` block READ-ONLY and never
 *     walk-hint or sweep it. A tester confirmation flips the row to `verified`.
 *     Six ids are `roster`: IR Capture (36, virtual), Vocoder (134), Crossover (142), Tone
 *     Match (170), Real-Time Analyzer (174) and IR Player (195).
 *
 * Families without an id of their own are absent or `firstId: null`:
 *   - Dynamic Distortion (`DYNDIST`) and NAM have no entry. The shared roster lists them with
 *     `firstId: null`, so no id is known; they can only be bound through a block map built
 *     from device records, or a pack.
 *   - `PRESET` is preset meta data with no effect id (`addressing: 'none'`).
 *   - The tuner (35) and the Preset FC (200) are in the roster but have no parameter family.
 *
 * Anomalies shared with the FM3: the `DISTORT` family is the Amp block (firstId 58) and the
 * `FUZZ` family is the Drive block (firstId 118); see `./blockTypes.ts`.
 *
 * NOT a generated file. If the roster changes, change it in `AXE_FX_III_BLOCKS` and mirror it
 * here; `test/gen3/axe-fx-iii/effect-ids.test.ts` cross-checks the two.
 */

import { crossBlockEffectId, type CrossBlockRefKey } from '../../editorLayouts.js';
import { gen3RosterSpan } from './blockTypes.js';

/** How a family is addressed on the wire. */
export type Axe3EffectAddressing =
  /** Placeable signal-chain block; `effectId = firstId + (instance - 1)`. */
  | 'block'
  /** Virtual / system block at a fixed effectId (not grid-placeable). */
  | 'virtual'
  /** No wire effectId of its own. */
  | 'none';

/** How far an entry's family binding is trusted (see the file header). */
export type Axe3EffectIdConfidence = 'verified' | 'roster';

/** One family -> effectId binding. */
export interface Axe3EffectIdEntry {
  /** Axe-Fx III param-family symbol, the key into `PARAMS_BY_FAMILY` and the range catalogs. */
  family: string;
  /** First-instance effectId; `null` for families with no effectId of their own (`PRESET`). */
  firstId: number | null;
  /** Number of consecutive effectIds reserved for the family (1 for singletons / virtual). */
  instances: number;
  /** Display name as shown in the Axe-Fx III editor. */
  name: string;
  /** Addressing class. */
  addressing: Axe3EffectAddressing;
  /** `verified`, or `roster` (read-only until a device read confirms it). */
  confidence: Axe3EffectIdConfidence;
}

/**
 * Axe-Fx III family -> effectId table: placeable blocks in roster order, then the virtual
 * blocks, then `PRESET`. `instances` is the span the roster reserves, as in the FM3 table.
 */
export const AXE3_EFFECT_ID_TABLE: readonly Axe3EffectIdEntry[] = [
  // -- Placeable signal-chain blocks ----------------------------------------------------
  { family: 'INPUT',       firstId: 37,  instances: 5, name: 'Input',                addressing: 'block',   confidence: 'verified' },
  { family: 'OUTPUT',      firstId: 42,  instances: 4, name: 'Output',               addressing: 'block',   confidence: 'verified' },
  { family: 'COMP',        firstId: 46,  instances: 4, name: 'Compressor',           addressing: 'block',   confidence: 'verified' },
  { family: 'GEQ',         firstId: 50,  instances: 4, name: 'Graphic EQ',           addressing: 'block',   confidence: 'verified' },
  { family: 'PEQ',         firstId: 54,  instances: 4, name: 'Parametric EQ',        addressing: 'block',   confidence: 'verified' },
  // DISTORT family IS the Amp block (no ID_AMP in the v1.4 enum).
  { family: 'DISTORT',     firstId: 58,  instances: 4, name: 'Amp',                  addressing: 'block',   confidence: 'verified' },
  { family: 'CABINET',     firstId: 62,  instances: 4, name: 'Cab',                  addressing: 'block',   confidence: 'verified' },
  { family: 'REVERB',      firstId: 66,  instances: 4, name: 'Reverb',               addressing: 'block',   confidence: 'verified' },
  { family: 'DELAY',       firstId: 70,  instances: 4, name: 'Delay',                addressing: 'block',   confidence: 'verified' },
  { family: 'MULTITAP',    firstId: 74,  instances: 4, name: 'Multitap Delay',       addressing: 'block',   confidence: 'verified' },
  { family: 'CHORUS',      firstId: 78,  instances: 4, name: 'Chorus',               addressing: 'block',   confidence: 'verified' },
  { family: 'FLANGER',     firstId: 82,  instances: 4, name: 'Flanger',              addressing: 'block',   confidence: 'verified' },
  { family: 'ROTARY',      firstId: 86,  instances: 4, name: 'Rotary',               addressing: 'block',   confidence: 'verified' },
  { family: 'PHASER',      firstId: 90,  instances: 4, name: 'Phaser',               addressing: 'block',   confidence: 'verified' },
  { family: 'WAH',         firstId: 94,  instances: 4, name: 'Wah',                  addressing: 'block',   confidence: 'verified' },
  { family: 'FORMANT',     firstId: 98,  instances: 4, name: 'Formant',              addressing: 'block',   confidence: 'verified' },
  { family: 'VOLUME',      firstId: 102, instances: 4, name: 'Volume/Pan',           addressing: 'block',   confidence: 'verified' },
  { family: 'TREMOLO',     firstId: 106, instances: 4, name: 'Pan/Tremolo',          addressing: 'block',   confidence: 'verified' },
  { family: 'PITCH',       firstId: 110, instances: 4, name: 'Pitch',                addressing: 'block',   confidence: 'verified' },
  { family: 'FILTER',      firstId: 114, instances: 4, name: 'Filter',               addressing: 'block',   confidence: 'verified' },
  // FUZZ family IS the user-facing Drive / OD / Fuzz pedal block.
  { family: 'FUZZ',        firstId: 118, instances: 4, name: 'Drive',                addressing: 'block',   confidence: 'verified' },
  { family: 'ENHANCER',    firstId: 122, instances: 4, name: 'Enhancer',             addressing: 'block',   confidence: 'verified' },
  { family: 'MIXER',       firstId: 126, instances: 4, name: 'Mixer',                addressing: 'block',   confidence: 'verified' },
  { family: 'SYNTH',       firstId: 130, instances: 4, name: 'Synth',                addressing: 'block',   confidence: 'verified' },
  { family: 'VOCODER',     firstId: 134, instances: 4, name: 'Vocoder',              addressing: 'block',   confidence: 'roster' },
  { family: 'MEGATAP',     firstId: 138, instances: 4, name: 'Megatap Delay',        addressing: 'block',   confidence: 'verified' },
  { family: 'CROSSOVER',   firstId: 142, instances: 4, name: 'Crossover',            addressing: 'block',   confidence: 'roster' },
  { family: 'GATE',        firstId: 146, instances: 4, name: 'Gate/Expander',        addressing: 'block',   confidence: 'verified' },
  { family: 'RINGMOD',     firstId: 150, instances: 4, name: 'Ring Modulator',       addressing: 'block',   confidence: 'verified' },
  { family: 'MULTICOMP',   firstId: 154, instances: 4, name: 'Multiband Compressor', addressing: 'block',   confidence: 'verified' },
  { family: 'TENTAP',      firstId: 158, instances: 4, name: 'Ten-Tap Delay',        addressing: 'block',   confidence: 'verified' },
  { family: 'RESONATOR',   firstId: 162, instances: 4, name: 'Resonator',            addressing: 'block',   confidence: 'verified' },
  { family: 'LOOPER',      firstId: 166, instances: 4, name: 'Looper',               addressing: 'block',   confidence: 'verified' },
  { family: 'TONEMATCH',   firstId: 170, instances: 4, name: 'Tone Match',           addressing: 'block',   confidence: 'roster' },
  { family: 'RTA',         firstId: 174, instances: 4, name: 'Real-Time Analyzer',   addressing: 'block',   confidence: 'roster' },
  { family: 'PLEX',        firstId: 178, instances: 4, name: 'Plex Delay',           addressing: 'block',   confidence: 'verified' },
  { family: 'FDBKSEND',    firstId: 182, instances: 4, name: 'Send',                 addressing: 'block',   confidence: 'verified' },
  { family: 'FDBKRET',     firstId: 186, instances: 4, name: 'Return',               addressing: 'block',   confidence: 'verified' },
  // Scene MIDI is the 190 singleton (MIDIBLOCK, below); the Multiplexer follows at 191.
  { family: 'MULTIPLEXER', firstId: 191, instances: 4, name: 'Multiplexer',          addressing: 'block',   confidence: 'verified' },
  { family: 'IRPLAYER',    firstId: 195, instances: 4, name: 'IR Player',            addressing: 'block',   confidence: 'roster' },

  // -- Virtual / system blocks (fixed effectId, not grid-placeable) ---------------------
  // IR Capture utility: roster id, virtual, no catalog section of its own.
  { family: 'IRCAPTURE',   firstId: 36,  instances: 1, name: 'IR Capture',           addressing: 'virtual', confidence: 'roster' },
  // Global block (setup data), shared with the FM3 / FM9.
  { family: 'GLOBAL',      firstId: 1,   instances: 1, name: 'Global',               addressing: 'virtual', confidence: 'verified' },
  // ID_CONTROL: the per-preset Controllers.
  { family: 'CONTROLLERS', firstId: 2,   instances: 1, name: 'Controllers',          addressing: 'virtual', confidence: 'verified' },
  // Modifier table: starts at 3; the slots after it (the III reserves 32) are not listed
  // here, see `AXE3_MOD_SLOT_COUNT`.
  { family: 'MOD',         firstId: 3,   instances: 1, name: 'Modifier',             addressing: 'virtual', confidence: 'verified' },
  // ID_MIDIBLOCK: the per-scene MIDI block.
  { family: 'MIDIBLOCK',   firstId: 190, instances: 1, name: 'Scene MIDI',           addressing: 'virtual', confidence: 'verified' },
  // ID_FOOTCONTROLLER: the Foot Controller configuration block.
  { family: 'FC',          firstId: 199, instances: 1, name: 'Foot Controller',      addressing: 'virtual', confidence: 'verified' },

  // -- No wire effectId of its own -----------------------------------------------------
  { family: 'PRESET',      firstId: null, instances: 1, name: 'Preset',              addressing: 'none',    confidence: 'verified' },
] as const;

/**
 * Quick lookup: Axe-Fx III family symbol -> first-instance effectId (`null` for
 * `addressing: 'none'` families). Families without an entry (`DYNDIST`) are absent.
 */
export const AXE3_EFFECT_IDS: Readonly<Record<string, number | null>> = Object.freeze(
  Object.fromEntries(AXE3_EFFECT_ID_TABLE.map((e) => [e.family, e.firstId])),
);

/**
 * Reverse lookup: FIRST-instance effectId -> family symbol (placeable and virtual blocks, as
 * the FM3 map). For any instance effectId, and for the confidence, use `axe3EffectIdEntry`.
 */
export const AXE3_FAMILY_BY_EFFECT_ID: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(
    AXE3_EFFECT_ID_TABLE.filter((e) => e.firstId !== null).map((e) => [e.firstId as number, e.family]),
  ),
);

/** Every effectId a family reserves, mapped back to its entry and 1-based instance. */
const ENTRY_BY_EFFECT_ID: ReadonlyMap<number, Readonly<{ entry: Axe3EffectIdEntry; instance: number }>> = (() => {
  const map = new Map<number, { entry: Axe3EffectIdEntry; instance: number }>();
  for (const entry of AXE3_EFFECT_ID_TABLE) {
    if (entry.firstId === null) continue;
    for (let i = 0; i < entry.instances; i++) map.set(entry.firstId + i, { entry, instance: i + 1 });
  }
  return map;
})();

/**
 * Resolve ANY effectId a family reserves (every instance, not only the first) to its table
 * entry and 1-based instance. `undefined` for an id outside the table: the unmapped ids,
 * the tuner, the Preset FC, and the modifier slots after the first.
 */
export function axe3EffectIdEntry(
  effectId: number,
): { readonly entry: Axe3EffectIdEntry; readonly instance: number } | undefined {
  return ENTRY_BY_EFFECT_ID.get(effectId);
}

/**
 * Owning effectId of an Axe-Fx III editor-layout cross-block reference
 * (`control.crossBlock`), from its token instance and resolved family, over
 * THIS table (never the FM3 one): `ID_GLOBAL` → 1, `ID_FOOTCONTROLLER` → 199,
 * `ID_OUTPUT2` → 43, `ID_DISTORT2` → 59. `MOD` / `PRESET` refs, families
 * without an id (`DYNDIST`) and an instance beyond `instanceCount` give null.
 *
 * `instanceCount` is the connected device's instance count for the referenced
 * family (the host's per-device instance limits; 1 for singletons), capped by
 * the id span the shared gen-3 roster reserves (`gen3RosterSpan`). The id of a
 * `roster` entry resolves like any other; serving it read-only is the host's
 * call (`axe3EffectIdEntry` gives the confidence). See `crossBlockEffectId`.
 */
export function axe3CrossBlockEffectId(ref: CrossBlockRefKey, instanceCount: number): number | null {
  return crossBlockEffectId(ref, AXE3_EFFECT_IDS, instanceCount, gen3RosterSpan);
}

/**
 * Resolve `(family, instance)` to a concrete effectId.
 *
 * @param family Axe-Fx III param-family symbol (e.g. `'DISTORT'`, `'FC'`).
 * @param instance 1-based instance (default 1).
 * @returns the wire effectId, or `null` if the family is not in the table, has no effectId of
 *   its own (`PRESET`) or `instance` is out of range.
 */
export function axe3EffectId(family: string, instance = 1): number | null {
  const entry = AXE3_EFFECT_ID_TABLE.find((e) => e.family === family);
  if (!entry || entry.firstId === null) return null;
  if (!Number.isInteger(instance) || instance < 1 || instance > entry.instances) return null;
  return entry.firstId + (instance - 1);
}
