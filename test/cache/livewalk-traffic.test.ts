/**
 * Live walk — traffic pin.
 *
 * The walk's query and pause sequence is a hardware-validated envelope (pacing, read-only param
 * ceiling, speculative-probe class). Reply-loss handling may only ADD traffic when a reply is
 * actually missing. Pinned against goldens recorded from the walk as it was before reply-loss
 * handling existed, on the shared cache-shaped fake device over the FM3 fw 12.0 fixture, in the
 * host's read-only envelope (params 0..127, 3 ms between queries, 150 ms between blocks) incl. a
 * few blocks the fixture lacks:
 *   1. a device that answers every query gets byte-identical queries AND pauses, and the same
 *      records (placeholder rows aside);
 *   2. a device that leaves non-table addresses unanswered (the opposite assumption about the
 *      hardware) still completes with exactly those records — no abort — at bounded extra cost.
 * If an intended traffic change lands, re-record the goldens and say why in the change.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveWalkDetailed } from '../../src/cache/index.js';
import type { LiveWalkOptions } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';
import { cacheDevice } from './cacheDevice.js';

export const LIVEWALK_TRAFFIC_CASE_COUNT = 2;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Golden: the pre-rework walk on the healthy fake — 15 027 queries + pauses (30 106 trace entries). */
const GOLDEN_QUERIES = 15027;
const GOLDEN_TRACE_ENTRIES = 30106;
const GOLDEN_TRACE_SHA256 = '753840383e8d1a6ca137df716895c95259f1642fc3771a2c756c280f13357b6f';
/** Golden: the pre-rework walk's records (1744) — identical whether or not non-table addresses answer. */
const GOLDEN_RECORDS = 1744;
const GOLDEN_RECORDS_SHA256 = '9e4ea5e2723d00a18f56abb3401c4bd01a6d23dfff7a5b6f070ad9397bd46d05';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function runLiveWalkTraffic(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/livewalk-traffic] ${msg}`);
  };
  const all = (JSON.parse(readFileSync(join(FIXTURES, 'fm3-12p0.walk.json'), 'utf8')) as { records: CacheRecord[] }).records;
  const sections = [...new Set(all.filter((r) => r.id < 0xff00).map((r) => r.section))];
  const blocks = [...sections, 0, 5, 6, 27, 32, 99, 140].sort((a, b) => a - b);
  const opts: LiveWalkOptions = { model: 0x11, blocks, maxParamId: 127, interQueryMs: 3, blockPauseMs: 150 };
  let healthyLabels = -1;
  const realRecords = (rs: readonly CacheRecord[]): CacheRecord[] => rs.filter((r) => !(r.kind === 'float' && r.placeholder));

  // ---- Case 1: healthy device — identical traffic, identical records ----------------------
  {
    const dev = cacheDevice(all);
    const res = await liveWalkDetailed(dev, { ...opts, sleep: dev.sleep });
    const real = realRecords(res.records);
    if (res.queries !== GOLDEN_QUERIES || dev.trace.length !== GOLDEN_TRACE_ENTRIES || sha256(dev.trace.join('\n')) !== GOLDEN_TRACE_SHA256) {
      fail(`healthy-device traffic drifted: ${res.queries} queries, ${dev.trace.length} trace entries (want ${GOLDEN_QUERIES} / ${GOLDEN_TRACE_ENTRIES}, same bytes)`);
    }
    if (real.length !== GOLDEN_RECORDS || sha256(JSON.stringify(real)) !== GOLDEN_RECORDS_SHA256) fail(`healthy-device records drifted: ${real.length}`);
    if (res.lostReplies !== 0 || res.unresolvedReplies !== 0 || res.missingSlots !== 0 || res.silentAddresses !== 0) {
      fail(`healthy device reported losses: ${JSON.stringify({ ...res, records: undefined })}`);
    }
    healthyLabels = res.enumLabels;
    console.log(`  cache/livewalk-traffic: healthy device — ${res.queries} queries + pauses byte-identical to the pre-rework walk, same ${real.length} records (+${res.placeholderSlots} placeholders)`);
  }

  // ---- Case 2: silent non-table addresses — completes with the same records -------------
  {
    const dev = cacheDevice(all, { silent: true });
    const res = await liveWalkDetailed(dev, { ...opts, sleep: dev.sleep });
    const real = realRecords(res.records);
    if (real.length !== GOLDEN_RECORDS || sha256(JSON.stringify(real)) !== GOLDEN_RECORDS_SHA256) {
      fail(`silent-address walk lost or changed records: ${real.length}`);
    }
    // Proven-silent definition runs (8 in a row, or the run a block ends on) are reported as
    // silent addresses. Shorter silent runs that an answer ends — here the small id gaps of the
    // sparse GLOBAL section — cannot be told apart from dropped replies and stay loss: exactly one
    // missing slot per unresolved definition, no label or unit loss.
    if (res.silentAddresses === 0 || res.unresolvedReplies !== res.missingSlots || res.enumLabels !== healthyLabels) {
      fail(`silent-address accounting: ${JSON.stringify({ ...res, records: undefined })}`);
    }
    if (res.queries > GOLDEN_QUERIES * 1.1) fail(`silent addresses cost too much extra traffic: ${res.queries} queries (pre-rework ${GOLDEN_QUERIES})`);
    console.log(
      `  cache/livewalk-traffic: silent non-table addresses — walk completes with the same ${real.length} records ` +
        `(${res.queries} queries, +${(((res.queries - GOLDEN_QUERIES) / GOLDEN_QUERIES) * 100).toFixed(1)}%, ${res.silentAddresses} silent addresses, ` +
        `${res.unresolvedReplies} short inner silent runs kept as loss)`,
    );
  }
}
