/**
 * Device-agnostic preset intermediate representation (IR).
 *
 * A `ConverterPreset` is the neutral shape every device adapter lifts INTO and
 * (in P1/P2) the conversion engine lowers OUT OF. It is designed to be
 * lossless-from-source and best-effort-to-target:
 *   - The lift captures everything the current per-device decode exposes and
 *     tags how much that was (`decodeDepth`, per-block `liftedFrom`), so the
 *     engine and the UI can be honest about conversion quality.
 *   - Both routing VIEWS are kept: the raw grid (when the source is grid-
 *     shaped) AND a derived series/parallel chain view, so a grid target and a
 *     chain target can each be driven without re-deriving from the other.
 *
 * Full conversion-quality provenance on every lifted field is out of scope for
 * P0 (it is P2's job); the flags below are the minimum the engine needs.
 */

import type { ConverterDeviceId, ConverterFamily } from './families.js';

/**
 * How completely a preset (or a single block) was decoded from its source.
 *   - `full`     — the source decode exposes routing + per-block state.
 *   - `partial`  — some structured state (name, scenes, one block family).
 *   - `skeleton` — identity only (name, scene names, chain slots).
 */
export type ConverterDecodeDepth = 'full' | 'partial' | 'skeleton';

/** Per-block lift fidelity: did this block's fields come from a full decode? */
export type ConverterLiftSource = 'full-decode' | 'partial-decode';

/** One parameter carried on a block. */
export interface ConverterParam {
  /**
   * The device param ADDRESS (the codec `readBlockParams` paramId), when known.
   *
   * On a LIFTED (un-converted) preset this is the SOURCE device's id, straight
   * from the decode. On a CONVERTED preset it is always the TARGET device's id:
   * gen-3 paramIds are device-specific (the same param name has a different id
   * on FM3 / FM9 / III), so the conversion engine re-resolves each param's id to
   * the target device via its `conceptKey` (`targetRanges.targetParamId`) — the
   * carried source id is only left as-is when source and target are the SAME
   * device. A converted param whose concept the target does not expose carries
   * NO id (the author skips it rather than poke a foreign/absent address). The
   * upshot: on a converted preset this id is a valid address for the TARGET, so
   * the authoring encoder can always write the param directly by id.
   */
  paramId?: number;
  /** The device-native param name, verbatim (e.g. `gain`, `master_volume`). */
  nativeName: string;
  /**
   * The FULL, un-stripped param symbol from the source device's catalog — the
   * form gen-3 devices SHARE across their catalogs (e.g. `DISTORT_DRIVE`,
   * `PEQ_GAIN1`). `nativeName` strips the `<FAMILY>_` prefix and lower-cases for
   * the concept-key join; this keeps the exact catalog key so a cross-device
   * conversion can NAME-JOIN a param that has no concept key onto the target's
   * own paramId (`targetRanges.targetParamIdByName`). Present only on gen-3
   * lifts (the shared-vocabulary family); absent for AM4 / gen-1 / gen-2, whose
   * catalogs do not share this symbol space.
   */
  sharedName?: string;
  /**
   * The cross-device concept key this param resolves to (e.g.
   * `amp.preamp_gain`), when the concept-key registry knows it. Absent for
   * params with no cross-device concept mapping.
   */
  conceptKey?: string;
  /** The raw numeric value as decoded from the source. */
  value: number;
  /** Normalized 0..1 value, when the source scale is known. */
  normalized?: number;
  /** Human-facing display string (e.g. `"5.1"`, `"USA MK IIC+"`), when known. */
  displayValue?: string;
  /**
   * Target-device display range, attached by the P2 engine when a real range
   * table covers this param (see `targetRanges.ts`). Absent for
   * `param-unverified` params — the editor then renders a coarse knob.
   */
  min?: number;
  max?: number;
  /** Short display-unit symbol (e.g. `dB`, `Hz`), when the range table names one. */
  unit?: string;
  /** Logarithmic taper (frequency / time knobs) — interpolate geometrically. */
  log?: boolean;
  /**
   * Ordered enum option labels (index = ordinal), attached when the target
   * param is a cleanly-labelled enum. Present → the editor renders a dropdown.
   */
  enumOptions?: readonly string[];
}

/** A grid coordinate position (grid-shaped devices). */
export interface ConverterGridPosition {
  row: number;
  col: number;
}

/** A slot/chain index position (slot- or chain-shaped devices). */
export interface ConverterSlotPosition {
  slot: number;
}

export type ConverterBlockPosition = ConverterGridPosition | ConverterSlotPosition;

/** Per-block channel state (gen-3 A/B/C/D channels; other devices single). */
export interface ConverterBlockChannels {
  /** How many channels the block exposes / uses. */
  count: number;
  /** Per-scene active channel index (0-based), one entry per scene, when known. */
  perScene?: number[];
}

/** One block lifted into the IR. Shunts are routing-only and are NOT blocks. */
export interface ConverterBlock {
  /**
   * Stable key within this preset, `<family><instance>` (e.g. `amp1`,
   * `drive2`). Referenced by `routing.seriesChains`.
   */
  key: string;
  /** The universal family this block belongs to. */
  family: ConverterFamily;
  /** 1-based instance within the family. */
  instance: number;
  /** The block's type/model display name, when decoded (e.g. amp model). */
  typeName?: string;
  /** The block's type/model wire value, when decoded. */
  typeValue?: number;
  /** Decoded parameters (may be empty when only identity was decoded). */
  params: ConverterParam[];
  /** Channel state, when the source exposes per-channel data. */
  channels?: ConverterBlockChannels;
  /** Per-scene bypass state, one entry per scene, when known. */
  bypassPerScene?: boolean[];
  /** Placement on the source device, when known. */
  position?: ConverterBlockPosition;
  /** How completely this block was decoded from its source. */
  liftedFrom: ConverterLiftSource;
}

/** One grid cell in the source routing grid (blocks AND shunts). */
export interface ConverterGridCell {
  row: number;
  col: number;
  /** Source-native effect id (gen-3), when present. */
  effectId?: number;
  /** Display name of the cell content (e.g. `"Amp 1"`, `"Shunt 3"`). */
  name: string;
  /** The block key this cell maps to (absent for shunts / unmatched cells). */
  blockKey?: string;
  /** True when the cell is a routing shunt (pass-through, not a block). */
  isShunt: boolean;
  /** Raw routing flag from the source grid, when present. */
  routeFlag?: number;
  /** Source rows of the previous column that feed this cell, when present. */
  fromRows?: number[];
}

/**
 * Both routing views.
 *   - `gridCells` — the source grid verbatim (grid-shaped devices only).
 *   - `seriesChains` — block keys in signal order; parallel branches are
 *     emitted as separate chains. Shunts are traversed for connectivity but
 *     never appear as chain entries (they are routing-only).
 */
export interface ConverterRouting {
  gridCells?: ConverterGridCell[];
  seriesChains: string[][];
}

/** Optional lift metadata / caveats. */
export interface ConverterPresetMeta {
  /** Source device model byte, when known. */
  modelByte?: number;
  /** Free-form notes about lift limitations (skeleton reasons, etc.). */
  notes?: string[];
  /**
   * Set by the P2 conversion engine on a converted preset: the device this
   * preset was converted FROM (mirrors the ORIGINAL `sourceDevice`, which the
   * engine deliberately leaves unchanged for provenance).
   */
  convertedFrom?: ConverterDeviceId;
  /** Set by the P2 conversion engine: the device this preset was converted TO. */
  convertedTo?: ConverterDeviceId;
  [key: string]: unknown;
}

/** A whole preset in device-agnostic form. */
export interface ConverterPreset {
  /** The device this preset was lifted from. */
  sourceDevice: ConverterDeviceId;
  /** Preset name (empty string when the source didn't carry one). */
  name: string;
  /** Per-scene names, when the source decodes them. */
  sceneNames?: string[];
  /** Number of scenes the source device carries. */
  sceneCount: number;
  /** Lifted blocks (shunts excluded; they live in `routing.gridCells`). */
  blocks: ConverterBlock[];
  /** Routing, both views. */
  routing: ConverterRouting;
  /** How completely the preset was decoded from its source. */
  decodeDepth: ConverterDecodeDepth;
  /** Optional lift metadata. */
  meta?: ConverterPresetMeta;
}
