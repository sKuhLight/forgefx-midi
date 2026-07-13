/**
 * AM4 cache-build inputs — seeds + param catalog for the `src/cache` engine.
 *
 * `buildCache({ kind: 'bytes' }, AM4_CACHE_PARAMS, AM4_SEEDS, …)` turns an
 * official AM4-Edit `effectDefinitions_*.cache` file into a family-mapped
 * device profile (enum overrides, display ranges, section metadata, rosters),
 * exactly as the gen-3 path does with `FM3_PARAMS` + `HW_SEEDS`.
 *
 * Two exports, both browser-safe (no `node:*`, no `Buffer`):
 *
 *   - `AM4_CACHE_PARAMS` — a `DeviceParam[]` DERIVED (not copied) from the
 *     shipped `CACHE_PARAMS` dictionary. The join to the cache byte space is:
 *       family  = CACHE_PARAMS block name (lowercase: 'amp','reverb',…) — the
 *                 AM4 catalog's own block vocabulary, which is what the built
 *                 profile's tables are keyed by.
 *       paramId = `pidHigh`, i.e. the section-local cache RECORD id (verified
 *                 against the cache-oracle comments, e.g. `amp.xfleakage`
 *                 pidHigh 0x13 == "section 10 id 19").
 *       unit / displayMin / displayMax pass straight through so the voter can
 *                 reward kind + display-range agreement.
 *
 *   - `AM4_SEEDS` — family → cache section-tag anchors for the load-bearing
 *     core blocks. Derived by running the section→family voter over the
 *     reference AM4-Edit cache (model 0x15, fw 66p1): the vote maps ALL 17
 *     blocks with zero unmapped families, and these four anchors each win their
 *     own vote (`assign.ts` seed-coherence check), so they stay stable while
 *     the remaining 13 families vote in around them. AM4 section tags are NOT
 *     the gen-3 `HW_SEEDS` tags: amp/reverb/delay happen to coincide (10/12/13)
 *     but drive is section 25 (gen-3 25 = FUZZ) and CABINET has no standalone
 *     AM4 block (the amp block carries an integrated cab).
 */
import type { DeviceParam } from '../cache/types.js';
import { CACHE_PARAMS } from './cacheParams.js';

/**
 * Family (AM4 block name) → cache section tag, for the well-known core blocks.
 * These anchor the section→family assignment; the remaining families are voted
 * in by `buildDeviceCache`. Each anchor is vote-coherent on the reference cache.
 */
export const AM4_SEEDS: Record<string, number> = {
  amp: 10,
  drive: 25,
  reverb: 12,
  delay: 13,
};

/**
 * AM4 param catalog in the `DeviceParam[]` shape the cache voter consumes,
 * derived from `CACHE_PARAMS` (no data duplication). One row per cache-backed
 * param; `paramId` is the section-local cache record id (`pidHigh`). The block
 * type-selector param is named `<family>_TYPE` so the build's default roster
 * selector (`${family}_TYPE`) picks it up and emits the family's model roster.
 */
export const AM4_CACHE_PARAMS: readonly DeviceParam[] = Object.values(CACHE_PARAMS).map(
  (p): DeviceParam => {
    const dp: DeviceParam = {
      family: p.block,
      paramId: p.pidHigh,
      name: p.name === 'type' ? `${p.block}_TYPE` : `${p.block}.${p.name}`,
    };
    if (p.unit !== undefined) dp.unit = p.unit;
    if (typeof p.displayMin === 'number') dp.displayMin = p.displayMin;
    if (typeof p.displayMax === 'number') dp.displayMax = p.displayMax;
    return dp;
  },
);
