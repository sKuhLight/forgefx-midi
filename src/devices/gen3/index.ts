/**
 * Modern Fractal family descriptor entry point
 * (`forgefx-midi/devices/gen3`). Entry exports: `AXEFX3_DESCRIPTOR`,
 * `FM3_DESCRIPTOR`, `FM9_DESCRIPTOR`, `VP4_DESCRIPTOR` (plus the
 * `MODERN_FRACTAL_DESCRIPTORS` enumeration). VP4 keeps its
 * writes-gated behavior exactly as configured in `configs/vp4.ts`.
 *
 * Also exports the gen-3 preset codec pipeline for server-side consumers:
 * dump framing (`parsePresetDump`, `retargetPresetDumpToEditBuffer`),
 * raw-patch unpack + Huffman + CRC (`decodeRawPatch`), the structured body
 * decode (`decodeGen3Body`, `decodeGen3PresetDump`), and the FM3-verified
 * generic per-block param extraction (`readBlockParams`, blockParams.ts).
 */
export * from './device.js';

export {
  parsePresetDump,
  parsePresetBank,
  serializePresetDump,
  extractPresetName,
  retargetPresetDumpToEditBuffer,
  HEADER_LEN,
  CHUNK_LEN,
  FOOTER_LEN,
  CHUNKS_PER_PRESET,
  PRESET_DUMP_LEN,
} from './presetDump.js';
export type { ParsedPresetDump } from './presetDump.js';

export {
  decodeRawPatch,
  isEmptyRawPatch,
  computeRawPatchCrc,
  computeRawPatchXor,
  crc16ccitt,
  huffmanUncompress,
} from './presetHuffman.js';
export type { DecodedRawPatch } from './presetHuffman.js';

export {
  decodeGen3Body,
  decodeGen3PresetDump,
  effectName,
  modelName,
  getProfile,
  MODEL_AXE_FX_III,
  MODEL_FM3,
  MODEL_FM9,
} from './presetBody.js';
export type {
  Gen3PresetBody,
  Gen3DecodedPreset,
  Gen3GridCell,
  Gen3Block,
  Gen3BlockChannel,
  Gen3Modifier,
  Gen3SceneController,
} from './presetBody.js';

export {
  effectRoster,
  blockRefForEid,
  slugForEffectId,
  blockInstances,
} from './roster.js';

export {
  readBlockParams,
  readBlockParamsForModel,
  gen3BlockParamModel,
  hasBlockParamModel,
  modelsFromBlocks,
  FM3_BLOCK_PARAM_TABLES,
  FM3_BODY_LAYOUT,
} from './blockParams.js';
export type {
  Gen3BlockParamTables,
  Gen3BodyLayout,
  DecodedBlock,
  DecodedBlockParam,
} from './blockParams.js';
export {
  findBlockHeader,
  paramByteOffset,
  writeBlockParam,
  valueToRaw,
  typeParamForFamily,
} from './blockParams.js';
export type { RawWritableParam } from './blockParams.js';

export {
  authorGen3PresetFromIR,
  authorGen3PresetFromIRFull,
  reconcileBlockAnchors,
} from './presetAuthorIr.js';
export type {
  IrAuthorParam,
  IrAuthorBlock,
  IrAuthorPreset,
  AuthoredParamRecord,
  AuthoredBlockRecord,
  AuthoredSkip,
  AuthorIrResult,
  AuthorIrFullResult,
  BlockAnchor,
} from './presetAuthorIr.js';

export {
  buildGen3Body,
  buildCatalogBlock,
  writeSceneNames,
  synthGrid,
  assignGridEffectIds,
  assignFm3GridEffectIds,
  hasSynthModel,
  defaultScaffold,
  defaultScaffoldSyx,
  FM3_BLOCK_GEOMETRY,
  FM9_BLOCK_GEOMETRY,
  AXE3_BLOCK_GEOMETRY,
} from './presetSynth.js';
export type {
  SynthPreset,
  SynthBlock,
  SynthParam,
  SynthGridCell,
  SynthPlacedBlock,
  SynthSkip,
  SynthBodyResult,
  Gen3BlockTemplate,
  CatalogBlockRecord,
} from './presetSynth.js';

export { validateGen3Preset } from './presetValidate.js';
export type { Gen3ValidationResult } from './presetValidate.js';

// ── File / transfer layer (offline formats) ─────────────────────────
// SysEx frame envelope for the transfer groups.
export {
  SYSEX_START,
  SYSEX_END,
  FRACTAL_MANUFACTURER_ID,
  buildFractalFrame,
  readFractalFrame,
  splitFractalFrames,
} from './frame.js';
export type { FractalFrame } from './frame.js';

// System + Global Blocks + Foot Controller dump (0x43 request, 0x51/0x52/0x53).
export {
  SYSTEM_DUMP_FUNCS,
  SYSTEM_DUMP_HEADER_PAYLOAD_LEN,
  SYSTEM_DUMP_CHUNK_PAYLOAD_LEN,
  SYSTEM_DUMP_FOOTER_PAYLOAD_LEN,
  SYSTEM_DUMP_CHUNK_WORDS,
  SYSTEM_DUMP_CANONICAL_WORDS,
  SYSTEM_DUMP_CANONICAL_FRAMES,
  SYSTEM_DUMP_MAX_WORDS,
  buildSystemDumpRequest,
  systemDumpFrameCount,
  parseSystemDump,
  parseSystemDumpFrames,
} from './systemDump.js';
export type { ParsedSystemDump } from './systemDump.js';

// FullRes cab IR (0x67/0x68/0x69) — receive-only, injected XTEA key.
export {
  FULLRES_IR_FUNCS,
  FULLRES_IR_HEADER_PAYLOAD_LEN,
  FULLRES_IR_CHUNK_PAYLOAD_LEN,
  FULLRES_IR_FOOTER_PAYLOAD_LEN,
  FULLRES_IR_CHUNK_WORDS,
  FULLRES_IR_CHUNKS,
  FULLRES_IR_TOTAL_WORDS,
  FULLRES_IR_TOTAL_BYTES,
  FULLRES_IR_FRAMES,
  FULLRES_IR_PAIR_COUNT,
  fullResIrFrameCount,
  parseFullResIr,
  parseFullResIrFrames,
  decryptFullResIr,
} from './fullResIr.js';
export type { ParsedFullResIr } from './fullResIr.js';
export type { XteaRecordKey, XteaDecryptOptions } from '../../shared/xtea.js';

// Generic large-record cab group (0x5A/0x5B/0x5C), write framing only.
export {
  CAB_GROUP_FUNCS,
  CAB_GROUP_HEADER_PAYLOAD_LEN,
  CAB_GROUP_CHUNK_WORDS,
  CAB_GROUP_CHUNK_PAYLOAD_LEN,
  CAB_GROUP_FOOTER_PAYLOAD_LEN,
  CAB_GROUP_USER_CAB_DEST,
  CAB_GROUP_SCRATCHPAD,
  cabGroupSlot,
  cabGroupFrameCount,
  buildCabGroupHeader,
  buildCabGroupChunk,
  buildCabGroupFooter,
  xor32Words,
} from './cabGroup.js';
export type { CabGroupHeader, CabGroupSlot } from './cabGroup.js';

// Preset + cab bundle (.fasBundle): ZIP + XML manifest.
export {
  FAS_BUNDLE_MANIFEST_ENTRY,
  FAS_BUNDLE_VERSION,
  FAS_BUNDLE_CHUNK_PAYLOAD_LEN,
  FAS_BUNDLE_CAB_RECORD_LEN,
  FAS_BUNDLE_PRESET_CHUNKS,
  FAS_BUNDLE_EMPTY_CAB_IDS,
  FAS_BUNDLE_RESTORE_PREAMBLE_FUNC,
  readFasBundle,
  writeFasBundle,
  buildBundleRestorePreamble,
  bundlePresetFooterPayload,
  encodeBundleRestoreFile,
} from './fasBundle.js';
export type {
  FasBundle,
  FasBundleDevice,
  FasBundlePreset,
  FasBundleCab,
  FasBundleLimits,
  BundleRestoreOptions,
} from './fasBundle.js';

// Setlist (.fas-setlist) / songs (.fas-songs) XML + song parameter-table map.
export {
  FAS_SETLIST_ROOT,
  FAS_SONGS_ROOT,
  FAS_SETLIST_VERSION,
  SONG_SECTION_COUNT,
  SONG_SECTION_NAME_SLOTS,
  SONG_NAME_SLOTS,
  SONG_PARAM_TYPES,
  parseFasSetlists,
  parseFasSongs,
  serializeFasSetlists,
  serializeFasSongs,
  songSectionPresetPid,
  songSectionScenePid,
  songSectionNamePid,
  songNamePid,
} from './fasSetlists.js';
export type {
  FasDeviceHeader,
  FasSetlist,
  FasSetlistsFile,
  FasSong,
  FasSongsFile,
  FasSetlistLimits,
} from './fasSetlists.js';
