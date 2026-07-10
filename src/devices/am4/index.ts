/**
 * AM4 descriptor entry point (`forgefx-midi/devices/am4`).
 * Entry export: `AM4_DESCRIPTOR`.
 */
export * from './descriptor.js';

// Side-effect import: registers the AM4 connector factory with the shared
// connection registry. Previously guaranteed transitively (wireOps imported
// midi.ts for the message describer); explicit since the describer moved to
// describe.ts. Browser-harmless — the factory is only invoked by
// ensureConnection(), which browser runtimes never call.
import './midi.js';

// Live device-edit detection primitives (front-panel / AM4-Edit catch — HW-107): the device-true
// "edited" bit (GET_PATCH byte[21]&0x04) + the fn-0x1F atomic param read. Both hardware-verified in
// readOps.ts; surfaced here so ForgeFX's AM4 device-edit watcher can drive them.
export { readActiveBufferEditedBit, readAllParams, type AtomicReadResult } from './shared/readOps.js';

// Opt-in container decode that sits ON TOP of the opaque backup / round-trip surface: unpack the
// chunk payloads, verify the CRC, Huffman-decompress the body, and surface the preset + scene names
// and amp params. Surfaced here so ForgeFX can enrich its backup/decode DTOs with crcValid + scene
// names without reaching into the (non-exported) presetDump module path.
export { decodeAm4PresetDump, decodeAm4PresetDumpBytes } from './presetDump.js';
export type { Am4DecodedPreset } from './presetDump.js';
