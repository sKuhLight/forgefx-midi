/**
 * Section→family assignment oracle.
 *
 * Runs `buildDeviceCache(records, FM3_PARAMS, HW_SEEDS)` on the committed FM3
 * fw-12.0 walk fixture and asserts the result reproduces the SHIPPED FM3
 * catalog tables via the shared `assertFm3Equivalence` oracle (same thresholds
 * the `cache:check` drift gate uses — factored into `./oracle.ts` so the two
 * cannot drift):
 *   - enum lists: every produced list that exists in FM3_ENUM_OVERRIDES is
 *     byte-exact (mismatch == 0); at least 466/471 oracle lists reproduced.
 *   - ranges: kind + display bounds agree on >= 99.5% of informative rows.
 *   - DELAY model roster (paramId 6) == 27 models starting 'Digital Mono'.
 *   - cab-IR FACTORY 1/2 + LEGACY reproduce FM3_CAB_IRS exactly.
 *   - every seeded family resolves to its anchored section tag.
 *
 * `src/cache/*` stays browser-safe; this TEST may use `node:fs` to load the
 * fixture.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeviceCache, HW_SEEDS } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';
import { FM3_PARAMS } from '../../src/gen3/fm3/index.js';
import { assertFm3Equivalence } from './oracle.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const ASSIGN_CASE_COUNT = 5;

export function runAssign(): void {
  const walkText = readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8');
  const walk = JSON.parse(walkText) as { records: CacheRecord[] };
  const built = buildDeviceCache(walk.records, FM3_PARAMS, HW_SEEDS);

  const m = assertFm3Equivalence(built);

  console.log(
    `  cache/assign enum lists: ${m.enum.exact}/${m.enum.total} exact ` +
      `(mismatch ${m.enum.mismatch}, missing ${m.enum.missing}, non-special missing ${m.enum.badMissing})`,
  );
  console.log(`  cache/assign ranges: ${m.ranges.ok}/${m.ranges.total} agree (${m.ranges.pct.toFixed(2)}%)`);
  console.log(`  cache/assign DELAY roster: ${m.delayRoster.count} models, [0]='${m.delayRoster.first}'`);
  console.log(
    `  cache/assign cab-IR banks: FACTORY 1=${m.cabIrs.factory1}, ` +
      `FACTORY 2=${m.cabIrs.factory2}, LEGACY=${m.cabIrs.legacy} (all exact)`,
  );
  console.log(
    `  cache/assign sections: ${m.sections.mapped} families mapped, ` +
      `${built.unmappedFamilies.length} unmapped, ${built.unmappedSections.length} unmapped sections`,
  );
}
