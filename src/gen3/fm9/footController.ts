/**
 * FM9 Foot Controller (effectId 199) parameter address model.
 *
 * The footswitch config space is a flat `(effectId 199, paramId)` array. This module gives its
 * region layout so a consumer can address any switch's tap/hold action and the layout-name /
 * current-window registers by `(layout, switchSlot)` and a field name.
 *
 * Provenance: the FC region bases below are FM9 DEVICE-TRUE, byte-exact from FM9-Edit's OWN binary.
 * The paramId of each `*_BEGIN` marker was mined directly from the `{ int32 id, int32 pad, char* name }`
 * struct array in the macOS Mach-O's `__const` (Ghidra, 2026-07-02) AND independently resolves by
 * name against `FM9_PARAMS` (the FC family). The region layout is byte-identical to the FM3 — the FC
 * subsystem is shared gen-3 firmware — EXCEPT the CUR_WINDOW base, which is FM9-specific (mining the
 * FM9 binary pins 5640; the III's 5648 would mis-address). paramIds are DEVICE-SPECIFIC — never reuse
 * the III's.
 *
 * ── Addressing ───────────────────────────────────────────────────────
 *   pid = field.base + config * field.stride  (+ index, for the multi-wide PARAMS field)
 *   config = layout * SWITCH_SLOTS_PER_LAYOUT + switchSlot
 *     layout      0..8  (9 layouts; index 8 = "Master")
 *     switchSlot  0..11 (12 switch positions per layout — the shared FC abstraction that
 *                        maps onto FC-6 / FC-12 hardware; the FM3 UI paged these as 4 views × 3)
 *   → 12 configs per layout, 108 configs total (region width 108, confirmed from the bases).
 *
 * Wire frame: `F0 00 01 74 12 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   (model byte 0x12 = FM9) sub = `09 00` discrete · `52 00` continuous · eid = 199 · values are float32.
 *
 * NOT shipped (unconfirmed for FM9 — FM3 recovered these from hardware captures, not present in
 * the FM9 catalog): the switch LED-color base, the tap/hold custom-label ASCII bases. The category
 * and label-mode ENUM ORDINALS are the shared gen-3 vocabulary (names confirmed present in the FM9
 * binary; ordinals FM3-verified and assumed shared — treat as inferred until an FM9 capture pins them).
 */

export const FM9_FC_EFFECT_ID = 199;
export const FM9_FC_LAYOUTS = 9; // incl. index 8 = Master
export const FM9_FC_SWITCH_SLOTS_PER_LAYOUT = 12; // shared FC abstraction (FC-12 max)
export const FM9_FC_CONFIGS_PER_LAYOUT = FM9_FC_SWITCH_SLOTS_PER_LAYOUT; // 12
export const FM9_FC_CONFIGS = FM9_FC_LAYOUTS * FM9_FC_CONFIGS_PER_LAYOUT; // 108
export const FM9_FC_PARAMS_WIDTH = 6; // PARAMS region: pids per config (idx0=primary, idx1=secondary)

export type Fm9FcField =
  | 'tapCategory' // TAP FUNCS  — the action category
  | 'tapFunction' // TAP SUBFUNCS — function within the category
  | 'tapDisplay' // TAP DISPFUNCS — mini-display / label mode
  | 'tapParams' // TAP PARAMS — 6-wide value block (preset#/scene#/channel/limits…)
  | 'holdCategory'
  | 'holdFunction'
  | 'holdDisplay'
  | 'holdParams'
  | 'layoutName';

export interface Fm9FcFieldDef {
  /** paramId of this field for config 0 (Layout 1 / switch-slot 0). */
  base: number;
  /** pids this field occupies per config (1 = scalar, 6 = value block). */
  width: number;
  /** per-config paramId step (equals width — fields are config-major and contiguous). */
  stride: number;
  /** name in FM9_PARAMS this base corresponds to (the region *_BEGIN marker). */
  paramName: string;
}

/** FC region bases — device-true (join against FM9_PARAMS by paramName). */
export const FM9_FC_FIELDS: Record<Fm9FcField, Fm9FcFieldDef> = {
  tapCategory: { base: 0, width: 1, stride: 1, paramName: 'FC_PARAM_TAP_FUNCS_BEGIN' },
  tapFunction: { base: 108, width: 1, stride: 1, paramName: 'FC_PARAM_TAP_SUBFUNCS_BEGIN' },
  tapDisplay: { base: 216, width: 1, stride: 1, paramName: 'FC_PARAM_TAP_DISPFUNCS_BEGIN' },
  tapParams: { base: 324, width: FM9_FC_PARAMS_WIDTH, stride: FM9_FC_PARAMS_WIDTH, paramName: 'FC_PARAM_TAP_PARAMS_BEGIN' },
  holdCategory: { base: 972, width: 1, stride: 1, paramName: 'FC_PARAM_HOLD_FUNCS_BEGIN' },
  holdFunction: { base: 1080, width: 1, stride: 1, paramName: 'FC_PARAM_HOLD_SUBFUNCS_BEGIN' },
  holdDisplay: { base: 1188, width: 1, stride: 1, paramName: 'FC_PARAM_HOLD_DISPFUNCS_BEGIN' },
  holdParams: { base: 1296, width: FM9_FC_PARAMS_WIDTH, stride: FM9_FC_PARAMS_WIDTH, paramName: 'FC_PARAM_HOLD_PARAMS_BEGIN' },
  layoutName: { base: 1944, width: 1, stride: 1, paramName: 'FC_LAYOUT_NAME_BEGIN' },
};

/** Current-layout register base (per-FC-unit, FC1..FC4 at base+0..3). Device-true. */
export const FM9_FC_CUR_LAYOUT_BASE = 2237;
/** Current-window register base (per-FC-unit). FM9-SPECIFIC — the III uses 5648. */
export const FM9_FC_CUR_WINDOW_BASE = 5640;

/** config index from (layout, switchSlot), both 0-based. */
export function fm9FcConfigIndex(layout: number, switchSlot: number): number {
  return layout * FM9_FC_CONFIGS_PER_LAYOUT + switchSlot;
}

/** paramId of a field for a switch config; `index` selects within the PARAMS block (default 0). */
export function fm9FcParamId(field: Fm9FcField, layout: number, switchSlot: number, index = 0): number {
  const f = FM9_FC_FIELDS[field];
  return f.base + fm9FcConfigIndex(layout, switchSlot) * f.stride + index;
}

/**
 * Switch-category ordinals (the tap/hold FUNCS enum value) — the shared gen-3 FC vocabulary. All
 * names below are present verbatim in the FM9 binary; the ordinals are the FM3-verified dropdown
 * order (0..13), assumed shared across gen-3. Treat ordinals as inferred until an FM9 capture pins them.
 */
export const FM9_FC_CATEGORIES: Readonly<Record<number, string>> = {
  0: 'Unassigned',
  1: 'Bank',
  2: 'Preset',
  3: 'Scene',
  4: 'Effect',
  5: 'Utility',
  6: 'Layout',
  7: 'Control Switch',
  8: 'Looper',
  9: 'Per-Preset',
  10: 'View',
  11: 'Setlist',
  12: 'Song',
  13: 'Song Section',
};

/** Mini-display label modes (the DISPLAY field). Shared gen-3; ordinals FM3-verified, assumed shared. */
export const FM9_FC_LABEL_MODES: Readonly<Record<number, string>> = {
  0: 'Name',
  1: 'Number',
  2: 'Custom',
};
