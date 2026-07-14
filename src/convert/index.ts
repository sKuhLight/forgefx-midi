/**
 * Cross-device preset converter — P0 foundation.
 *
 * Exposes:
 *   - the universal block-family taxonomy + per-device presence / topology
 *     (`families.js`),
 *   - the device-agnostic preset IR types (`ir.js`),
 *   - the reverse concept-key lookup used by the adapters (`conceptLookup.js`),
 *   - the per-device lift adapters (`adapters/`).
 *
 * See `docs/PRESET-CONVERTER-IR.md` for the IR shape, taxonomy derivation
 * rules, and per-device adapter depth.
 */

export * from './families.js';
export * from './ir.js';
export { conceptKeyForLocal, conceptPortFor } from './conceptLookup.js';
export * from './adapters/index.js';
