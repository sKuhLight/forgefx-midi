/**
 * buildCache orchestrator goldens.
 *
 * Proves source-agnosticism: `buildCache` fed the FM3 fw-12.0 fixture as a
 * `bytes` source and as a `live` source (an injected `walk()` returning the
 * fixture's already-decoded records) produces deep-equal DATA (enumOverrides,
 * ranges, rangeSections, rosters, cabIrs, unmapped*). The only permitted
 * difference is `meta.source`. Also checks `meta.recordCount`/`meta.source`
 * and that the built data still clears the shared FM3 equivalence oracle.
 *
 * `src/cache/*` stays browser-safe; this TEST may use `node:fs`. The `bytes`
 * arm re-serialises the fixture's decoded records back into the raw cache
 * grammar (a local inverse of `parseCacheRecords`) so `buildCache` genuinely
 * walks bytes through the browser-safe `DataView` decoder, fully independent of
 * the `live` arm — deep-equal data across the two proves source-agnosticism.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCache, HW_SEEDS } from '../../src/cache/index.js';
import type { BuiltCache } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';
import { FM3_PARAMS } from '../../src/gen3/fm3/index.js';
import { assertFm3Equivalence } from './oracle.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const BUILDPROFILE_CASE_COUNT = 4;

/** Strip the `meta` envelope so only the derived data is compared. */
function dataOf(c: BuiltCache): Record<string, unknown> {
  const { meta: _meta, model: _model, firmware: _firmware, ...data } = c;
  return data;
}

export async function runBuildProfile(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/buildprofile] ${msg}`);
  };

  const walkText = readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8');
  const records = (JSON.parse(walkText) as { records: CacheRecord[] }).records;

  // Encode the decoded records back to a raw cache buffer so the `bytes` arm
  // truly walks bytes (parseCacheRecords), independent of the `live` arm.
  const buf = encodeCache(records);

  const fromBytes = await buildCache({ kind: 'bytes', buf }, FM3_PARAMS, HW_SEEDS, {
    model: 0x11,
    firmware: '12.0',
  });
  const fromLive = await buildCache(
    { kind: 'live', walk: async () => records },
    FM3_PARAMS,
    HW_SEEDS,
    { model: 0x11, firmware: '12.0' },
  );

  // ---- Case 1: source-agnostic DATA is deep-equal --------------------------
  const a = JSON.stringify(dataOf(fromBytes));
  const b = JSON.stringify(dataOf(fromLive));
  if (a !== b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    fail(
      `bytes vs live data diverged at char ${i}: ` +
        `bytes …${a.slice(Math.max(0, i - 30), i + 30)}… vs live …${b.slice(Math.max(0, i - 30), i + 30)}…`,
    );
  }
  console.log(`  cache/buildprofile: bytes-source and live-source data deep-equal (${a.length} JSON chars)`);

  // ---- Case 2: meta.recordCount / meta.source ------------------------------
  if (fromBytes.meta.source !== 'bytes') fail(`bytes meta.source = ${fromBytes.meta.source}`);
  if (fromLive.meta.source !== 'live') fail(`live meta.source = ${fromLive.meta.source}`);
  if (fromBytes.meta.recordCount !== records.length) {
    fail(`bytes meta.recordCount = ${fromBytes.meta.recordCount}, want ${records.length}`);
  }
  if (fromLive.meta.recordCount !== records.length) {
    fail(`live meta.recordCount = ${fromLive.meta.recordCount}, want ${records.length}`);
  }
  if (fromBytes.meta.builtAt !== undefined) fail('meta.builtAt must be undefined when opts omits it');
  console.log(
    `  cache/buildprofile: meta ok (recordCount=${records.length}, source bytes|live, builtAt undefined)`,
  );

  // ---- Case 3: identity envelope + caller-supplied builtAt ------------------
  if (fromBytes.model !== 0x11 || fromBytes.firmware !== '12.0') {
    fail(`envelope wrong: model=${fromBytes.model} firmware=${fromBytes.firmware}`);
  }
  const stamped = await buildCache({ kind: 'live', walk: async () => records }, FM3_PARAMS, HW_SEEDS, {
    builtAt: '2026-07-10T00:00:00Z',
  });
  if (stamped.meta.builtAt !== '2026-07-10T00:00:00Z') {
    fail(`caller builtAt not carried: ${stamped.meta.builtAt}`);
  }
  console.log('  cache/buildprofile: model/firmware envelope + caller builtAt carried');

  // ---- Case 4: built data still clears the FM3 oracle ----------------------
  const m = assertFm3Equivalence(fromBytes);
  console.log(
    `  cache/buildprofile: oracle clear (enum ${m.enum.exact}/${m.enum.total}, ` +
      `ranges ${m.ranges.pct.toFixed(2)}%, DELAY ${m.delayRoster.count})`,
  );
}

// --- minimal little-endian cache encoder (inverse of parseCacheRecords) ------
// Re-serialises decoded records into the exact grammar the walker reads, so the
// `bytes` arm exercises the real DataView walk. Groups records by section in
// first-seen order (matching the fixture's section ordering).

function encodeCache(records: readonly CacheRecord[]): Uint8Array {
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const f32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    bytes.push(b[0], b[1], b[2], b[3]);
  };
  const lp = (s: string) => {
    u32(s.length);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };

  // 46-byte preamble filler (first section header lands at 0x2e).
  for (let i = 0; i < 0x2e; i++) bytes.push(0);

  // Preserve section order + counts as they appear in the record stream.
  const order: number[] = [];
  const bySection = new Map<number, CacheRecord[]>();
  for (const r of records) {
    let g = bySection.get(r.section);
    if (!g) {
      g = [];
      bySection.set(r.section, g);
      order.push(r.section);
    }
    g.push(r);
  }

  for (const tag of order) {
    const recs = bySection.get(tag)!;
    u32(tag);
    u32(recs.length);
    for (const r of recs) {
      u16(r.id);
      u16(r.tc);
      u16(0); // pad
      f32(r.min);
      f32(r.max);
      f32(r.def);
      f32(r.step);
      if (r.kind === 'enum') {
        u32(r.values.length);
        for (const v of r.values) lp(v);
        if (r.id >= 0xfff0 && r.id <= 0xfffe) {
          // tableTail: u16 0, u32 idCount, idCount*u32 wireId
          u16(0);
          const ids = r.wireIds ?? [];
          u32(ids.length);
          for (const w of ids) u32(w);
        } else {
          u32(r.x); // x
          u16(0); // z
        }
      } else {
        u32(r.t1);
        u32(r.t2);
        u16(0); // z
      }
    }
  }

  return new Uint8Array(bytes);
}
