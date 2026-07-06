export { FM9_PARAMS, FM9_PARAMS_BY_FAMILY, FM9_FAMILIES } from './params.js';
export { FM9_ENUM_OVERRIDES } from './enumOverrides.generated.js';
export { FM9_CAB_IRS } from './cabIrs.generated.js';
export {
  FM9_RANGES,
  FM9_RANGE_SECTIONS,
  FM9_UNMAPPED_SECTIONS,
  type Fm9ParamRange,
  type Fm9RangeFamilyMeta,
} from './ranges.generated.js';
export {
  FM9_EFFECT_ID_TABLE,
  FM9_EFFECT_IDS,
  FM9_FAMILY_BY_EFFECT_ID,
  fm9EffectId,
  type Fm9EffectIdEntry,
  type Fm9EffectAddressing,
} from './effectIds.js';
export {
  FM9_LAYOUTS,
  type Fm9BlockLayout,
  type Fm9LayoutPage,
  type Fm9LayoutControl,
} from './layouts.generated.js';
export {
  FM9_MONITOR_PARAMS,
  fm9MonitorParamsFor,
  fm9MonitorDb,
  type Fm9MeterRole,
  type Fm9MonitorParamDef,
} from './meters.js';
export {
  FM9_FC_EFFECT_ID,
  FM9_FC_LAYOUTS,
  FM9_FC_SWITCH_SLOTS_PER_LAYOUT,
  FM9_FC_CONFIGS_PER_LAYOUT,
  FM9_FC_CONFIGS,
  FM9_FC_PARAMS_WIDTH,
  FM9_FC_FIELDS,
  FM9_FC_CUR_LAYOUT_BASE,
  FM9_FC_CUR_WINDOW_BASE,
  FM9_FC_CATEGORIES,
  FM9_FC_LABEL_MODES,
  fm9FcConfigIndex,
  fm9FcParamId,
  type Fm9FcField,
  type Fm9FcFieldDef,
} from './footController.js';
export {
  FM9_MOD_EFFECT_ID,
  FM9_MOD_SLOT_COUNT,
  FM9_MOD_FIELDS,
  fm9ModSlotEid,
  fm9ModParamId,
  fm9ModBindFrames,
  type Fm9ModField,
  type Fm9ModFieldDef,
} from './modifiers.js';
export { FM9_HELP_OVERRIDES } from './help.js';
export {
  GEN3_HELP,
  GEN3_COMMON_PARAM_HELP,
  blockHelpFor,
} from '../help.js';
export {
  resolveHelp,
  type BlockHelp,
  type ParamHelp,
  type BlockHelpEntry,
  type HelpCatalog,
  type BlockHelpOverride,
  type HelpOverrides,
} from '../helpTypes.js';
