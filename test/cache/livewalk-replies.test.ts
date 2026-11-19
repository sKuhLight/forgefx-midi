/**
 * Live walk — lost and late replies.
 *
 * A device answers every self-describe query (an empty slot with an empty-slot definition, the
 * end of a label list with a no-payload reply), so a transport `null` is a dropped or LATE frame,
 * never a device answer. These synthetic cases pin how the walk tells the two apart and why the
 * drain pause matters:
 *   - a late label reply must never be taken for the NEXT sub (the reply does not echo the sub,
 *     so that would silently shift a roster); a negative control without the pause proves the
 *     fake really models the hazard;
 *   - the first label query of a param stays one-shot (it may be a speculative probe);
 *   - lost definition / unit replies are retried; a definition that never answers is skipped and
 *     counted, never fabricated;
 *   - genuine sentinel / end replies are never retried;
 *   - a device that stops answering altogether ends the walk (bounded traffic), it is not
 *     retried into the ground — but addresses that merely do not answer while the device does
 *     (proven by re-reading the last answered definition) only count as absent;
 *   - the accounting reaches `buildCache` as `meta.walk`.
 *
 * Synthetic frames only (test-only encoders shared with `livewalk.test.ts`).
 */
import { buildCache, liveSource, liveWalkDetailed, VIEW_DEFINITION, VIEW_ENUM_LABEL, VIEW_VALUE } from '../../src/cache/index.js';
import type { LiveTransport, LiveWalkOptions } from '../../src/cache/index.js';
import type { CacheRecord, DeviceParam, EnumRecord } from '../../src/cache/types.js';
import { definitionBlockScaled, endOfRangeFrame, labelReply, replyFrame, sentinelFrame, valueReply } from './livewalk.test.js';

export const LIVEWALK_REPLIES_CASE_COUNT = 14;

const FM3 = 0x11;
const BLOCK = 90;

interface Q {
  view: number;
  block: number;
  param: number;
  sub: number;
}
function q(query: Uint8Array): Q {
  return { view: query[6]!, block: query[8]! | (query[9]! << 7), param: query[10]! | (query[11]! << 7), sub: query[12]! | (query[13]! << 7) };
}

/** A float/enum definition frame with an explicit wire scale. */
function defFrame(param: number, r: Partial<CacheRecord> & { kind: 'enum' | 'float' }, scale: number): Uint8Array {
  const rec = { section: BLOCK, offset: 0, id: param, tc: 16, min: 0, max: 0, def: 0, step: 0, t1: 0, t2: 0, count: 0, values: [], x: 0, ...r } as CacheRecord;
  return replyFrame(VIEW_DEFINITION, param, 0x3a, definitionBlockScaled(rec, scale));
}

const ROSTER = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const rosterDef = (param: number): Uint8Array => defFrame(param, { kind: 'enum', min: 0, max: ROSTER.length - 1 }, 0);

/**
 * A host with a virtual clock. Each request takes 4 virtual ms and its own answer lands at +2 ms;
 * `sleep` advances the clock. The first answer to label `lateSub` is LATE: it lands `lateBy` ms
 * after its request instead of inside the window. A frame landing while a request is listening is
 * taken by that request (the reply carries no sub, so a stale label is indistinguishable); one
 * landing between requests is dropped — unless `buffered`, in which case it waits in the host's
 * buffer for the next request until `drain()` discards it.
 */
class VirtualHost implements LiveTransport {
  now = 0;
  drains = 0;
  labelQueries = 0;
  private readonly pending: Array<{ due: number; frame: Uint8Array }> = [];
  private readonly buffer: Uint8Array[] = [];
  private lateFired = false;

  constructor(
    private readonly lateSub: number,
    private readonly lateBy: number,
    private readonly buffered: boolean,
    withDrain: boolean,
  ) {
    if (withDrain) this.drain = () => {
      this.land(this.now);
      this.buffer.length = 0;
      this.drains += 1;
    };
  }

  drain?: () => void;

  readonly sleep = (ms: number): Promise<void> => {
    this.now += ms;
    return Promise.resolve();
  };

  /** Frames due by `t` land between requests: buffered or dropped. */
  private land(t: number): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i]!.due <= t) {
        if (this.buffered) this.buffer.push(this.pending[i]!.frame);
        this.pending.splice(i, 1);
      }
    }
  }

  request(query: Uint8Array): Promise<Uint8Array | null> {
    this.land(this.now);
    const start = this.now;
    this.now += 4;
    const { view, param, sub } = q(query);
    let answer: Uint8Array | null;
    if (view === VIEW_DEFINITION) answer = param === 0 ? rosterDef(0) : sentinelFrame(VIEW_DEFINITION, param);
    else if (view === VIEW_ENUM_LABEL) {
      this.labelQueries += 1;
      answer = sub < ROSTER.length ? labelReply(ROSTER[sub]!, param) : endOfRangeFrame(VIEW_ENUM_LABEL, param);
    } else answer = sentinelFrame(view, param);
    // A stale frame already buffered is taken first.
    if (this.buffer.length > 0) {
      if (answer) this.pending.push({ due: start + 2, frame: answer });
      return Promise.resolve(this.buffer.shift()!);
    }
    // A stale frame landing inside this request's window, before its own answer, is taken instead.
    const early = this.pending.findIndex((p) => p.due > start && p.due <= start + 2);
    if (early >= 0) {
      const stale = this.pending.splice(early, 1)[0]!.frame;
      if (answer) this.pending.push({ due: start + 2, frame: answer });
      this.land(this.now);
      return Promise.resolve(stale);
    }
    if (view === VIEW_ENUM_LABEL && sub === this.lateSub && !this.lateFired && answer) {
      this.lateFired = true;
      this.pending.push({ due: start + this.lateBy, frame: answer });
      return Promise.resolve(null); // the host gave up: no reply inside the timeout
    }
    return Promise.resolve(answer);
  }
}

const rosterOf = (records: readonly CacheRecord[]): string[] => ((records[0] as EnumRecord | undefined)?.values ?? []).slice();

export async function runLiveWalkReplies(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/livewalk-replies] ${msg}`);
  };
  const base: LiveWalkOptions = { model: FM3, blocks: [BLOCK], maxParamId: 0, readValues: false };

  // ---- Case 1: negative control — without the drain pause a late reply shifts the roster -----
  {
    const host = new VirtualHost(2, 9, false, false);
    const res = await liveWalkDetailed(host, { ...base, lostReplyDrainMs: 0, sleep: host.sleep });
    const got = rosterOf(res.records);
    if (got[3] !== 'Charlie') {
      fail(`negative control: the fake must reproduce the shift (late 'Charlie' taken for sub 3), got ${JSON.stringify(got)}`);
    }
  }
  console.log('  cache/livewalk-replies: negative control — without a drain pause a late label shifts the roster');

  // ---- Case 2: the drain pause keeps the roster aligned (listen-only host, no drain hook) ----
  {
    const host = new VirtualHost(2, 9, false, false);
    const res = await liveWalkDetailed(host, { ...base, sleep: host.sleep });
    const got = rosterOf(res.records);
    if (JSON.stringify(got) !== JSON.stringify(ROSTER)) fail(`late reply shifted the roster: ${JSON.stringify(got)}`);
    if (res.lostReplies !== 1 || res.recoveredReplies !== 1 || res.unresolvedReplies !== 0) {
      fail(`late reply accounting: lost ${res.lostReplies} recovered ${res.recoveredReplies} unresolved ${res.unresolvedReplies}`);
    }
  }
  console.log('  cache/livewalk-replies: a late label reply is waited out — roster stays aligned, loss counted');

  // ---- Case 3: a buffering host is protected by its drain hook -------------------------------
  {
    const host = new VirtualHost(2, 9, true, true);
    const res = await liveWalkDetailed(host, { ...base, sleep: host.sleep });
    const got = rosterOf(res.records);
    if (JSON.stringify(got) !== JSON.stringify(ROSTER)) fail(`buffered late reply shifted the roster: ${JSON.stringify(got)}`);
    if (host.drains < 2) fail(`drain() must run before the retry and before moving on, ran ${host.drains}x`);
  }
  console.log('  cache/livewalk-replies: a buffering host drains the straggler via LiveTransport.drain');

  // ---- Case 4: the FIRST label query stays one-shot (speculative probe envelope) -------------
  {
    // Integer-stepped, integral bounds: a SPECULATIVE label probe; and a positive enum.
    for (const [label, def] of [
      ['speculative', defFrame(0, { kind: 'float', min: 0, max: 7, step: 1 }, 0)],
      ['enum', defFrame(0, { kind: 'enum', min: 0, max: 7 }, 0)],
    ] as const) {
      let labelQueries = 0;
      const t: LiveTransport = {
        request(query) {
          const { view, param } = q(query);
          if (view === VIEW_DEFINITION) return Promise.resolve(param === 0 ? def : sentinelFrame(view, param));
          if (view === VIEW_ENUM_LABEL) {
            labelQueries += 1;
            return Promise.resolve(null);
          }
          return Promise.resolve(sentinelFrame(view, param));
        },
      };
      const res = await liveWalkDetailed(t, { ...base, sleep: () => Promise.resolve() });
      if (labelQueries !== 1) fail(`${label}: first label query re-sent ${labelQueries}x (must be exactly 1)`);
      if (res.lostReplies !== 1 || res.unresolvedReplies !== 1) fail(`${label}: lost first label not counted`);
      // No answer is no evidence: the numeric guess stands.
      const want = label === 'enum' ? 'enum' : 'float';
      if (res.records[0]?.kind !== want) fail(`${label}: lost first label changed the kind to ${res.records[0]?.kind}`);
    }
  }
  console.log('  cache/livewalk-replies: the first label query is never retried (speculative probes stay one-shot)');

  // ---- Case 5: a lost definition is retried; one that never answers is skipped, not invented --
  {
    const floatDef = (p: number) => defFrame(p, { kind: 'float', tc: 2, min: 0, max: 10 }, 1);
    let dropsLeft = 1;
    const recovering: LiveTransport = {
      request(query) {
        const { view, param } = q(query);
        if (view === VIEW_DEFINITION && param <= 2) {
          if (param === 1 && dropsLeft > 0) {
            dropsLeft -= 1;
            return Promise.resolve(null);
          }
          return Promise.resolve(floatDef(param));
        }
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const ok = await liveWalkDetailed(recovering, { ...base, maxParamId: 4, sleep: () => Promise.resolve() });
    if (ok.records.map((r) => r.id).join(',') !== '0,1,2') fail(`recovered definition: ids ${ok.records.map((r) => r.id)}`);
    if (ok.recoveredReplies !== 1 || ok.unresolvedReplies !== 0) fail('recovered definition not counted as recovered');

    let attempts = 0;
    const silent: LiveTransport = {
      request(query) {
        const { view, param } = q(query);
        if (view === VIEW_DEFINITION && param === 1) {
          attempts += 1;
          return Promise.resolve(null);
        }
        if (view === VIEW_DEFINITION && param <= 2) return Promise.resolve(floatDef(param));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const gap = await liveWalkDetailed(silent, { ...base, maxParamId: 4, sleep: () => Promise.resolve() });
    if (gap.records.map((r) => r.id).join(',') !== '0,2') fail(`unanswered definition: ids ${gap.records.map((r) => r.id)} (must skip 1)`);
    if (attempts !== 3 || gap.unresolvedReplies !== 1 || gap.placeholderSlots !== 0) {
      fail(`unanswered definition: ${attempts} attempts, unresolved ${gap.unresolvedReplies}, placeholders ${gap.placeholderSlots}`);
    }
  }
  console.log('  cache/livewalk-replies: lost definitions are retried; a silent slot is skipped and counted, never invented');

  // ---- Case 6: a lost unit read is retried --------------------------------------------------
  {
    let dropped = false;
    const t: LiveTransport = {
      request(query) {
        const { view, param } = q(query);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(defFrame(0, { kind: 'float', tc: 2, min: 20, max: 200 }, 1));
        if (view === VIEW_VALUE && param === 0) {
          if (!dropped) {
            dropped = true;
            return Promise.resolve(null);
          }
          return Promise.resolve(valueReply('120.0 Hz', 0));
        }
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const res = await liveWalkDetailed(t, { ...base, readValues: true, sleep: () => Promise.resolve() });
    if (res.records[0]?.unit !== 'Hz') fail(`lost unit read not retried: unit ${res.records[0]?.unit}`);
  }
  console.log('  cache/livewalk-replies: a lost unit read (view 0x00) is retried');

  // ---- Case 7: genuine sentinel / end replies are never retried -----------------------------
  {
    let queries = 0;
    const t: LiveTransport = {
      request(query) {
        queries += 1;
        const { view, param } = q(query);
        if (view === VIEW_DEFINITION && param === 0) return Promise.resolve(rosterDef(0));
        if (view === VIEW_ENUM_LABEL) return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
        return Promise.resolve(sentinelFrame(view, param));
      },
    };
    const res = await liveWalkDetailed(t, { ...base, maxParamId: 3, paramAbsentRunLimit: 3, readValues: true, sleep: () => Promise.resolve() });
    // def 0, label sub 0 (end), unit read, defs 1..3 (sentinels) = 6 queries, none repeated.
    if (queries !== 6 || res.queries !== 6 || res.lostReplies !== 0) fail(`sentinels were retried: ${queries} queries, lost ${res.lostReplies}`);
  }
  console.log('  cache/livewalk-replies: sentinel and end-of-list replies are final (no retry)');

  // ---- Case 8: the accounting reaches buildCache as meta.walk ------------------------------
  {
    const host = new VirtualHost(2, 9, false, false);
    const params: DeviceParam[] = [{ family: 'AMP', paramId: 0, name: 'AMP_TYPE', unit: 'enum' }];
    const built = await buildCache(liveSource(host, { ...base, sleep: host.sleep }), params, {}, {});
    const w = built.meta.walk;
    if (!w || w.lostReplies !== 1 || w.recoveredReplies !== 1 || w.unresolvedReplies !== 0 || w.queries < 7) {
      fail(`meta.walk missing or wrong: ${JSON.stringify(w)}`);
    }
    // A plain record array (no accounting) leaves meta.walk out.
    const plain = await buildCache({ kind: 'live', walk: async () => [] }, params, {}, {});
    if (plain.meta.walk !== undefined) fail('meta.walk must be absent for a walk without accounting');
  }
  console.log('  cache/livewalk-replies: liveSource carries lost/recovered/unresolved counts into meta.walk');

  // ---- Case 9: a device that never answers ends the walk -----------------------------------
  {
    let sent = 0;
    const frozen: LiveTransport = {
      request() {
        sent += 1;
        return Promise.resolve(null);
      },
    };
    let error = '';
    try {
      await liveWalkDetailed(frozen, { model: FM3, blocks: [1, 2, 3, 4, 5], blockProbeDepth: 4, sleep: () => Promise.resolve() });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!/stopped answering/.test(error)) fail(`a silent device must abort the walk, got ${error || 'no error'}`);
    // Block probes stay one-shot: 8 unanswered probes, nothing ever answered to prove liveness.
    if (sent !== 8) fail(`never-answering device received ${sent} queries (want 8)`);
  }
  console.log('  cache/livewalk-replies: a device that never answers aborts the walk after 8 queries');

  const floatDef = (p: number): Uint8Array => defFrame(p, { kind: 'float', tc: 2, min: 0, max: 10 }, 1);

  // ---- Case 10: a device that freezes mid-walk — liveness check unanswered → abort ---------
  {
    let sent = 0;
    let liveness = 0;
    const freezing: LiveTransport = {
      request(query) {
        sent += 1;
        const { view, param } = q(query);
        if (sent <= 3 && view === VIEW_DEFINITION) return Promise.resolve(floatDef(param)); // params 0..2
        if (view === VIEW_DEFINITION && param === 2) liveness += 1; // the re-read of the last answered def
        return Promise.resolve(null);
      },
    };
    let error = '';
    try {
      await liveWalkDetailed(freezing, { ...base, blocks: [70, 71], maxParamId: 60, paramAbsentRunLimit: 40, sleep: () => Promise.resolve() });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!/stopped answering/.test(error)) fail(`a device frozen mid-walk must abort it, got ${error || 'no error'}`);
    // 3 answered + 8 table slots x (1 + 2 retries) + 1 liveness re-read of param 2.
    if (sent !== 28 || liveness !== 1) fail(`frozen mid-walk: ${sent} queries, ${liveness} liveness re-reads (want 28 / 1)`);
  }
  console.log('  cache/livewalk-replies: a device frozen mid-walk aborts once the liveness re-read goes unanswered');

  // ---- Case 11: silent ADDRESSES on a live device — absent, walk completes ------------------
  {
    let sent = 0;
    const realIds: Record<number, number> = { 70: 3, 71: 2 }; // block -> params 0..n-1 answer
    const patchy: LiveTransport = {
      request(query) {
        sent += 1;
        const { view, block, param } = q(query);
        if (view === VIEW_DEFINITION && param < (realIds[block] ?? 0)) return Promise.resolve(floatDef(param));
        return Promise.resolve(null); // everything else stays silent
      },
    };
    const res = await liveWalkDetailed(patchy, { ...base, blocks: [70, 71], maxParamId: 60, paramAbsentRunLimit: 20, sleep: () => Promise.resolve() });
    const got = res.records.map((r) => `${r.section}.${r.id}`).join(',');
    if (got !== '70.0,70.1,70.2,71.0,71.1') fail(`silent addresses: records ${got}`);
    // Per block: 8 silent slots retried, ONE liveness re-read, the rest of the 20-slot run
    // one-shot without further checks.
    if (sent !== 3 + 24 + 1 + 12 + (2 + 24 + 1 + 12)) fail(`silent addresses cost ${sent} queries`);
    // Proven-silent addresses are not loss: a consumer must not be told to re-walk.
    if (res.silentAddresses !== 40 || res.unresolvedReplies !== 0 || res.lostReplies !== 0 || res.missingSlots !== 0) {
      fail(`silent addresses booked as loss: ${JSON.stringify({ ...res, records: undefined })}`);
    }
  }
  console.log('  cache/livewalk-replies: addresses that stay silent on a live device count as silent addresses, not loss — the walk completes');

  // ---- Case 12: silence never carries over into the next block -----------------------------
  // Block 70 ends in 6 silent slots, block 71 starts with 3: together over the threshold, but
  // each block is judged on its own — block 71 still retries a dropped definition (param 6).
  {
    let dropped = false;
    const t: LiveTransport = {
      request(query) {
        const { view, block, param } = q(query);
        if (view !== VIEW_DEFINITION) return Promise.resolve(sentinelFrame(view, param));
        if (block === 70 && param <= 2) return Promise.resolve(floatDef(param));
        if (block === 71 && param >= 3 && param <= 6) {
          if (param === 6 && !dropped) {
            dropped = true;
            return Promise.resolve(null);
          }
          return Promise.resolve(floatDef(param));
        }
        return Promise.resolve(null);
      },
    };
    const res = await liveWalkDetailed(t, { ...base, blocks: [70, 71], maxParamId: 40, paramAbsentRunLimit: 6, blockProbeDepth: 8, sleep: () => Promise.resolve() });
    const got = res.records.map((r) => `${r.section}.${r.id}`).join(',');
    if (got !== '70.0,70.1,70.2,71.3,71.4,71.5,71.6') fail(`carry-over: records ${got} (71.6 must be recovered)`);
    if (res.recoveredReplies !== 1) fail(`carry-over: the dropped definition was not retried (${JSON.stringify({ ...res, records: undefined })})`);
    // Block ends that fall silent are proven silent (6 + 6); block 71's 3 leading silent slots
    // were ended by an answer before any proof, so they stay genuine loss (3 unresolved, 3 missing).
    if (res.unresolvedReplies !== 3 || res.missingSlots !== 3 || res.silentAddresses !== 6 + 6 || res.lostReplies !== 1 + 3) {
      fail(`carry-over accounting: ${JSON.stringify({ ...res, records: undefined })}`);
    }
  }
  console.log('  cache/livewalk-replies: silence at a block end does not carry into the next block (its retries still work)');

  // ---- Case 13: a cut-short label list stays visible, whatever the definitions do ---------
  // Block 3, param 0: an enum of 61 labels whose sub 3 never answers (all attempts). The list
  // ends at 3 labels; that must stay counted as loss even when the block's definition silence is
  // proven — (b) the device answers everything but the last definition (param 127), so the block
  // ENDS silent; (c) every other address of the block is silent.
  {
    const labels61 = Array.from({ length: 61 }, (_, i) => `L${i}`);
    const run = async (mode: 'a' | 'b' | 'c') => {
      const t: LiveTransport = {
        request(query) {
          const { view, param, sub } = q(query);
          if (view === VIEW_DEFINITION) {
            if (param === 0) return Promise.resolve(defFrame(0, { kind: 'enum', min: 0, max: 60 }, 0));
            if (mode === 'c' || (mode === 'b' && param === 127)) return Promise.resolve(null);
            return Promise.resolve(replyFrame(VIEW_DEFINITION, param, 0x3a, new Uint8Array(36))); // empty slot
          }
          if (view === VIEW_ENUM_LABEL) {
            if (sub === 3) return Promise.resolve(null);
            return Promise.resolve(sub < 61 ? labelReply(labels61[sub]!, param) : endOfRangeFrame(VIEW_ENUM_LABEL, param));
          }
          return Promise.resolve(sentinelFrame(view, param));
        },
      };
      return liveWalkDetailed(t, { model: FM3, blocks: [3], maxParamId: 127, readValues: false, sleep: () => Promise.resolve() });
    };
    for (const [mode, silent] of [['a', 0], ['b', 1], ['c', 127]] as const) {
      const res = await run(mode);
      const got = (res.records[0] as EnumRecord | undefined)?.values.length;
      if (got !== 3) fail(`(${mode}) roster length ${got} (want the cut-short 3)`);
      if (res.unresolvedReplies !== 1 || res.silentAddresses !== silent || res.missingSlots !== 0) {
        fail(`(${mode}) the cut-short roster must stay visible: ${JSON.stringify({ ...res, records: undefined })}`);
      }
    }
  }
  console.log('  cache/livewalk-replies: a cut-short label list stays counted as loss, also when the definition silence of its block is proven');

  // ---- Case 14: a freeze AFTER proven silence is still noticed -----------------------------
  {
    let sent = 0;
    let reReads = 0;
    const t: LiveTransport = {
      request(query) {
        sent += 1;
        const { view, block, param } = q(query);
        if (view !== VIEW_DEFINITION || block !== 70) return Promise.resolve(null);
        if (param <= 2 && sent <= 3) return Promise.resolve(floatDef(param));
        if (param === 2 && ++reReads === 1) return Promise.resolve(floatDef(2)); // the proof answers, then the device freezes
        return Promise.resolve(null);
      },
    };
    let error = '';
    try {
      await liveWalkDetailed(t, { ...base, blocks: [70], maxParamId: 200, paramAbsentRunLimit: 150, sleep: () => Promise.resolve() });
    } catch (e) {
      error = (e as Error).message;
    }
    if (!/stopped answering/.test(error)) fail(`a freeze after proven silence must abort, got ${error || 'no error'}`);
    // 3 answered + 8 silent x 3 + proof + 32 one-shot silent + 1 unanswered re-read.
    if (sent !== 3 + 24 + 1 + 32 + 1) fail(`freeze after proof: ${sent} queries`);
  }
  console.log('  cache/livewalk-replies: a device that freezes after a block’s silence was proven is still noticed (re-read every 32)');
}
