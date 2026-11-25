// Barrel for fractal-midi/shared.
//
// Vendor-shared protocol primitives that every Fractal device family
// member builds on: SysEx checksum, septet pack/unpack (chunked 8-to-7
// plus 14-bit / 16-bit LSB-first), display↔wire scaling, packed-float
// codec, and the shared `ParamId` / `FractalDevice` type shapes.
//
// Pure code — no MIDI transport dependency. Bring your own.

export { fractalChecksum, fixFrameChecksums } from './checksum.js';
export {
  MODEL_BROADCAST,
  FN_IDENTIFY,
  DEVICE_MODELS,
  buildIdentifyBroadcast,
  isFractalHeaderFrame,
  sysexFunctionByte,
  parseIdentifyResponse,
  modelFromPortName,
} from './identify.js';
export type { DeviceModel } from './identify.js';
export {
  FN_FIRMWARE_VERSION,
  buildFirmwareVersionQuery,
  parseFirmwareVersionReply,
  formatFirmwareVersion,
} from './firmware.js';
export type { FirmwareVersion } from './firmware.js';
export {
  FIRMWARE_TRANSFER_FUNCTIONS,
  isFirmwareTransferFunction,
  isFirmwareTransferFrame,
  findFirmwareTransferFrame,
} from './firmwareTransfer.js';
export type { FirmwareTransferFrameHit } from './firmwareTransfer.js';
export {
  QUERY_FUNCTIONS_BY_GEN,
  BROADCAST_QUERY_FUNCTIONS,
  queryFunctionsForModel,
  isQueryFrame,
} from './queryFunctions.js';
export { resolveEffectId, FRACTAL_MODEL_BYTES } from './effectId.js';
export { encode14, decode14, packValue16, unpackValue16 } from './septet16.js';
export { displayToWire, wireToDisplay, displayQuantum, withinDisplayQuantum } from './displayScale.js';
export type { DisplayScale, DisplayToWireOptions } from './displayScale.js';
export {
  packValue,
  unpackValue,
  packFloat32LE,
  unpackFloat32LE,
  packValueChunked,
  unpackValueChunked,
} from './packValue.js';
export type { ParamId } from './types.js';
export type {
  BaseParam,
  ReadResponse,
  DeviceCapabilities,
  DeviceIdentity,
  BlockTypeRegistry,
  ParamRegistry,
  FractalDevice,
} from './device.js';
export {
  FRACTAL_DEVICE_REGISTRY,
  registerDevice,
  deviceByModelByte,
  deviceBySlug,
} from './device.js';
export {
  LINEAGE_BLOCKS,
  loadLineage,
  scoreRecord,
  matchesStructured,
  formatLineageRecord,
  runLineageLookup,
} from './lineageLookup.js';
export type {
  LineageBlock,
  LineageRecord,
  LineageLookupAsk,
  LineageLookupHit,
  LineageLookupResult,
} from './lineageLookup.js';
export { decodeSeptetStream } from './septetStream.js';
export {
  POLL_QUANTUM_MS,
  MIN_FRAME_GAP_MS,
  MAX_REQUESTS_IN_FLIGHT,
  REPLY_TIMEOUT_MS,
  pollPeriodMs,
  GEN3_POLL_TIERS,
  gen3PollTier,
} from './pollTiming.js';
export type { Gen3PollTier } from './pollTiming.js';

// ── Offline file-container primitives ───────────────────────────────
export { decodeUtf8, encodeUtf8 } from './utf8.js';
export {
  DEFAULT_ZIP_LIMITS,
  zipCrc32,
  assertSafeEntryName,
  readZipArchive,
  writeStoredZipArchive,
} from './zipArchive.js';
export type { ZipEntry, ZipLimits } from './zipArchive.js';
export {
  DEFAULT_XML_LIMITS,
  isWhitespaceText,
  parseXml,
  parseXmlString,
  serializeXml,
  xmlAttribute,
  xmlChildren,
} from './xml.js';
export type {
  XmlAttribute,
  XmlElement,
  XmlLimits,
  XmlSerializeOptions,
} from './xml.js';
export { XTEA_DELTA, XTEA_CYCLES, decryptXteaPairs } from './xtea.js';
export type { XteaRecordKey, XteaDecryptOptions } from './xtea.js';
