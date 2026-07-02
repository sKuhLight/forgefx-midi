/**
 * Smoke test for lineage loader — confirms the JSON files are reachable
 * at runtime from the compiled location (post-`copy-build-assets`).
 *
 * The test runs against the SOURCE tree under `src/shared/lineage/`
 * (tsx resolves there) — once we publish, the same code path resolves
 * to `dist/shared/lineage/`. The runtime path is the same either way:
 * `__dirname/lineage/<block>-lineage.json`.
 */
import { loadLineage, LINEAGE_BLOCKS } from '../../src/shared/lineageLookup.js';

export function runLineageTests(): void {
  for (const block of LINEAGE_BLOCKS) {
    const records = loadLineage(block);
    if (!Array.isArray(records)) {
      throw new Error(`${block}: loadLineage did not return an array`);
    }
    if (records.length === 0) {
      throw new Error(`${block}: lineage records list is empty`);
    }
    // Spot-check the first record has the minimum shape.
    const first = records[0];
    if (typeof first.am4Name !== 'string' || first.am4Name.length === 0) {
      throw new Error(`${block}: first record missing am4Name`);
    }
  }
}
