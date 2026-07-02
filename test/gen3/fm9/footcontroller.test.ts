/**
 * FM9 Foot Controller address-model — catalog cross-checks.
 *
 * Every FC region base must resolve by name in FM9_PARAMS with the same paramId (the
 * footController table and the param catalog are independently sourced), and the addressing
 * arithmetic must be internally consistent. Device-specific: CUR_WINDOW base is FM9's 5640,
 * not the III's 5648.
 */
import {
  FM9_FC_EFFECT_ID,
  FM9_FC_LAYOUTS,
  FM9_FC_SWITCH_SLOTS_PER_LAYOUT,
  FM9_FC_CONFIGS,
  FM9_FC_PARAMS_WIDTH,
  FM9_FC_FIELDS,
  FM9_FC_CUR_LAYOUT_BASE,
  FM9_FC_CUR_WINDOW_BASE,
  FM9_FC_CATEGORIES,
  FM9_FC_LABEL_MODES,
  fm9FcConfigIndex,
  fm9FcParamId,
} from '../../../src/gen3/fm9/footController.js';
import { FM9_PARAMS } from '../../../src/gen3/fm9/params.js';

export const FM9_FOOTCONTROLLER_CASE_COUNT = 12;

export function runFm9FootControllerTests(): void {
  const byName = new Map(FM9_PARAMS.map((p) => [p.name, p]));

  // 1. effect id
  if (FM9_FC_EFFECT_ID !== 199) throw new Error(`[fm9/fc] FC effectId must be 199, got ${FM9_FC_EFFECT_ID}`);

  // 2. geometry: 9 layouts * 12 slots = 108 configs (region width)
  if (FM9_FC_CONFIGS !== 108) throw new Error(`[fm9/fc] expected 108 configs, got ${FM9_FC_CONFIGS}`);
  if (FM9_FC_LAYOUTS * FM9_FC_SWITCH_SLOTS_PER_LAYOUT !== FM9_FC_CONFIGS)
    throw new Error('[fm9/fc] layouts*slots must equal CONFIGS');

  // 3. every region base resolves by name in FM9_PARAMS with the same pid
  for (const [field, def] of Object.entries(FM9_FC_FIELDS)) {
    const cat = byName.get(def.paramName);
    if (!cat) throw new Error(`[fm9/fc] ${field}: ${def.paramName} not present in FM9_PARAMS`);
    if (cat.paramId !== def.base) {
      throw new Error(`[fm9/fc] ${field}: base ${def.base} disagrees with FM9_PARAMS ${def.paramName}=${cat.paramId}`);
    }
    if (cat.family !== 'FC') throw new Error(`[fm9/fc] ${field}: ${def.paramName} family '${cat.family}' != 'FC'`);
  }

  // 4. region spacing: TAP FUNCS→SUBFUNCS is exactly one region (108) wide
  if (FM9_FC_FIELDS.tapFunction.base - FM9_FC_FIELDS.tapCategory.base !== FM9_FC_CONFIGS)
    throw new Error('[fm9/fc] tapCategory→tapFunction spacing must equal CONFIGS (108)');

  // 5. PARAMS region is 6 pids per config: PARAMS(324)+108*6 = 972 = HOLD FUNCS base
  if (FM9_FC_FIELDS.tapParams.base + FM9_FC_CONFIGS * FM9_FC_PARAMS_WIDTH !== FM9_FC_FIELDS.holdCategory.base)
    throw new Error('[fm9/fc] TAP PARAMS width×configs must land on HOLD FUNCS base (972)');

  // 6. device-specific CUR_WINDOW base (FM9 = 5640, NOT the III's 5648)
  if (FM9_FC_CUR_WINDOW_BASE !== 5640) throw new Error(`[fm9/fc] CUR_WINDOW base must be FM9-specific 5640, got ${FM9_FC_CUR_WINDOW_BASE}`);
  const curWin = byName.get('FC_PARAM_CUR_WINDOW_FC1');
  if (!curWin || curWin.paramId !== FM9_FC_CUR_WINDOW_BASE)
    throw new Error('[fm9/fc] CUR_WINDOW base must equal FC_PARAM_CUR_WINDOW_FC1 pid in FM9_PARAMS');
  const curLay = byName.get('FC_PARAM_CUR_LAYOUT_FC1');
  if (!curLay || curLay.paramId !== FM9_FC_CUR_LAYOUT_BASE)
    throw new Error('[fm9/fc] CUR_LAYOUT base must equal FC_PARAM_CUR_LAYOUT_FC1 pid in FM9_PARAMS');

  // 7. config index arithmetic
  if (fm9FcConfigIndex(0, 0) !== 0) throw new Error('[fm9/fc] config(0,0) must be 0');
  if (fm9FcConfigIndex(1, 0) !== 12) throw new Error('[fm9/fc] config(1,0) must be 12');
  if (fm9FcConfigIndex(8, 11) !== 107) throw new Error('[fm9/fc] config(8,11) must be 107 (last)');

  // 8. paramId of tapCategory for a given config equals base+config
  if (fm9FcParamId('tapCategory', 2, 3) !== 2 * 12 + 3)
    throw new Error('[fm9/fc] tapCategory paramId arithmetic wrong');
  // PARAMS block index selects within the 6-wide value block
  if (fm9FcParamId('tapParams', 0, 1, 1) !== 324 + 1 * 6 + 1)
    throw new Error('[fm9/fc] tapParams index arithmetic wrong');

  // 9. category / label-mode vocab sanity
  if (FM9_FC_CATEGORIES[0] !== 'Unassigned' || FM9_FC_CATEGORIES[2] !== 'Preset' || FM9_FC_CATEGORIES[11] !== 'Setlist')
    throw new Error('[fm9/fc] category vocab drift');
  if (Object.keys(FM9_FC_CATEGORIES).length !== 14) throw new Error('[fm9/fc] expected 14 categories');
  if (FM9_FC_LABEL_MODES[2] !== 'Custom') throw new Error('[fm9/fc] label-mode vocab drift');
}
