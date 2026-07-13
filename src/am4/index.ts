// Barrel for fractal-midi/am4.
//
// Public surface for AM4 data and codec. Sibling subpaths (`./shared`,
// future `./axe-fx-ii`, `./axe-fx-iii`) follow the same shape: param
// dictionary + block-type table + wire builders + parsers.
//
// Pure code — no MIDI transport dependency. Bring your own.

// Data — parameter dictionary, block-type table, location parsing.
export {
  KNOWN_PARAMS,
  PARAM_ALIASES,
  SCENE_MIDI_TYPE_ENUM,
  encode,
  decode,
  internalFromDisplay,
  formatDisplay,
  roundDisplayValue,
  formatUnitSuffix,
  resolveEnumValue,
  findEnumCandidates,
} from './params.js';
export type { Param, ParamKey, Unit } from './params.js';
export {
  PARAM_NAMES,
} from './paramNames.js';
export type { ParamNameEntry } from './paramNames.js';
export {
  GENERATED_PARAM_NAMES,
  GENERATED_PARAM_NAMES_FIRMWARE,
} from './paramNamesGenerated.js';
export {
  BLOCK_TYPE_VALUES,
  BLOCK_NAMES_BY_VALUE,
  resolveBlockType,
  resolveBlockTypeValue,
} from './blockTypes.js';
export type { BlockTypeName } from './blockTypes.js';
export {
  buildBlockLayoutSnapshot,
  isBlockPlaced,
} from './blockLayout.js';
export type { BlockLayoutSnapshot } from './blockLayout.js';
export {
  parseLocationCode,
  formatLocationCode,
  formatLocationDisplay,
  TOTAL_LOCATIONS,
} from './locations.js';

// Codec — wire-byte builders + parsers.
export {
  AM4_MODEL_ID,
  buildSetFloatParam,
  buildSetParam,
  buildSetRawIntRegister,
  buildSetParamNorm,
  buildNudgeParam,
  buildToggleBlockBypass,
  buildSetBlockType,
  buildSetBlockBypass,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchScene,
  buildSwitchPreset,
  buildSaveToLocation,
  buildGetPresetName,
  buildGetAllParams,
  buildReadParam,
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  isCommandAck,
  isWriteEcho,
  isReadResponse,
  isReadResponseLong,
  isPollResponse,
  parseReadResponse,
  parseLongReadBypassFlag,
  parseGetPresetNameResponse,
  BLOCK_SLOT_PID_LOW,
  BLOCK_SLOT_PID_HIGH_BASE,
  READ_TYPE_LONG,
  READ_TYPE_LIVE_POLL,
  READ_TYPE_STATUS_POLL,
  POLL_READ_ACTIONS,
  LONG_READ_BYPASS_FLAG_BYTE,
  buildReadActiveChannel,
  parseActiveChannelResponse,
  AM4_CHANNEL_STATUS_PID_HIGH,
  AM4_CHANNEL_STATUS_INDEX_BYTE,
  READ_VALUE_DENOMINATOR,
  PRESET_NAME_EMPTY_SENTINEL,
} from './setParam.js';
export type { ParamId, ReadResponse, GetPresetNameResponse } from './setParam.js';

// Preset binary — field decoders for the 12,352-byte stored-form
// (active export + factory bank slices).
export {
  AM4_PRESET_FRAME_SIZE,
  AM4_PRESET_NAME_OFFSET,
  AM4_PRESET_NAME_WIRE_LENGTH,
  AM4_PRESET_NAME_CHAR_COUNT,
  decodeAm4PresetName,
  encodeAm4PresetName,
  decodeAm4PresetNameFromFrame,
} from './presetBinary.js';

// Preset-dump frame codec — parse/validate/serialize the 6-message
// 0x77/0x78/0x79 stream (active export + factory-bank slicing).
export {
  AM4_FUNC_PRESET_HEADER,
  AM4_FUNC_PRESET_CHUNK,
  AM4_FUNC_PRESET_FOOTER,
  AM4_PRESET_DUMP_HEADER_LEN,
  AM4_PRESET_DUMP_CHUNK_LEN,
  AM4_PRESET_DUMP_FOOTER_LEN,
  AM4_PRESET_DUMP_CHUNKS,
  AM4_PRESET_DUMP_HEADER_PAYLOAD_LEN,
  AM4_PRESET_DUMP_CHUNK_PAYLOAD_LEN,
  AM4_PRESET_DUMP_FOOTER_PAYLOAD_LEN,
  AM4_FACTORY_BANK_PRESET_COUNT,
  AM4_DUMP_ACTIVE_BANK_SENTINEL,
  parseAm4PresetDump,
  parseAm4PresetBank,
  serializeAm4PresetDump,
  am4DumpLocation,
} from './presetDump.js';
export type { Am4PresetDump, Am4DumpLocation } from './presetDump.js';

// Modifier model — field roster + enums (data only; wire binding gated, see file header).
export {
  AM4_MOD_EFFECT_ORDINAL,
  AM4_MOD_SLOT_COUNT,
  AM4_MODIFIER_SOURCES,
  AM4_MOD_OPERATIONS,
  AM4_MOD_CHANNELS,
  AM4_MOD_AUTOENGAGE_MODES,
  AM4_MOD_DAMPING_CURVES,
  AM4_MOD_FIELDS,
  AM4_MOD_RESOLVER,
  am4ModCacheId,
} from './modifiers.js';
export type { Am4ModField, Am4ModFieldDef } from './modifiers.js';

// Firmware .syx envelope — parse/validate/serialize only (NOT a flasher; see file header).
export {
  AM4_FUNC_FIRMWARE_HEADER,
  AM4_FUNC_FIRMWARE_BLOCK,
  AM4_FUNC_FIRMWARE_FINALIZE,
  AM4_FIRMWARE_BLOCK_LEN,
  parseAm4Firmware,
  serializeAm4Firmware,
} from './firmware.js';
export type { Am4Firmware } from './firmware.js';

// Data tables — cache + type-applicability + enums.
export { CACHE_PARAMS } from './cacheParams.js';
export type { CacheParamKey } from './cacheParams.js';
// Cache-build inputs — seeds + param catalog for the `src/cache` engine.
export { AM4_SEEDS, AM4_CACHE_PARAMS } from './cacheBuild.js';
export {
  AMP_TYPES,
  DRIVE_TYPES,
  REVERB_TYPES,
  DELAY_TYPES,
  CHORUS_TYPES,
  FLANGER_TYPES,
  PHASER_TYPES,
  WAH_TYPES,
  COMPRESSOR_TYPES,
  GEQ_TYPES,
  FILTER_TYPES,
  TREMOLO_TYPES,
  ENHANCER_TYPES,
  GATE_TYPES,
  VOLPAN_MODES,
  TEMPO_DIVISIONS,
  LFO_WAVEFORMS,
  AMP_TYPES_VALUES,
  DRIVE_TYPES_VALUES,
  REVERB_TYPES_VALUES,
  DELAY_TYPES_VALUES,
  CHORUS_TYPES_VALUES,
  FLANGER_TYPES_VALUES,
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  COMPRESSOR_TYPES_VALUES,
  GEQ_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
  VOLPAN_MODES_VALUES,
  TEMPO_DIVISIONS_VALUES,
  LFO_WAVEFORMS_VALUES,
} from './cacheEnums.js';
export {
  TYPE_APPLICABILITY,
  TYPE_APPLICABILITY_FIRMWARE,
} from './typeApplicability.js';
export type { Applicability, ApplicabilityGate } from './typeApplicability.js';
export {
  getApplicability,
  describeApplicability,
  checkApplicability,
  findCompatibleTypes,
} from './applicability.js';
export type { ActiveTypeContext, ApplicabilityCheck } from './applicability.js';

// Editor / bridge labels (RE'd from AM4-Edit binary).
export {
  EDITOR_CONTROLS,
  EDITOR_CONTROL_FIRMWARE,
  EDITOR_CONTROL_PARAMETER_NAMES,
  resolveEditorControlLabel,
} from './editorControlLabels.js';
export type {
  EditorControlContext,
  EditorControlEntry,
} from './editorControlLabels.js';
export { SYMBOLIC_IDS_BY_BLOCK } from './symbolicIds.js';
export {
  PARAMETER_BRIDGE,
  PARAMETER_BRIDGE_FIRMWARE,
  resolveBridge,
  preferredDisplayLabel,
} from './parameterBridge.js';
export type { ParameterBridgeEntry } from './parameterBridge.js';
export {
  AM4_LIVE_POLL_CANDIDATES,
  am4LivePollCandidateFor,
} from './livePolls.js';
export type {
  Am4LivePollCandidate,
  Am4LivePollConfidence,
} from './livePolls.js';

// Live-poll value decode — turn a 0x0010/0x0026 poll response into a display
// value (known catalog params) or a candidate label (correlated addresses).
export {
  decodeAm4LiveValue,
  decodeAm4PollResponse,
  am4ParamKeyForPid,
} from './liveDecode.js';
export type { Am4LiveDecodeResult } from './liveDecode.js';

// Raw-integer MIDI-config register class — the global MIDI map + per-scene MIDI
// transmit slots read back a literal integer (NOT a Q16 float), with 128 = the
// "None"/unassigned sentinel on _cc CC-assignment registers (BUG-6/GAP-2).
export {
  RAW_INT_NONE_SENTINEL,
  isRawIntRegister,
  rawIntRegisterHasNone,
  decodeRawIntRegister,
  encodeRawIntRegister,
} from './midiRegisters.js';

// Tuner readout (block 0x0023) — DECODED from BigCapture (B2). Absolute float32
// note/freq/cents/string values, not the normalized meter treatment.
export {
  AM4_TUNER_PID_LOW,
  AM4_TUNER_CHANNEL,
  AM4_TUNER_MIDI_OFFSET,
  isAm4TunerChannel,
  am4TunerNoteName,
  decodeAm4Tuner,
} from './tuner.js';
export type { Am4TunerReading } from './tuner.js';

// Variant resolver — block.parameterName → cache-id mappings.
export {
  VARIANT_RESOLVER_FIRMWARE,
  VARIANT_RESOLVER_BY_EFFECT_TYPE,
  VARIANT_RESOLVER_FALLBACK,
  PARAMETER_NAME_TO_CACHE_ID,
  UNIVERSAL_BLOCK_PARAMETERS,
  resolveCacheId,
  resolveAllCacheIds,
} from './variantResolverTables.js';
export type { ResolverEntry } from './variantResolverTables.js';

// Intermediate representation — preset model + transpiler.
export { transpile } from './ir/transpile.js';
export type { WorkingBufferIR } from './ir/preset.js';

// Shared helpers (paramHelpers — the channel-aware resolver lives in
// the consumer because it needs a MIDI connection).
export {
  DEFAULT_SCRATCH_LOCATION,
  EnumAmbiguityError,
  suggestParamName,
  paramKey,
  resolveValue,
} from './shared/paramHelpers.js';

// Editor block-editor UI layouts (v2 schema): pages/tabs → rows → controls,
// keyed by catalog family; paramId joins the editor parameterName to the AM4
// cache-id resolver. See src/editorLayouts.ts.
export { AM4_LAYOUTS } from './editorLayouts.generated.js';
export {
  normalizeWidget,
  EDITOR_WIDGET_KINDS,
  type DeviceEditorLayouts,
  type EditorBlockLayout,
  type EditorLayoutVariant,
  type EditorLayoutPage,
  type EditorLayoutRow,
  type EditorLayoutControl,
  type EditorControlPlacement,
  type EditorCrossBlockRef,
  type EditorWidgetKind,
  type EditorFwRange,
} from '../editorLayouts.js';
