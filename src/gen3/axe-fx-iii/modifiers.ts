/**
 * Axe-Fx III Modifier parameter map.
 *
 * A modifier attaches a modulation source to a target parameter and shapes it (range + transfer
 * curve + damping). The III has 32 modifier slots; slot N is its own virtual effect addressed as
 * effectId `AXE3_MOD_EFFECT_ID + (N-1)`. Settings are written as standard gen-3 SET frames
 *   `F0 00 01 74 10 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   (model byte 0x10 = Axe-Fx III). sub `09 00` discrete · `52 00` continuous. Values are float32
 *   (ordinals and effectId/paramId references are sent as the integer's float).
 *
 * ── Provenance ───────────────────────────────────────────────────────
 * effectId + slot count + field map recovered from the Axe-Edit III binary (Ghidra-mined param
 * catalog, cross-validated against the macOS Mach-O v1.14.34 strings, 2026-07-02). `ID_MODIFIER1`
 * sits at enum index 3 in the III's own effect-ID enum (`ID_NULL=0, ID_GLOBAL=1, ID_CONTROL=2,
 * ID_MODIFIER1=3, … ID_MODIFIER32=34`), so eid 3 and the 32-slot span are device-CONFIRMED, not
 * assumed. The field pids (0..24) are byte-identical to the FM3's — the modifier subsystem is
 * shared gen-3 firmware. No III modifier write has been hardware-verified yet.
 *
 * ── Target binding (per-control assignment) ─────────────────────────
 * The modifier→target link lives ON the modifier itself, as two of its own params:
 *   pid 8 = `targetEffectId` (MOD_EFFECTID) — the block being modulated
 *   pid 9 = `targetParam`    (MOD_PARAM)    — the paramId within that block
 * To bind a modifier slot to `(blockEid, paramId)` with a given source, SET on the slot's eid:
 *   (eid, 8) = blockEid · (eid, 9) = paramId · (eid, 0) = sourceOrdinal · then shape with the curve pids.
 * See `axe3ModBindFrames`.
 */

/** ID_MODIFIER1 = effectId 3 (enum-confirmed). Slot N (1-based) = AXE3_MOD_EFFECT_ID + (N-1). */
export const AXE3_MOD_EFFECT_ID = 3;
export const AXE3_MOD_SLOT_COUNT = 32;
export const axe3ModSlotEid = (slot1Based: number): number => AXE3_MOD_EFFECT_ID + (slot1Based - 1);

export type Axe3ModField =
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

export interface Axe3ModFieldDef {
  pid: number;
  /** the recovered symbol name in the III param catalog. */
  symbol: string;
  /** 'ordinal' = enum/index · 'norm' = 0..1 · 'bipolar' = signed (±) · 'ref' = effectId/paramId reference. */
  kind: 'ordinal' | 'norm' | 'bipolar' | 'ref';
  /** short UI role label. */
  role: string;
}

/**
 * Modifier field map. pids + symbols are recovered from the III catalog; `kind`/`role` follow the
 * shared gen-3 modifier semantics (same field order as the FM3, whose pids these match exactly).
 */
export const AXE3_MOD_FIELDS: Record<Axe3ModField, Axe3ModFieldDef> = {
  source: { pid: 0, symbol: 'MOD_CTRLID', kind: 'ordinal', role: 'Source' },
  min: { pid: 1, symbol: 'MOD_MIN', kind: 'norm', role: 'Range Min' },
  max: { pid: 2, symbol: 'MOD_MAX', kind: 'norm', role: 'Range Max' },
  start: { pid: 3, symbol: 'MOD_STARTPT', kind: 'norm', role: 'Mapping Start' },
  mid: { pid: 4, symbol: 'MOD_MIDPT', kind: 'norm', role: 'Mapping Mid' },
  end: { pid: 5, symbol: 'MOD_ENDPT', kind: 'norm', role: 'Mapping End' },
  slope: { pid: 6, symbol: 'MOD_SLOPE', kind: 'norm', role: 'Mapping Slope' },
  attack: { pid: 7, symbol: 'MOD_ATTACK', kind: 'norm', role: 'Damping Attack' },
  targetEffectId: { pid: 8, symbol: 'MOD_EFFECTID', kind: 'ref', role: 'Target block effectId (binding)' },
  targetParam: { pid: 9, symbol: 'MOD_PARAM', kind: 'ref', role: 'Target paramId (binding)' },
  autoEngage: { pid: 10, symbol: 'MOD_AUTOENGAGE', kind: 'ordinal', role: 'Auto Engage' },
  pcReset: { pid: 11, symbol: 'MOD_PCRESET', kind: 'ordinal', role: 'PC Reset' },
  offValue: { pid: 12, symbol: 'MOD_OFFVAL', kind: 'norm', role: 'Off Value' },
  scale: { pid: 13, symbol: 'MOD_SCALE', kind: 'norm', role: 'Mapping Scale' },
  offset: { pid: 14, symbol: 'MOD_OFFSET', kind: 'bipolar', role: 'Mapping Offset' },
  release: { pid: 15, symbol: 'MOD_RELEASE', kind: 'norm', role: 'Damping Release' },
  updateRate: { pid: 16, symbol: 'MOD_RATE', kind: 'ordinal', role: 'Update Rate' },
  channel: { pid: 17, symbol: 'MOD_CHANNEL', kind: 'ordinal', role: 'Channel' },
  xMark: { pid: 18, symbol: 'MOD_XMARK', kind: 'norm', role: 'Graph X marker (editor display)' },
  yMark: { pid: 19, symbol: 'MOD_YMARK', kind: 'norm', role: 'Graph Y marker (editor display)' },
  ctrlId2: { pid: 20, symbol: 'MOD_CTRLID2', kind: 'ordinal', role: 'Secondary source' },
  scale1: { pid: 21, symbol: 'MOD_SCALE1', kind: 'norm', role: 'Scale operand 1' },
  scale2: { pid: 22, symbol: 'MOD_SCALE2', kind: 'norm', role: 'Scale operand 2' },
  operation: { pid: 23, symbol: 'MOD_OPERATION', kind: 'ordinal', role: 'Source blend operation' },
  damping: { pid: 24, symbol: 'MOD_DAMPING', kind: 'ordinal', role: 'Damping mode' },
};

/** paramId for a modifier field. */
export function axe3ModParamId(field: Axe3ModField): number {
  return AXE3_MOD_FIELDS[field].pid;
}

/**
 * The (pid, value) writes that bind a modifier slot to a target parameter with a source. Send each
 * as a discrete SET (sub `09 00`) on the modifier slot's eid, then write the curve fields to shape it.
 */
export function axe3ModBindFrames(
  targetEffectId: number,
  targetParam: number,
  sourceOrdinal: number,
): { pid: number; value: number }[] {
  return [
    { pid: AXE3_MOD_FIELDS.targetEffectId.pid, value: targetEffectId },
    { pid: AXE3_MOD_FIELDS.targetParam.pid, value: targetParam },
    { pid: AXE3_MOD_FIELDS.source.pid, value: sourceOrdinal },
  ];
}

/**
 * Modulation-source vocabulary (MOD_CTRLID / pid 0): NOT statically recovered for the III.
 *
 * The source dropdown is built at runtime and does not appear as an ordered ASCII table in either
 * the III Mach-O or the FracPad III resources (a clean static negative). The III's list is expected
 * to DIFFER from the FM3's — the III addresses up to 4 FC units (FC1..FC4 pedals/ext-switches),
 * whereas the FM3 list has FC 1/FC 2 only. Recover the ordinals via a live capture (write an
 * ordinal, read back the selected source name), as was done for the FM3. Do NOT reuse the FM3
 * source ordinals for the III.
 */
export const AXE3_MOD_SOURCES_STATUS = 'not-recovered-statically' as const;
