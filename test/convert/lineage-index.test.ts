/**
 * Unified lineage-index goldens.
 *
 * Asserts the index builds from all sources, that amp identity chains match
 * exactly across the gen-3 trio, that AM4 and Axe-Fx II models resolve to
 * gen-3 candidates via lineage/exact, that the fallback path fires for a
 * roster-backed family, and that a family with no roster data returns [].
 * Fixtures are drawn from the committed generated rosters / lineage corpora.
 */
import {
  buildLineageIndex,
  matchModel,
  resetLineageIndexCache,
  type LineageMatch,
} from '../../src/convert/lineageIndex.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[convert/lineage-index] ${msg}`);
}

const top = (m: LineageMatch[]): LineageMatch | undefined => m[0];
const hasConf = (m: LineageMatch[], c: string): boolean => m.some((x) => x.confidence === c);

export const LINEAGE_INDEX_CASE_COUNT = 14;

export function runLineageIndexTests(): void {
  resetLineageIndexCache();
  const idx = buildLineageIndex();

  // 1. Index builds from every source.
  assert(idx.records.length > 500, `expected >500 records, got ${idx.records.length}`);
  assert((idx.byFamily.get('amp')?.length ?? 0) > 100, 'amp family should be well-populated');
  assert(idx.byFamily.has('reverb'), 'reverb family present');
  assert(idx.byFamily.has('cab'), 'cab family present (FM3 rosters)');

  // 2. A shared amp name resolves EXACT across the gen-3 trio, and the record
  //    carries a device→value map for each hosting device.
  const bassguy = idx.byFamily.get('amp')!.find((r) => r.nativeName === '59 Bassguy Bright');
  assert(bassguy !== undefined, '"59 Bassguy Bright" should be indexed');
  assert(
    bassguy!.deviceValues.get('fm3') === 0 &&
      bassguy!.deviceValues.get('axe-fx-iii') === 0 &&
      bassguy!.deviceValues.get('fm9') === 0,
    '"59 Bassguy Bright" should map to ordinal 0 on fm3/iii/fm9',
  );

  const toIII = matchModel(
    { device: 'fm3', family: 'amp', typeName: '59 Bassguy Bright' },
    'axe-fx-iii',
  );
  assert(top(toIII)?.confidence === 'exact', 'fm3→iii amp should be exact');
  assert(top(toIII)?.targetTypeValue === 0, 'fm3→iii amp value should be 0');

  const toFm9 = matchModel(
    { device: 'fm3', family: 'amp', typeName: '59 Bassguy Bright' },
    'fm9',
  );
  assert(top(toFm9)?.confidence === 'exact', 'fm3→fm9 amp should be exact');

  // 3. AM4 amp with lineage → gen-3 candidate (exact when the name is shared).
  const am4Shared = matchModel(
    { device: 'am4', family: 'amp', typeName: '59 Bassguy Bright' },
    'fm3',
  );
  assert(top(am4Shared)?.confidence === 'exact', 'am4→fm3 shared-name amp should be exact');

  // A Fender-derived AM4 amp whose exact name is NOT on gen-3 still resolves
  // via basedOn lineage.
  const am4Lineage = matchModel(
    { device: 'am4', family: 'amp', typeName: '5F1 Tweed EC Champlifier' },
    'fm3',
  );
  assert(am4Lineage.length > 0, 'am4→fm3 lineage amp should return candidates');
  assert(hasConf(am4Lineage, 'lineage'), 'am4→fm3 should include a lineage-confidence match');

  // 4. Axe-Fx II → gen-3 via basedOn identity (am4Name/basedOn cross-key).
  const iiLineage = matchModel(
    { device: 'axe-fx-ii', family: 'amp', typeName: '65 BASSGUY NRML', typeValue: 1 },
    'fm3',
  );
  assert(top(iiLineage)?.confidence === 'lineage', 'II→fm3 amp should be lineage');
  assert(
    top(iiLineage)?.targetTypeName === '65 Bassguy Normal',
    'II→fm3 amp should land on "65 Bassguy Normal"',
  );

  // 5. Fallback path: unknown source name in a roster-backed family.
  const fb = matchModel(
    { device: 'am4', family: 'amp', typeName: 'ZZZ Not A Real Amp' },
    'fm3',
  );
  assert(fb.length === 1 && fb[0].confidence === 'fallback', 'unknown amp → single fallback');

  // 6. Family with no roster/lineage data anywhere → [].
  assert(
    matchModel({ device: 'am4', family: 'looper', typeName: 'x' }, 'fm3').length === 0,
    'unknown/unbacked family should return []',
  );
  // Target device that hosts no models in the family → [].
  assert(
    matchModel({ device: 'am4', family: 'cab', typeName: 'x' }, 'axe-fx-iii').length === 0,
    'cab has no axe-fx-iii roster data → []',
  );
}
