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
  MIN_DERIVED_WITH,
  compareCodecVersions,
  rawSourceId,
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
export { sourceRank, planSourceUnits, mergeDerived, computeCoverage, rosterDiff } from './merge.js';
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
} from './liveWalk.js';
export type {
  LiveTransport,
  LiveWalkWriteHooks,
  LiveWalkOptions,
  LiveEnumHint,
  LiveWalkProgress,
  LiveWalkResult,
  PseudoReplyStats,
  LiveReply,
  LiveDefinition,
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
