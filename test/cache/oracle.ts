/**
 * Shared FM3 equivalence oracle.
 *
 * The single source of truth for the thresholds that gate a built FM3 cache
 * against the SHIPPED FM3 catalog tables. Imported by BOTH `cache/assign.test`
 * (unit gate) and `scripts/cache-check.ts` (drift gate) so the two can never
 * drift apart. Mirrors the offline generator's `validate_fm3`:
 *   - enum lists: every produced list present in FM3_ENUM_OVERRIDES is
 *     byte-exact (mismatch == 0); at least 466/471 oracle lists reproduced;
 *     the only permitted gaps are special (>=0xfff0) table views.
 *   - ranges: kind + display bounds agree on >= 99.5% of informative rows
 *     (2% float tolerance).
 *   - DELAY model roster (paramId 6) == 27 models starting 'Digital Mono',
 *     names matching the lineage-annotated FM3_ROSTERS.delay.
 *   - cab-IR FACTORY 1/2 + LEGACY reproduce FM3_CAB_IRS exactly.
 *   - every seeded family resolves to its anchored section tag.
 *
 * `assertFm3Equivalence` THROWS on any threshold failure and otherwise returns
 * the measured margins for the caller to print. Pure aside from importing the
 * shipped FM3 catalog (no fs).
 */
import type { BuiltCacheData } from '../../src/cache/types.js';
import { HW_SEEDS } from '../../src/cache/index.js';
import { FM3_ENUM_OVERRIDES, FM3_RANGES, FM3_CAB_IRS, FM3_ROSTERS } from '../../src/gen3/fm3/index.js';

/** The subset of a built cache the oracle inspects (BuiltCache or BuiltCacheData both satisfy). */
export type OracleInput = Pick<
  BuiltCacheData,
  'enumOverrides' | 'ranges' | 'rangeSections' | 'rosters' | 'cabIrs'
>;

export interface OracleMargins {
  enum: { exact: number; total: number; mismatch: number; missing: number; badMissing: number };
  ranges: { ok: number; total: number; pct: number };
  delayRoster: { count: number; first: string };
  cabIrs: { factory1: number; factory2: number; legacy: number };
  sections: { mapped: number };
}

/** Relative-tolerance float compare, port of the generator's `close`. */
function close(a: number, b: number, tol = 0.02): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  return d <= tol * Math.max(1e-9, Math.abs(a), Math.abs(b)) || d < 1e-6;
}

function eqStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Assert a built FM3 cache reproduces the shipped tables within the generator's
 * thresholds. Throws (prefix `[cache/oracle]`) on any failure; returns margins.
 */
export function assertFm3Equivalence(built: OracleInput): OracleMargins {
  const fail = (msg: string): never => {
    throw new Error(`[cache/oracle] ${msg}`);
  };

  // ---- enum-override oracle -------------------------------------------------
  let exact = 0;
  let mismatch = 0;
  let missing = 0;
  let badMissing = 0;
  const mismatchSamples: string[] = [];
  for (const [fam, m] of Object.entries(FM3_ENUM_OVERRIDES)) {
    for (const [pid, labels] of Object.entries(m)) {
      const got = built.enumOverrides[fam]?.[pid];
      if (got === undefined) {
        missing += 1;
        if (Number(pid) < 0xfff0) badMissing += 1;
      } else if (eqStrings(got, labels)) {
        exact += 1;
      } else {
        mismatch += 1;
        if (mismatchSamples.length < 8) {
          mismatchSamples.push(
            `${fam}.${pid} got[${got.length}] want[${labels.length}] ` +
              `first-diff=${JSON.stringify([got[0], labels[0]])}`,
          );
        }
      }
    }
  }
  const enumTotal = exact + mismatch + missing;
  if (mismatch !== 0) {
    fail(`enum oracle: ${mismatch} list(s) diverge (must be 0). samples: ${mismatchSamples.join(' | ')}`);
  }
  if (badMissing !== 0) {
    fail(`enum oracle: ${badMissing} non-special (pid<0xfff0) list(s) missing (must be 0)`);
  }
  if (exact < 466) {
    fail(`enum oracle: only ${exact}/471 exact, need >= 466 (possible fw drift or port bug)`);
  }

  // ---- range oracle ---------------------------------------------------------
  let rt = 0;
  let rok = 0;
  const rangeSamples: string[] = [];
  for (const [fam, m] of Object.entries(FM3_RANGES)) {
    for (const [pid, r] of Object.entries(m)) {
      const g = built.ranges[fam]?.[Number(pid)];
      if (g === undefined) continue;
      rt += 1;
      if (g.kind === r.kind && close(g.displayMin, r.displayMin) && close(g.displayMax, r.displayMax)) {
        rok += 1;
      } else if (rangeSamples.length < 10) {
        rangeSamples.push(
          `${fam}.${pid} got{${g.kind},${g.displayMin},${g.displayMax}} ` +
            `want{${r.kind},${r.displayMin},${r.displayMax}}`,
        );
      }
    }
  }
  const rangePct = rt === 0 ? 0 : (100 * rok) / rt;
  if (rok < rt * 0.995) {
    fail(
      `range oracle: only ${rok}/${rt} agree, need >= ${(rt * 0.995).toFixed(0)}. ` +
        `samples: ${rangeSamples.join(' | ')}`,
    );
  }

  // ---- DELAY model roster ---------------------------------------------------
  const dm = built.enumOverrides['DELAY']?.['6'];
  if (!dm || dm.length !== 27 || dm[0] !== 'Digital Mono') {
    fail(`DELAY_MODEL (paramId 6) wrong: len=${dm?.length} first=${dm?.[0]}`);
  }
  const delayRoster = built.rosters['DELAY'];
  if (!delayRoster || delayRoster.length !== 27 || delayRoster[0].name !== 'Digital Mono') {
    fail(`DELAY roster projection wrong: len=${delayRoster?.length} first=${delayRoster?.[0]?.name}`);
  }
  const oracleDelay = FM3_ROSTERS['delay'];
  const rosterNameDiffs = delayRoster!
    .map((t, i) => (oracleDelay[i] && oracleDelay[i].name !== t.name ? `${i}:${t.name}!=${oracleDelay[i].name}` : null))
    .filter((x): x is string => x !== null);
  if (oracleDelay.length !== 27 || rosterNameDiffs.length !== 0) {
    fail(
      `DELAY roster names diverge from FM3_ROSTERS.delay (len ${oracleDelay.length}): ` +
        rosterNameDiffs.join(', '),
    );
  }

  // ---- cab-IR banks ---------------------------------------------------------
  for (const bank of ['FACTORY 1', 'FACTORY 2', 'LEGACY']) {
    const got = built.cabIrs[bank];
    const want = FM3_CAB_IRS[bank] as readonly string[] | undefined;
    if (!got || !want || !eqStrings(got, want)) {
      fail(`cab-IR bank ${bank} not exact: got ${got?.length} want ${want?.length}`);
    }
  }

  // ---- section-map sanity vs seeds -----------------------------------------
  for (const [fam, tag] of Object.entries(HW_SEEDS)) {
    if (built.rangeSections[fam]?.sectionTag !== tag) {
      fail(`seed ${fam} resolved to ${built.rangeSections[fam]?.sectionTag}, expected ${tag}`);
    }
  }

  return {
    enum: { exact, total: enumTotal, mismatch, missing, badMissing },
    ranges: { ok: rok, total: rt, pct: rangePct },
    delayRoster: { count: delayRoster!.length, first: delayRoster![0].name },
    cabIrs: {
      factory1: built.cabIrs['FACTORY 1'].length,
      factory2: built.cabIrs['FACTORY 2'].length,
      legacy: built.cabIrs['LEGACY'].length,
    },
    sections: { mapped: Object.keys(built.rangeSections).length },
  };
}
