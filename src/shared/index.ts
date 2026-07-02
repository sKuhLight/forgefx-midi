// Barrel for fractal-midi/shared.
//
// Vendor-shared protocol primitives that every Fractal device family
// member builds on: SysEx checksum, septet pack/unpack (chunked 8-to-7
// plus 14-bit / 16-bit LSB-first), display↔wire scaling, packed-float
// codec, and the shared `ParamId` / `FractalDevice` type shapes.
//
// Pure code — no MIDI transport dependency. Bring your own.

export { fractalChecksum } from './checksum.js';
export { resolveEffectId, FRACTAL_MODEL_BYTES } from './effectId.js';
export { encode14, decode14, packValue16, unpackValue16 } from './septet16.js';
export { displayToWire, wireToDisplay } from './displayScale.js';
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
