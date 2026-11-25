// Barrel for fractal-midi/cache.
//
// Pure, browser-safe byte-walker for Fractal editor
// `effectDefinitions_*.cache` files. Emits the section/record grammar as
// structured data; brings no MIDI transport and no fs dependency.

export { parseCacheRecords, WalkError } from './records.js';
export type { ParseCacheOptions } from './records.js';
export {
  readCacheHeader,
  cacheHeaderVersion,
  parseCacheFileName,
  headerMatchesFileName,
  headerMatchesWalk,
  CacheHeaderError,
  CACHE_HEADER_BYTES,
} from './header.js';
export type { CacheHeader, CacheFileName } from './header.js';
export {
  redactCacheUserNames,
  verifyCacheRedaction,
  isCacheRedacted,
  isUserNameTable,
  userNameTableKind,
  CacheRedactionError,
  REDACTION_VERSION,
  REDACTION_FILLER,
} from './redact.js';
export type { UserNameTableKind, CacheRedaction, RedactCacheResult } from './redact.js';
export { buildDeviceCache, buildDeviceCacheDetailed, rangeRowOf, HW_SEEDS } from './assign.js';
export type { BuildDeviceCacheOptions, DeviceCacheDetail, DeviceCacheSection } from './assign.js';
export {
  PROFILE_FORMAT,
  RAW_FORMAT,
  DERIVATION_REVISION,
  needsRederive,
  MIN_DERIVED_WITH,
  compareCodecVersions,
  rawSourceId,
  uniqueSourceIds,
  rawFromCacheBytes,
  rawFromLiveWalk,
  cacheRecordOf,
  sourceSummary,
  assertNoUserTables,
  ProfileUserDataError,
  deriveProfile,
  buildProfileDoc,
  ProfileDerivationError,
  syntheticFamilyKey,
  isSyntheticFamilyKey,
} from './profileDoc.js';
export type {
  RawSourceKind,
  SourceOrigin,
  RawRecord,
  EditorCacheRawSource,
  LiveSourceScope,
  WalkBoundHit,
  LiveRawSource,
  RawSource,
  ProfileRaw,
  SourceSummary,
  RawFromCacheBytesOptions,
  RawFromLiveWalkOptions,
  CatalogSection,
  SectionRole,
  DerivedSection,
  BlockMapConfidence,
  BlockMapEntry,
  ProfileDoc,
  DerivedProfile,
  DeriveOptions,
  DerivedUnit,
  ProfileDerivationErrorCode,
} from './profileDoc.js';
export {
  shareableSource,
  sourceFactHash,
  sourceFactCanonical,
  canonicalJson,
  coarsenCapturedAt,
  FACT_HASH_VERSION,
} from './share.js';
export type {
  ShareableSource,
  ShareableEditorCacheSource,
  ShareableLiveSource,
  ShareRefusal,
  ShareRefused,
  SourceFactKey,
} from './share.js';
export {
  spotCheckTargets,
  spotCheckRows,
  runSpotCheck,
  guardSpotCheckTransport,
  rangeMatchesDefinition,
  spotCheckRng,
  SPOT_CHECK_TARGETS,
  SPOT_CHECK_BUDGET_MS,
  SPOT_CHECK_LIMITS,
} from './spotCheck.js';
export type {
  SpotCheckRowClass,
  SpotCheckRange,
  SpotCheckRow,
  SpotCheckGates,
  SpotCheckTargetsInput,
  SpotCheckTarget,
  SpotCheckPlan,
  SpotCheckAnchor,
  SpotCheckRunOptions,
  SpotCheckVerdict,
  SpotCheckMismatchReason,
  SpotCheckTargetResult,
  SpotCheckResult,
  SpotCheckDoc,
  SpotCheckRowsOptions,
} from './spotCheck.js';
export { sourceRank, planSourceUnits, mergeDerived, computeCoverage, rosterDiff, effectIdOwners, liveWalkCaps } from './merge.js';
export type {
  ProfileProvenance,
  CoverageGapKind,
  CoverageFix,
  CoverageGap,
  ProfileCoverage,
  ProfileCatalog,
  SourceUnitPlan,
  MergeResult,
  CoverageInput,
  RosterDiff,
} from './merge.js';
export {
  matchBlocks,
  matchBulkShape,
  compareBlockRows,
  tuplesMatch,
  deriveBlockMap,
  bridgeLiveUnits,
  blockBindableSection,
  effectIdSpansForModel,
  BLOCK_MAP_MIN_ROWS,
} from './blockMap.js';
export type { MatchBlocksInput, BlockRowsComparison } from './blockMap.js';
export { rowTuple, sectionSignatureRows, rowsSignature, isPlaceholderRecord, SECTION_SIGNATURE_VERSION } from './rowTuple.js';
export type { TupleRecord } from './rowTuple.js';
export { buildCache, CACHE_SCHEMA } from './buildProfile.js';
export type { RecordSource, BuiltCache, BuiltCacheWalkStats } from './buildProfile.js';
export {
  liveWalk,
  liveWalkDetailed,
  liveSource,
  enumHintsFromRanges,
  buildDefQuery,
  buildEnumQuery,
  buildValueQuery,
  decodeReply,
  decodeSeptetStream,
  parseDisplayValue,
  classifyTaper,
  VIEW_DEFINITION,
  VIEW_ENUM_LABEL,
  VIEW_VALUE,
  LIVE_WALK_LIMITS,
  walkQueryBound,
  walkListedIds,
  walkQueryAllowed,
  liveWalkScope,
  decodeWalkQuery,
  guardWalkTransport,
  WalkBoundError,
  LiveWalkAbortError,
} from './liveWalk.js';
export type {
  LiveTransport,
  LiveWalkWriteHooks,
  LiveWalkOptions,
  LiveEnumHint,
  LiveWalkProgress,
  LiveWalkResult,
  LiveWalkBoundHit,
  PseudoReplyStats,
  LiveReply,
  LiveDefinition,
  WalkQuery,
  WalkGuardOptions,
  LiveWalkAbortCode,
} from './liveWalk.js';
export type {
  Section,
  RecordBase,
  EnumRecord,
  FloatRecord,
  FloatTaper,
  CacheRecord,
  CacheWalk,
  CacheWalkIssue,
  DeviceParam,
  RangeDef,
  RangeSectionMeta,
  TypeModel,
  BuiltCacheData,
} from './types.js';
export {
  BYPASS_TYPECODE,
  FINGERPRINT_VERSION,
  isPlaceholderRow,
  isInformativeRow,
  enumOrdinalBounds,
  labelsHash,
  paramFingerprint,
  rowsCompatible,
  familyAssignmentSuspects,
} from './fingerprint.js';
export type { FamilyTables } from './fingerprint.js';
export {
  typecodeTaper,
  typecodeUnit,
  typecodeClass,
  KNOB_0_10_TYPECODE,
  MONITOR_TYPECODE_LOW_BYTE,
  TOGGLE_ROW_TYPECODE_LOW_BYTE,
} from './typecodeRules.js';
export type {
  TypecodeConfidence,
  TypecodeTaperKind,
  TypecodeUnitCode,
  TypecodeClassKind,
  TypecodeTaperRule,
  TypecodeUnitRule,
} from './typecodeRules.js';

// Per-model constants of the gen-3 definition walk and the read-only request builders that use
// them (the walk grammar is model-generic; only these data constants differ).
export {
  GEN3_WALK_PROFILES,
  gen3WalkProfile,
  GEN3_LABEL_TYPECODE_CLASSES,
  gen3TypecodeClass,
  GEN3_BLOCK_DESCRIPTOR_SUB,
  GEN3_PRESET_NAME_SUB,
  gen3BlockSweepOrdinals,
  buildBlockDescriptorQuery,
  buildPresetNameQuery,
  buildCabBankQuery,
} from './gen3WalkModel.js';
export type { Gen3WalkProfile, Gen3EffectIdRow } from './gen3WalkModel.js';

// Reply decoding for the block descriptor (device-supplied parameter counts), the preset-name
// read and the raw cab/IR bank record read.
export {
  decodeBlockDescriptor,
  decodePresetNameReply,
  decodeCabBankRecordReply,
  readBlockParamCounts,
  readPresetNames,
  readCabBankRecords,
} from './gen3WalkReplies.js';
export type {
  Gen3BlockDescriptor,
  Gen3PresetNameReply,
  Gen3CabBankRecordReply,
  Gen3ReadOptions,
  Gen3ReadStats,
  Gen3BlockParamCounts,
  Gen3PresetName,
  Gen3PresetNameRead,
  Gen3CabBankRecordRead,
  Gen3CabBankRead,
} from './gen3WalkReplies.js';

// Special tables (ids >= 0xFF00): record construction and the profile-safe / local-only merge.
export {
  PRESET_NAME_TABLE_ID,
  CAB_BANK_TABLE_ID_MIN,
  CAB_BANK_TABLE_ID_MAX,
  CACHE_PRESET_NAME_SECTION,
  CACHE_CAB_BANK_SECTION,
  isCabBankTableId,
  presetNameTableRecord,
  cabBankTableRecord,
  specialTableRecords,
  mergeSpecialTables,
  mergeSpecialTablesLocal,
  userTableIds,
} from './specialTables.js';
export type { PresetNameTable, CabBankTable, SpecialTables } from './specialTables.js';
