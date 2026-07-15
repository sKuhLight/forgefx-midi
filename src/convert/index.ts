/**
 * Cross-device preset converter — P0 foundation.
 *
 * Exposes:
 *   - the universal block-family taxonomy + per-device presence / topology
 *     (`families.js`),
 *   - the device-agnostic preset IR types (`ir.js`),
 *   - the reverse concept-key lookup used by the adapters (`conceptLookup.js`),
 *   - the per-device lift adapters (`adapters/`),
 *   - the P2 conversion engine + its event schema (`engine.js`, `events.js`).
 *
 * See `docs/PRESET-CONVERTER-IR.md` for the IR shape, taxonomy derivation
 * rules, per-device adapter depth, and the conversion pipeline + event catalog.
 */

export * from './families.js';
export * from './ir.js';
export { conceptKeyForLocal, conceptPortFor } from './conceptLookup.js';
export * from './lineageIndex.js';
export * from './adapters/index.js';
export * from './events.js';
export * from './engine.js';
export { resolveTargetRange, resolveTargetEnumOptions, type TargetRange } from './targetRanges.js';
