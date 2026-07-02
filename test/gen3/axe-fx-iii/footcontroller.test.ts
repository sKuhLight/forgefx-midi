/**
 * Axe-Fx III Foot Controller address model — catalog cross-checks.
 *
 * Every region base + current-state pid must resolve in the III catalog (PARAMS) with the same
 * paramId, so drift in either table fails here. Also verifies the flat pid arithmetic.
 */
import {
  AXE3_FC_EFFECT_ID,
  AXE3_FC_CONFIGS,
  AXE3_FC_PARAMS_WIDTH,
  AXE3_FC_FIELDS,
  axe3FcParamId,
  AXE3_FC_STATE,
  AXE3_FC_EDIT_LAYOUT_SENTINELS,
} from '../../../src/gen3/axe-fx-iii/footController.js';
import { PARAMS } from '../../../src/gen3/axe-fx-iii/params.js';

export const AXE3_FC_CASE_COUNT = 13;

export function runAxe3FootControllerTests(): void {
  // 1. effectId is the enum-confirmed ID_FOOTCONTROLLER index.
  if (AXE3_FC_EFFECT_ID !== 199) throw new Error(`[axe3/fc] effectId must be 199, got ${AXE3_FC_EFFECT_ID}`);

  const byPid = new Map<number, string>();
  for (const p of PARAMS) if (p.family === 'FC' && !byPid.has(p.paramId)) byPid.set(p.paramId, p.name);

  // 2. Region bases must each be a named FC marker in the catalog.
  const expectBase: [keyof typeof AXE3_FC_FIELDS, number, string][] = [
    ['tapFuncs', 0, 'FC_PARAM_TAP_FUNCS_BEGIN'],
    ['tapSubfuncs', 108, 'FC_PARAM_TAP_SUBFUNCS_BEGIN'],
    ['tapDispfuncs', 216, 'FC_PARAM_TAP_DISPFUNCS_BEGIN'],
    ['tapParams', 324, 'FC_PARAM_TAP_PARAMS_BEGIN'],
    ['holdFuncs', 972, 'FC_PARAM_HOLD_FUNCS_BEGIN'],
    ['holdSubfuncs', 1080, 'FC_PARAM_HOLD_SUBFUNCS_BEGIN'],
    ['holdDispfuncs', 1188, 'FC_PARAM_HOLD_DISPFUNCS_BEGIN'],
    ['holdParams', 1296, 'FC_PARAM_HOLD_PARAMS_BEGIN'],
    ['layoutName', 1944, 'FC_LAYOUT_NAME_BEGIN'],
  ];
  for (const [field, base, name] of expectBase) {
    if (AXE3_FC_FIELDS[field].base !== base) {
      throw new Error(`[axe3/fc] ${field} base ${AXE3_FC_FIELDS[field].base} != ${base}`);
    }
    if (byPid.get(base) !== name) {
      throw new Error(`[axe3/fc] pid ${base} in catalog is ${byPid.get(base)}, expected ${name}`);
    }
  }

  // 3. Region arithmetic: PARAMS block width closes the TAP region exactly (324 + 108×6 = 972).
  if (AXE3_FC_FIELDS.tapParams.base + AXE3_FC_CONFIGS * AXE3_FC_PARAMS_WIDTH !== AXE3_FC_FIELDS.holdFuncs.base) {
    throw new Error('[axe3/fc] TAP PARAMS region does not close onto HOLD FUNCS base');
  }
  // FUNCS/SUBFUNCS/DISPFUNCS are 108 apart.
  if (AXE3_FC_FIELDS.tapSubfuncs.base - AXE3_FC_FIELDS.tapFuncs.base !== AXE3_FC_CONFIGS) {
    throw new Error('[axe3/fc] TAP FUNCS/SUBFUNCS not one config-region apart');
  }

  // 4. Flat pid helper.
  if (axe3FcParamId('tapFuncs', 3) !== 3) throw new Error('[axe3/fc] axe3FcParamId(tapFuncs,3) != 3');
  if (axe3FcParamId('tapParams', 1, 1) !== 324 + 6 + 1) throw new Error('[axe3/fc] tapParams(1,1) wrong');

  // 5. Per-FC current-state pids match the III-specific catalog values (CUR_WINDOW 5648, not FM3 5640).
  const stateExpect: [number, string][] = [
    [AXE3_FC_STATE.curLayout(1), 'FC_PARAM_CUR_LAYOUT_FC1'],
    [AXE3_FC_STATE.curLayout(4), 'FC_PARAM_CUR_LAYOUT_FC4'],
    [AXE3_FC_STATE.version(1), 'FC_VERSION_FC1'],
    [AXE3_FC_STATE.curWindow(1), 'FC_PARAM_CUR_WINDOW_FC1'],
    [AXE3_FC_STATE.curWindow(4), 'FC_PARAM_CUR_WINDOW_FC4'],
  ];
  for (const [pid, name] of stateExpect) {
    if (byPid.get(pid) !== name) {
      throw new Error(`[axe3/fc] state pid ${pid} in catalog is ${byPid.get(pid)}, expected ${name}`);
    }
  }
  if (AXE3_FC_STATE.curWindow(1) !== 5648) throw new Error('[axe3/fc] CUR_WINDOW_FC1 must be III-specific 5648');

  // 6. Edit-layout sentinels are all firmware-internal (> 16383, not wire-addressable).
  if (AXE3_FC_EDIT_LAYOUT_SENTINELS.length !== 8) throw new Error('[axe3/fc] expected 8 edit-layout sentinels');
  if (AXE3_FC_EDIT_LAYOUT_SENTINELS.some((p) => p <= 16383)) {
    throw new Error('[axe3/fc] edit-layout sentinels must all be > 16383');
  }
}
