/**
 * cache:check — device-cache drift gate.
 *
 * Sibling in spirit to `catalog:check` (`export-catalog.ts --check`): builds a
 * complete FM3 cache from the committed FM3 fw-12.0 walk fixture through the
 * full `buildCache` orchestrator, then asserts it reproduces the SHIPPED FM3
 * catalog tables within the generator's thresholds — via the SAME shared
 * `assertFm3Equivalence` oracle the `cache/assign` + `cache/buildprofile` tests
 * use, so the gate and the tests can never drift.
 *
 * This is a Node script, so `node:fs` is fine. It drives `buildCache` end to
 * end: the committed fixture is a decoded walk (`{sections, records}`), so the
 * records feed `buildCache` via a `{ kind: 'live', walk }` shim — equivalent to
 * the `bytes` path, which the `cache/buildprofile` test exercises with a
 * re-encoded buffer and `cache/records` covers against the raw `.cache`.
 *
 * Prints the measured margins and exits non-zero on any threshold failure.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCache, HW_SEEDS } from '../src/cache/index.js';
import type { CacheRecord } from '../src/cache/types.js';
import { FM3_PARAMS } from '../src/gen3/fm3/index.js';
import { assertFm3Equivalence } from '../test/cache/oracle.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'cache',
  'fixtures',
  'fm3-12p0.walk.json',
);

async function main(): Promise<void> {
  const walk = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { records: CacheRecord[] };
  const records = walk.records;

  const built = await buildCache({ kind: 'live', walk: async () => records }, FM3_PARAMS, HW_SEEDS, {
    model: 0x11,
    firmware: '12.0',
  });

  const m = assertFm3Equivalence(built);

  console.log('cache:check — FM3 fw 12.0 (model 0x11) via buildCache:');
  console.log(`  records consumed : ${built.meta.recordCount} (source: ${built.meta.source})`);
  console.log(
    `  enum lists       : ${m.enum.exact}/${m.enum.total} exact ` +
      `(mismatch ${m.enum.mismatch}, missing ${m.enum.missing}, non-special missing ${m.enum.badMissing}) [need >= 466, mismatch 0]`,
  );
  console.log(
    `  ranges           : ${m.ranges.ok}/${m.ranges.total} agree (${m.ranges.pct.toFixed(2)}%) [need >= 99.5%]`,
  );
  console.log(`  DELAY roster     : ${m.delayRoster.count} models, [0]='${m.delayRoster.first}' [need 27]`);
  console.log(
    `  cab-IR banks     : FACTORY 1=${m.cabIrs.factory1}, FACTORY 2=${m.cabIrs.factory2}, ` +
      `LEGACY=${m.cabIrs.legacy} (all exact)`,
  );
  console.log(`  families mapped  : ${m.sections.mapped} (all seeds anchored)`);
  console.log('cache:check PASS — built FM3 cache matches shipped catalog within thresholds.');
}

main().catch((err) => {
  console.error('cache:check FAIL');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
