/**
 * FM9 Modifier parameter map.
 *
 * A modifier attaches a modulation source to a target parameter and shapes it (range + transfer
 * curve + damping). The FM9 has 32 modifier slots; slot N (1-based) is its own virtual effect
 * addressed as effectId `FM9_MOD_EFFECT_ID + (N-1)`. Settings are written as standard gen-3 SET
 * frames (model byte 0x12 = FM9):
 *   `F0 00 01 74 12 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   sub `09 00` discrete · `52 00` continuous. Every value uses the 5×7bit IEEE-754 f32 payload
 *   (ordinals and effectId/paramId references are sent as the integer's float).
 *
 * Provenance (2026-07-02): the field map (pid → role) is FM9 DEVICE-TRUE, byte-exact from FM9-Edit's
 * OWN binary — every pid was mined directly from the `{ int32 id, int32 pad, char* name }` struct
 * array in the macOS Mach-O's `__const` (Ghidra) AND independently resolves by name against
 * `FM9_PARAMS` (the MOD family). The field map is byte-identical to the FM3 (shared gen-3 modifier
 * firmware). The slot ID enum (`ID_NULL`=0, `ID_GLOBAL`=1, `ID_CONTROL`=2, `ID_MODIFIER1`=3 …
 * `ID_MODIFIER32`) is confirmed present and in order in the FM9 binary, pinning eid 3 / 32 slots.
 * paramIds are DEVICE-SPECIFIC — never reuse another device's.
 *
 * ── Target binding (per-control assignment) ─────────────────────────
 * The modifier→target link lives ON the modifier itself, as two of its own params:
 *   pid 8 = `targetEffectId` — the block being modulated
 *   pid 9 = `targetParam`    — the paramId within that block
 * To bind a modifier slot to `(blockEid, paramId)` with a given source, SET on the slot's eid:
 *   (eid, 8) = blockEid · (eid, 9) = paramId · (eid, 0) = sourceOrdinal · then shape with the curve pids.
 * See `fm9ModBindFrames`.
 *
 * NOT shipped (unconfirmed for FM9): the modulation-SOURCE ordinal table (the value written to
 * pid 0). The source list is runtime-built and device-specific (FM9 has its own pedal / FC / control-
 * switch counts); the FM3's ordinals were pinned on FM3 hardware and must not be assumed for FM9.
 * Recover them from one FM9 capture (write a known source, read back the ordinal) before shipping.
 */

/** ID_MODIFIER1. Slot N (1-based) = FM9_MOD_EFFECT_ID + (N-1), through slot 32. */
export const FM9_MOD_EFFECT_ID = 3;
export const FM9_MOD_SLOT_COUNT = 32;
export const fm9ModSlotEid = (slot1Based: number): number => FM9_MOD_EFFECT_ID + (slot1Based - 1);

export type Fm9ModField =
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
  | 'updateRate'
  | 'channel'
  | 'xMark'
  | 'yMark'
  | 'ctrlId2'
  | 'scale1'
  | 'scale2'
  | 'operation'
  | 'damping';

export interface Fm9ModFieldDef {
  pid: number;
  /** 'ordinal' = enum/index · 'norm' = 0..1 · 'bipolar' = signed (±) · 'ref' = effectId/paramId reference. */
  kind: 'ordinal' | 'norm' | 'bipolar' | 'ref';
  /** name in FM9_PARAMS this pid corresponds to. */
  paramName: string;
  /** short UI role label. */
  role: string;
}

/** Modifier field map — device-true (join against FM9_PARAMS by paramName). */
export const FM9_MOD_FIELDS: Record<Fm9ModField, Fm9ModFieldDef> = {
  source: { pid: 0, kind: 'ordinal', paramName: 'MOD_CTRLID', role: 'Source' },
  min: { pid: 1, kind: 'norm', paramName: 'MOD_MIN', role: 'Range Min' },
  max: { pid: 2, kind: 'norm', paramName: 'MOD_MAX', role: 'Range Max' },
  start: { pid: 3, kind: 'norm', paramName: 'MOD_STARTPT', role: 'Mapping Start' },
  mid: { pid: 4, kind: 'norm', paramName: 'MOD_MIDPT', role: 'Mapping Mid' },
  end: { pid: 5, kind: 'norm', paramName: 'MOD_ENDPT', role: 'Mapping End' },
  slope: { pid: 6, kind: 'norm', paramName: 'MOD_SLOPE', role: 'Mapping Slope' },
  attack: { pid: 7, kind: 'norm', paramName: 'MOD_ATTACK', role: 'Damping Attack' },
  targetEffectId: { pid: 8, kind: 'ref', paramName: 'MOD_EFFECTID', role: 'Target block effectId (binding)' },
  targetParam: { pid: 9, kind: 'ref', paramName: 'MOD_PARAM', role: 'Target paramId (binding)' },
  autoEngage: { pid: 10, kind: 'ordinal', paramName: 'MOD_AUTOENGAGE', role: 'Auto Engage' },
  pcReset: { pid: 11, kind: 'ordinal', paramName: 'MOD_PCRESET', role: 'PC Reset' },
  offValue: { pid: 12, kind: 'norm', paramName: 'MOD_OFFVAL', role: 'Off Value' },
  scale: { pid: 13, kind: 'norm', paramName: 'MOD_SCALE', role: 'Mapping Scale' },
  offset: { pid: 14, kind: 'bipolar', paramName: 'MOD_OFFSET', role: 'Mapping Offset' },
  release: { pid: 15, kind: 'norm', paramName: 'MOD_RELEASE', role: 'Damping Release' },
  updateRate: { pid: 16, kind: 'ordinal', paramName: 'MOD_RATE', role: 'Update Rate' },
  channel: { pid: 17, kind: 'ordinal', paramName: 'MOD_CHANNEL', role: 'Channel' },
  xMark: { pid: 18, kind: 'norm', paramName: 'MOD_XMARK', role: 'Graph X marker (editor display)' },
  yMark: { pid: 19, kind: 'norm', paramName: 'MOD_YMARK', role: 'Graph Y marker (editor display)' },
  ctrlId2: { pid: 20, kind: 'ordinal', paramName: 'MOD_CTRLID2', role: 'Secondary source' },
  scale1: { pid: 21, kind: 'norm', paramName: 'MOD_SCALE1', role: 'Scale operand 1' },
  scale2: { pid: 22, kind: 'norm', paramName: 'MOD_SCALE2', role: 'Scale operand 2' },
  operation: { pid: 23, kind: 'ordinal', paramName: 'MOD_OPERATION', role: 'Source blend operation' },
  damping: { pid: 24, kind: 'ordinal', paramName: 'MOD_DAMPING', role: 'Damping mode' },
};

/** paramId for a modifier field. */
export function fm9ModParamId(field: Fm9ModField): number {
  return FM9_MOD_FIELDS[field].pid;
}

/**
 * The (pid, value) writes that bind a modifier slot to a target parameter with a source. Send each
 * as a discrete SET (sub `09 00`) on the modifier slot's eid, then write the curve fields to shape it.
 * NOTE: `sourceOrdinal` is device-specific and NOT catalogued for FM9 — pass an ordinal you have
 * confirmed against FM9 hardware.
 */
export function fm9ModBindFrames(
  targetEffectId: number,
  targetParam: number,
  sourceOrdinal: number,
): { pid: number; value: number }[] {
  return [
    { pid: FM9_MOD_FIELDS.targetEffectId.pid, value: targetEffectId },
    { pid: FM9_MOD_FIELDS.targetParam.pid, value: targetParam },
    { pid: FM9_MOD_FIELDS.source.pid, value: sourceOrdinal },
  ];
}
