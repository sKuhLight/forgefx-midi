/**
 * Axe-Fx III Foot Controller (effectId 199) parameter address model.
 *
 * The III drives external FC-6 / FC-12 controllers (up to 4 units). The footswitch config space is
 * a flat `(effectId 199, paramId)` array, addressed with the standard gen-3 SET/GET frame:
 *   `F0 00 01 74 10 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   (model byte 0x10 = Axe-Fx III). eid = 199. Values are float32.
 *
 * ── Provenance ───────────────────────────────────────────────────────
 * Region bases + effectId recovered from the Axe-Edit III binary (Ghidra-mined param catalog,
 * cross-validated against the macOS Mach-O v1.14.34 strings, 2026-07-02). `ID_FOOTCONTROLLER`
 * sits at enum index 199 in the III's own effect-ID enum (`ID_NULL=0, ID_GLOBAL=1, ID_CONTROL=2,
 * ID_MODIFIER1=3, … ID_FOOTCONTROLLER=199`), so eid 199 is device-CONFIRMED, not assumed.
 *
 * ── Field regions (CONFIRMED bases, from the III param table) ─────────
 *   TAP  FUNCS 0 · SUBFUNCS 108 · DISPFUNCS 216 · PARAMS 324
 *   HOLD FUNCS 972 · SUBFUNCS 1080 · DISPFUNCS 1188 · PARAMS 1296
 *   LAYOUT_NAME 1944
 * FUNCS/SUBFUNCS/DISPFUNCS are 1 pid per config, 108 configs wide each. PARAMS is 6 pids per config
 * (324→972 = 648 = 108×6; index 0 = primary value, 1 = secondary). These match the FM3 region
 * layout byte-for-byte — the FC subsystem is shared gen-3 firmware.
 *
 * ── III-specific current-state pids (CONFIRMED, differ from FM3) ──────
 * The III exposes per-FC-unit state (FC1..FC4); note CUR_WINDOW base is 5648 on the III vs 5640 on
 * the FM3 (the FM3 catalog explicitly flags 5648 as "would mis-address" — do NOT reuse across
 * devices):
 *   CUR_LAYOUT  FC1..FC4 = 2237..2240
 *   VERSION     FC1..FC4 = 5594..5597
 *   CUR_WINDOW  FC1..FC4 = 5648..5651   (III-specific)
 *   EDIT_LAYOUT 1..8      = 65520..65527 (firmware sentinels; > 16383, NOT wire-addressable)
 *
 * ── NOT confirmed for the III (do not ship as fact) ──────────────────
 *   • The (layout, view, switch) → config decomposition. The flat config index (0..107) and its
 *     pid arithmetic are confirmed; how a human-facing (layout,view,switch) triple maps onto a
 *     config is NOT recovered for the III. The FM3 uses 9 layouts × 4 views × 3 switches = 108,
 *     but the III has 8 edit-layout slots and up to 4 FC units, so that decomposition is
 *     FM3-specific and is deliberately omitted here.
 *   • Per-switch custom-label and LED-color region bases (FM3's were capture-located, not in the
 *     static catalog) — not recovered for the III.
 *   • The category / function / color / label-mode enum vocabularies (runtime-built dropdowns).
 */

/** ID_FOOTCONTROLLER — enum index 199 in the III effect-ID enum (device-confirmed). */
export const AXE3_FC_EFFECT_ID = 199;

/** Configs in each FUNCS/SUBFUNCS/DISPFUNCS region (region width). PARAMS spans 108×6. */
export const AXE3_FC_CONFIGS = 108;

/** PARAMS region: pids per config (index 0 = primary value, 1 = secondary). */
export const AXE3_FC_PARAMS_WIDTH = 6;

/** Number of external FC units the III addresses (FC1..FC4). */
export const AXE3_FC_UNITS = 4;

export type Axe3FcField =
  | 'tapFuncs' // TAP FUNCS — the action category
  | 'tapSubfuncs' // TAP SUBFUNCS — function within the category
  | 'tapDispfuncs' // TAP DISPFUNCS — mini-display / label mode
  | 'tapParams' // TAP PARAMS — 6-wide value block per config
  | 'holdFuncs'
  | 'holdSubfuncs'
  | 'holdDispfuncs'
  | 'holdParams'
  | 'layoutName';

export interface Axe3FcFieldDef {
  /** paramId of this field for config 0. */
  base: number;
  /** pids this field occupies per config (1 = scalar, 6 = value block). */
  width: number;
}

/** Field-region bases, recovered from the III param catalog (cross-validated on the Mac binary). */
export const AXE3_FC_FIELDS: Record<Axe3FcField, Axe3FcFieldDef> = {
  tapFuncs: { base: 0, width: 1 },
  tapSubfuncs: { base: 108, width: 1 },
  tapDispfuncs: { base: 216, width: 1 },
  tapParams: { base: 324, width: AXE3_FC_PARAMS_WIDTH },
  holdFuncs: { base: 972, width: 1 },
  holdSubfuncs: { base: 1080, width: 1 },
  holdDispfuncs: { base: 1188, width: 1 },
  holdParams: { base: 1296, width: AXE3_FC_PARAMS_WIDTH },
  layoutName: { base: 1944, width: 1 },
};

/**
 * paramId of a field for a flat config index (0..107). `index` selects within a value block
 * (default 0, valid 0..width-1). This flat addressing is the CONFIRMED part of the FC model.
 */
export function axe3FcParamId(field: Axe3FcField, config: number, index = 0): number {
  const f = AXE3_FC_FIELDS[field];
  return f.base + config * f.width + index;
}

/** Per-FC-unit current-state pids (unit = 1..4), device-confirmed III values. */
export const AXE3_FC_STATE = {
  /** Currently-shown layout on FCn. */
  curLayout: (unit: number): number => 2236 + unit, // FC1=2237 … FC4=2240
  /** FC hardware/firmware version register for FCn. */
  version: (unit: number): number => 5593 + unit, // FC1=5594 … FC4=5597
  /** Currently-shown window/view on FCn (III base 5648; FM3 uses 5640 — do not reuse). */
  curWindow: (unit: number): number => 5647 + unit, // FC1=5648 … FC4=5651
} as const;

/**
 * Edit-layout sentinels (FC_PARAM_EDIT_LAYOUT1..8 = 65520..65527). These are firmware-internal
 * markers > 16383 and are NOT addressable via the 14-bit-septet paramId field on the wire; retained
 * only to document that the III exposes 8 editable layout slots.
 */
export const AXE3_FC_EDIT_LAYOUT_SENTINELS: readonly number[] = [
  65520, 65521, 65522, 65523, 65524, 65525, 65526, 65527,
];
