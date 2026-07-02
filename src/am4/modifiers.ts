/**
 * AM4 modifier model — field roster + enumerations.
 *
 * A modifier attaches a modulation source to a target parameter and shapes it (range +
 * transfer curve + damping), exactly like the gen-3 modifier. The AM4 exposes 16 modifier
 * slots (`ID_MODIFIER1..16` in the editor's block enum; the modifier is editor block-ordinal
 * 3, the same slot the gen-3 devices use).
 *
 * The field roster below is the modifier block's parameter list, recovered from the editor's
 * effectDefinitions cache and cross-checked against `VARIANT_RESOLVER_BY_EFFECT_TYPE[3]`
 * (parameterName → cacheId). The enums (source / secondary source / operation / channel /
 * auto-engage / damping) are verbatim from the same cache.
 *
 * ── WIRE PATH IS NOT YET PINNED (do not send blind) ─────────────────
 * Unlike a signal-chain block, the modifier has NO entry in `BLOCK_TYPE_VALUES`, so its wire
 * `pidLow` is unknown, and the AM4 editor manages modifiers through dedicated opcodes
 * (`CONNECT_MODIFIER` / `GET_MODIFIER` / `DISCONNECT_MODIFIER`) whose frame shape has not been
 * captured. So this module ships the modifier DATA (fields + enums, for a UI / editor model)
 * but intentionally provides no SET/bind builder yet — that needs one hardware capture to pin
 * the address (pidLow, or the CONNECT_MODIFIER payload). `cacheId` here is the editor cache
 * record id, NOT a confirmed wire pidHigh. See docs and the AM4 modifier findings.
 */

import { VARIANT_RESOLVER_BY_EFFECT_TYPE } from './variantResolverTables.js';

/** Editor block-ordinal of the modifier (ID_MODIFIER); shared with the gen-3 devices. */
export const AM4_MOD_EFFECT_ORDINAL = 3;

/** Modifier slots exposed by the AM4 (ID_MODIFIER1..16). */
export const AM4_MOD_SLOT_COUNT = 16;

/**
 * Modulation sources (MOD_CTRLID / MOD_CTRLID2), ordinal → name. Verbatim from the editor
 * cache's modifier-block source enum. Ordinal is the wire value (0-based); the editor lists
 * them 1-based.
 */
export const AM4_MODIFIER_SOURCES: readonly { ordinal: number; name: string }[] = [
  { ordinal: 0, name: 'None' },
  { ordinal: 1, name: 'Pedal 1' },
  { ordinal: 2, name: 'Pedal 2' },
  { ordinal: 3, name: 'External 1' },
  { ordinal: 4, name: 'External 2' },
  { ordinal: 5, name: 'External 3' },
  { ordinal: 6, name: 'External 4' },
  { ordinal: 7, name: 'LFO A' },
  { ordinal: 8, name: 'LFO B' },
  { ordinal: 9, name: 'ADSR 1' },
  { ordinal: 10, name: 'Sequencer' },
  { ordinal: 11, name: 'Envelope' },
  { ordinal: 12, name: 'Pitch' },
];

/** Two-source blend operation (MOD_OPERATION), ordinal → name. */
export const AM4_MOD_OPERATIONS: readonly string[] = ['SRC1 + SRC2', 'SRC1 - SRC2', 'SRC1 x SRC2'];

/** Channel scope a modifier applies to (MOD_CHANNEL), ordinal → name. */
export const AM4_MOD_CHANNELS: readonly string[] = ['All', 'Channel A', 'Channel B', 'Channel C', 'Channel D'];

/** Auto-engage mode (MOD_AUTOENGAGE), ordinal → name. */
export const AM4_MOD_AUTOENGAGE_MODES: readonly string[] = [
  'Off',
  'Slow Speed',
  'Medium Speed',
  'Fast Speed',
  'Slow Position',
  'Medium Position',
  'Fast Position',
];

/** Damping / transfer curve (MOD_DAMPING), ordinal → name. */
export const AM4_MOD_DAMPING_CURVES: readonly string[] = ['Exponential', 'Linear'];

export type Am4ModField =
  | 'source'
  | 'min'
  | 'max'
  | 'start'
  | 'mid'
  | 'end'
  | 'slope'
  | 'attack'
  | 'targetEffectId'
  | 'targetParam'
  | 'autoEngage'
  | 'pcReset'
  | 'offValue'
  | 'scale'
  | 'offset'
  | 'release'
  | 'rate'
  | 'channel'
  | 'xMark'
  | 'yMark'
  | 'source2'
  | 'scale1'
  | 'scale2'
  | 'operation'
  | 'damping';

export interface Am4ModFieldDef {
  /** Editor cache record id (NOT a confirmed wire pidHigh — see file header). */
  cacheId: number;
  /** 'source' = modulation-source ordinal · 'ordinal' = enum index · 'norm' = 0..1 ·
   *  'bipolar' = signed · 'time' = ms-ish knob · 'ref' = effect/param reference. */
  kind: 'source' | 'ordinal' | 'norm' | 'bipolar' | 'time' | 'ref';
  /** Editor symbol (matches VARIANT_RESOLVER_BY_EFFECT_TYPE[3]). */
  symbol: string;
  /** Short UI role label. */
  role: string;
}

/**
 * Modifier field roster, keyed by a stable field name. `cacheId` and `symbol` mirror
 * `VARIANT_RESOLVER_BY_EFFECT_TYPE[3]`; the modifier test pins them so the two can't drift.
 */
export const AM4_MOD_FIELDS: Record<Am4ModField, Am4ModFieldDef> = {
  source: { cacheId: 10, kind: 'source', symbol: 'MOD_CTRLID', role: 'Source' },
  min: { cacheId: 11, kind: 'norm', symbol: 'MOD_MIN', role: 'Range Min' },
  max: { cacheId: 12, kind: 'norm', symbol: 'MOD_MAX', role: 'Range Max' },
  start: { cacheId: 13, kind: 'norm', symbol: 'MOD_STARTPT', role: 'Mapping Start' },
  mid: { cacheId: 14, kind: 'norm', symbol: 'MOD_MIDPT', role: 'Mapping Mid' },
  end: { cacheId: 15, kind: 'norm', symbol: 'MOD_ENDPT', role: 'Mapping End' },
  slope: { cacheId: 16, kind: 'norm', symbol: 'MOD_SLOPE', role: 'Mapping Slope' },
  attack: { cacheId: 17, kind: 'time', symbol: 'MOD_ATTACK', role: 'Damping Attack' },
  targetEffectId: { cacheId: 18, kind: 'ref', symbol: 'MOD_EFFECTID', role: 'Target block' },
  targetParam: { cacheId: 19, kind: 'ref', symbol: 'MOD_PARAM', role: 'Target paramId' },
  autoEngage: { cacheId: 20, kind: 'ordinal', symbol: 'MOD_AUTOENGAGE', role: 'Auto Engage' },
  pcReset: { cacheId: 21, kind: 'ordinal', symbol: 'MOD_PCRESET', role: 'PC Reset' },
  offValue: { cacheId: 22, kind: 'norm', symbol: 'MOD_OFFVAL', role: 'Off Value' },
  scale: { cacheId: 23, kind: 'norm', symbol: 'MOD_SCALE', role: 'Mapping Scale' },
  offset: { cacheId: 24, kind: 'bipolar', symbol: 'MOD_OFFSET', role: 'Mapping Offset' },
  release: { cacheId: 25, kind: 'time', symbol: 'MOD_RELEASE', role: 'Damping Release' },
  rate: { cacheId: 26, kind: 'ordinal', symbol: 'MOD_RATE', role: 'Update Rate' },
  channel: { cacheId: 27, kind: 'ordinal', symbol: 'MOD_CHANNEL', role: 'Channel' },
  xMark: { cacheId: 28, kind: 'norm', symbol: 'MOD_XMARK', role: 'Graph X marker (editor display)' },
  yMark: { cacheId: 29, kind: 'norm', symbol: 'MOD_YMARK', role: 'Graph Y marker (editor display)' },
  source2: { cacheId: 30, kind: 'source', symbol: 'MOD_CTRLID2', role: 'Secondary source' },
  scale1: { cacheId: 31, kind: 'norm', symbol: 'MOD_SCALE1', role: 'Scale operand 1' },
  scale2: { cacheId: 32, kind: 'norm', symbol: 'MOD_SCALE2', role: 'Scale operand 2' },
  operation: { cacheId: 33, kind: 'ordinal', symbol: 'MOD_OPERATION', role: 'Source blend operation' },
  damping: { cacheId: 34, kind: 'ordinal', symbol: 'MOD_DAMPING', role: 'Damping / transfer curve' },
};

/** The modifier block's resolver table (parameterName → cacheId), for cross-checks. */
export const AM4_MOD_RESOLVER = VARIANT_RESOLVER_BY_EFFECT_TYPE[AM4_MOD_EFFECT_ORDINAL];

/** Editor cache record id for a modifier field. */
export function am4ModCacheId(field: Am4ModField): number {
  return AM4_MOD_FIELDS[field].cacheId;
}
