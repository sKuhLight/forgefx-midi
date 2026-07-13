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
