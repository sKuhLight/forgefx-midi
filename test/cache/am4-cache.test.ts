/**
 * AM4 cache-build goldens (FORGEFXMID-27).
 *
 * Proves `buildCache` turns an official AM4-Edit `effectDefinitions_*.cache`
 * into a valid, family-mapped profile via `AM4_SEEDS` + `AM4_CACHE_PARAMS`.
 *
 * The fixture `fixtures/am4-66p1.walk.json` is the DERIVED records-JSON of the
 * reference cache (model 0x15, fw 66p1) — decoded facts, never the raw file,
 * same policy as `fm3-12p0.walk.json`.
 *
 * Cases:
 *   1. source-agnostic: bytes-source and live-source data deep-equal.
 *   2. all four AM4 seed families anchored to their expected sections.
 *   3. full 17-family map, zero unmapped families; load-bearing families
 *      (amp/drive/reverb/delay) match by section + count profile.
 *   4. enum/range spot checks vs the SHIPPED AM4 catalog (`CACHE_PARAMS`).
 *   5. aggregate agreement rate vs the shipped catalog above a floor
 *      (measured 90.2% ranges / 93.3% enums on this cache; principled misses
 *      are log10-scaled knobs the linear voter can't reproduce + the
 *      chorus 20->27 firmware roster delta).
 *
 * `src/cache/*` + `src/am4/cacheBuild.ts` stay browser-safe; this TEST may use
 * `node:fs`. The bytes arm re-serialises the fixture records back to raw cache
 * grammar (shared `encodeCache`) so it genuinely walks bytes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCache } from '../../src/cache/index.js';
import type { BuiltCache } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';
import { AM4_SEEDS, AM4_CACHE_PARAMS, CACHE_PARAMS } from '../../src/am4/index.js';
import { encodeCache } from './buildprofile.test.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const AM4_CACHE_CASE_COUNT = 5;

/** Strip the `meta`/identity envelope so only derived data is compared. */
function dataOf(c: BuiltCache): Record<string, unknown> {
  const { meta: _m, model: _mo, firmware: _f, ...data } = c;
  return data;
}

/** Relative-tolerance float compare (2%) or absolute < 1e-6 (mirrors assign.ts). */
function close(a: number, b: number, tol = 0.02): boolean {
  if (a === b) return true;
  const d = Math.abs(a - b);
  return d <= tol * Math.max(1e-9, Math.abs(a), Math.abs(b)) || d < 1e-6;
}

type CP = { block: string; name: string; pidHigh: number; unit?: string; displayMin?: number; displayMax?: number; enumValues?: Record<number, string> };

export async function runAm4Cache(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/am4] ${msg}`);
  };

  const walkText = readFileSync(join(FIXTURES, 'am4-66p1.walk.json'), 'utf8');
  const records = (JSON.parse(walkText) as { records: CacheRecord[] }).records;

  const buf = encodeCache(records);
  const fromBytes = await buildCache({ kind: 'bytes', buf }, AM4_CACHE_PARAMS, AM4_SEEDS, {
    model: 0x15,
    firmware: '66p1',
  });
  const fromLive = await buildCache(
    { kind: 'live', walk: async () => records },
    AM4_CACHE_PARAMS,
    AM4_SEEDS,
    { model: 0x15, firmware: '66p1' },
  );

  // ---- Case 1: source-agnostic data deep-equal -----------------------------
  const a = JSON.stringify(dataOf(fromBytes));
  const b = JSON.stringify(dataOf(fromLive));
  if (a !== b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    fail(`bytes vs live diverged at char ${i}: …${a.slice(Math.max(0, i - 30), i + 30)}… vs …${b.slice(Math.max(0, i - 30), i + 30)}…`);
  }
  if (fromBytes.model !== 0x15 || fromBytes.firmware !== '66p1') {
    fail(`envelope wrong: model=${fromBytes.model} firmware=${fromBytes.firmware}`);
  }
  if (fromBytes.meta.recordCount !== records.length) {
    fail(`bytes meta.recordCount=${fromBytes.meta.recordCount}, want ${records.length}`);
  }
  console.log(`  cache/am4: bytes and live data deep-equal (${a.length} JSON chars, ${records.length} records)`);

  const built = fromBytes;

  // ---- Case 2: seed families anchored to their expected sections -----------
  const expectSeed: Record<string, number> = { amp: 10, drive: 25, reverb: 12, delay: 13 };
  for (const [fam, tag] of Object.entries(expectSeed)) {
    if (AM4_SEEDS[fam] !== tag) fail(`AM4_SEEDS.${fam}=${AM4_SEEDS[fam]}, want ${tag}`);
    const sec = built.rangeSections[fam];
    if (!sec) fail(`seed family '${fam}' has no rangeSection (unanchored)`);
    if (sec.sectionTag !== tag) fail(`family '${fam}' mapped to section ${sec.sectionTag}, want ${tag}`);
  }
  console.log(`  cache/am4: seeds anchored — ${Object.entries(expectSeed).map(([f, t]) => `${f}@${t}`).join(', ')}`);

  // ---- Case 3: full family map + load-bearing count profile ----------------
  if (built.unmappedFamilies.length !== 0) {
    fail(`unmapped families: ${built.unmappedFamilies.join(', ')}`);
  }
  const expectMap: Record<string, [number, number]> = {
    // family: [sectionTag, informative stride]
    amp: [10, 152], drive: [25, 50], reverb: [12, 73], delay: [13, 90],
    chorus: [16, 35], flanger: [17, 36], phaser: [19, 38], wah: [20, 30],
    compressor: [7, 42], geq: [8, 23], peq: [9, 37], filter: [24, 41],
    tremolo: [22, 25], enhancer: [26, 18], gate: [35, 23], volpan: [40, 21],
    rotary: [18, 24],
  };
  const mappedFams = Object.keys(built.rangeSections).sort();
  if (mappedFams.length !== Object.keys(expectMap).length) {
    fail(`mapped ${mappedFams.length} families, want ${Object.keys(expectMap).length}: ${mappedFams.join(', ')}`);
  }
  for (const [fam, [tag, stride]] of Object.entries(expectMap)) {
    const sec = built.rangeSections[fam];
    if (!sec) fail(`family '${fam}' not mapped`);
    if (sec.sectionTag !== tag) fail(`family '${fam}' @ section ${sec.sectionTag}, want ${tag}`);
    if (sec.stride !== stride) fail(`family '${fam}' stride ${sec.stride}, want ${stride}`);
  }
  console.log(`  cache/am4: all ${mappedFams.length} families mapped, 0 unmapped; section+count profile exact`);

  // ---- Case 4: enum/range spot checks vs the shipped catalog ---------------
  const cp = CACHE_PARAMS as unknown as Record<string, CP>;
  const rangeSpots: Array<[string, number, number]> = [
    ['amp.gain', 0, 10], ['amp.master', 0, 10], ['amp.presence', 0, 10],
    ['reverb.mix', 0, 100], ['delay.mix', 0, 100], ['drive.mix', 0, 100],
    ['amp.balance', -100, 100], ['reverb.balance', -100, 100],
  ];
  for (const [key, lo, hi] of rangeSpots) {
    const p = cp[key] ?? fail(`spot key '${key}' absent from CACHE_PARAMS`);
    const rg = built.ranges[p.block]?.[p.pidHigh];
    if (!rg) fail(`no built range for ${key} (section-local id ${p.pidHigh})`);
    if (rg.kind !== 'float') fail(`${key} built kind=${rg.kind}, want float`);
    if (!close(rg.displayMin, lo) || !close(rg.displayMax, hi)) {
      fail(`${key} built [${rg.displayMin},${rg.displayMax}] != catalog [${lo},${hi}]`);
    }
    if (!close(rg.displayMin, p.displayMin!) || !close(rg.displayMax, p.displayMax!)) {
      fail(`${key} built [${rg.displayMin},${rg.displayMax}] disagrees with shipped catalog [${p.displayMin},${p.displayMax}]`);
    }
  }
  // enum spot: count + first/last label, vs the shipped catalog's enumValues.
  const enumSpots: Array<[string, number, string, string]> = [
    ['amp.type', 250, '1959SLP Normal', 'PVH 6160 Block Clean'],
    ['drive.type', 78, 'Rat Distortion', 'Swedish Metal'],
    ['reverb.type', 79, 'Room, Small', 'Spring, Vibrato-King Custom'],
    ['delay.type', 29, 'Digital Mono', 'Surround Delay'],
    ['wah.type', 9, 'FAS Wah', 'Paragon'],
    ['gate.type', 4, 'Classic Expander', 'Modern Expander'],
  ];
  for (const [key, n, first, last] of enumSpots) {
    const p = cp[key] ?? fail(`spot key '${key}' absent`);
    const labels = built.enumOverrides[p.block]?.[String(p.pidHigh)];
    if (!labels) fail(`no built enum labels for ${key}`);
    if (labels.length !== n) fail(`${key} built ${labels.length} labels, want ${n}`);
    if (labels[0] !== first) fail(`${key} first label '${labels[0]}', want '${first}'`);
    if (labels[labels.length - 1] !== last) fail(`${key} last label '${labels[labels.length - 1]}', want '${last}'`);
    // agreement with the shipped catalog's enumValues (order-exact).
    const catVals = Object.entries(p.enumValues ?? {})
      .sort((x, y) => Number(x[0]) - Number(y[0]))
      .map(([, v]) => v);
    if (catVals.length !== labels.length || !catVals.every((v, i) => labels[i] === v)) {
      fail(`${key} built labels disagree with shipped catalog (built ${labels.length} vs catalog ${catVals.length})`);
    }
  }
  console.log(`  cache/am4: ${rangeSpots.length} range + ${enumSpots.length} enum spot checks agree with shipped catalog`);

  // ---- Case 5: aggregate agreement rate vs shipped catalog -----------------
  let rTotal = 0, rMatch = 0, eTotal = 0, eMatch = 0;
  for (const p of Object.values(cp)) {
    const rg = built.ranges[p.block]?.[p.pidHigh];
    if (!rg) continue;
    if (typeof p.displayMin === 'number' && typeof p.displayMax === 'number') {
      rTotal++;
      if (close(rg.displayMin, p.displayMin) && close(rg.displayMax, p.displayMax)) rMatch++;
    }
    if (p.unit === 'enum' && p.enumValues) {
      eTotal++;
      const labels = built.enumOverrides[p.block]?.[String(p.pidHigh)];
      const catVals = Object.entries(p.enumValues)
        .sort((x, y) => Number(x[0]) - Number(y[0])).map(([, v]) => v);
      if (labels && labels.length === catVals.length && catVals.every((v, i) => labels[i] === v)) eMatch++;
    }
  }
  const rPct = (100 * rMatch) / rTotal;
  const ePct = (100 * eMatch) / eTotal;
  // Floors below the measured 90.2% / 93.3%; principled misses are log10 knobs
  // + the chorus firmware roster delta (see file header).
  if (rPct < 88) fail(`range agreement ${rPct.toFixed(1)}% < 88% floor (${rMatch}/${rTotal})`);
  if (ePct < 90) fail(`enum agreement ${ePct.toFixed(1)}% < 90% floor (${eMatch}/${eTotal})`);
  console.log(
    `  cache/am4: agreement vs shipped catalog — ranges ${rMatch}/${rTotal} (${rPct.toFixed(1)}%), ` +
      `enums ${eMatch}/${eTotal} (${ePct.toFixed(1)}%)`,
  );
}
