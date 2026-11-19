/**
 * A fake gen-3 device serving a decoded cache walk through the self-describe protocol — the ONE
 * device model the live-walk suites share.
 *
 * Device behaviour modelled (an assumption — see "Reply assumptions (open hardware questions)" in
 * `src/cache/liveWalk.ts`, questions 1-3 and 5):
 *   - every definition query is answered: a real row with its definition, an EMPTY row, an id the
 *     table does not define (a gap) and everything past the end of the table with the empty-slot
 *     definition (typecode 0, all-zero body);
 *   - enum labels live at their raw-value sub (values[i] at sub = min + i); a sub below min answers
 *     a label outside the list; past the end answers the no-payload reply (cnt 0, tag 0x40);
 *   - the formatted-value view answers a sentinel (no unit).
 * `silent: true` instead leaves every address without a real row UNANSWERED (`null`) — the
 * opposite assumption, used to prove the walk still completes if a device stays silent there.
 *
 * Every query (and, via `sleep`, every pause) is appended to `trace` so a suite can pin the exact
 * traffic a walk sends. Test-only; synthetic frames from the shared encoders.
 */
import type { LiveTransport } from '../../src/cache/index.js';
import { VIEW_DEFINITION, VIEW_ENUM_LABEL } from '../../src/cache/index.js';
import type { CacheRecord } from '../../src/cache/types.js';
import { definitionBlockScaled, endOfRangeFrame, labelReply, replyFrame, sentinelFrame } from './livewalk.test.js';

export const isEmptyRow = (r: CacheRecord): boolean => r.tc === 0 && r.min === 0 && r.max === 0 && r.def === 0 && r.step === 0;

/** The empty-slot definition: typecode 0, all-zero body (`symbolId` for the high-region form). */
export function emptySlotFrame(param: number, symbolId = 0): Uint8Array {
  const body = new Uint8Array(36);
  new DataView(body.buffer).setUint32(0, symbolId, true);
  return replyFrame(VIEW_DEFINITION, param, 0x3a, body);
}

export interface CacheDevice extends LiveTransport {
  /** Hex of every query sent, interleaved with `sleep:<ms>` for every pause (via `sleep`). */
  readonly trace: string[];
  /** Scheduler seam that records pauses into `trace` without waiting. */
  readonly sleep: (ms: number) => Promise<void>;
}

export function cacheDevice(records: readonly CacheRecord[], opts: { silent?: boolean } = {}): CacheDevice {
  const byKey = new Map<string, CacheRecord>();
  for (const r of records) if (r.id < 0xff00) byKey.set(`${r.section}:${r.id}`, r);
  const trace: string[] = [];
  return {
    trace,
    sleep: (ms: number) => {
      trace.push(`sleep:${ms}`);
      return Promise.resolve();
    },
    request(query: Uint8Array): Promise<Uint8Array | null> {
      trace.push(Array.from(query, (b) => b.toString(16).padStart(2, '0')).join(''));
      const view = query[6]!;
      const block = query[8]! | (query[9]! << 7);
      const param = query[10]! | (query[11]! << 7);
      const sub = query[12]! | (query[13]! << 7);
      const r = byKey.get(`${block}:${param}`);
      const real = r !== undefined && !isEmptyRow(r);
      if (view === VIEW_DEFINITION) {
        if (real) return Promise.resolve(replyFrame(VIEW_DEFINITION, param, 0x3a, definitionBlockScaled(r!, r!.kind === 'enum' ? 0 : 1)));
        return Promise.resolve(opts.silent && !r ? null : emptySlotFrame(param));
      }
      if (view === VIEW_ENUM_LABEL) {
        if (real && r!.kind === 'enum') {
          const lo = Math.round(r!.min);
          const idx = sub - lo;
          if (idx >= 0 && idx < r!.values.length) return Promise.resolve(labelReply(r!.values[idx]!, param));
          if (sub < lo) return Promise.resolve(labelReply(`(below-min ${sub})`, param));
        }
        return Promise.resolve(endOfRangeFrame(VIEW_ENUM_LABEL, param));
      }
      return Promise.resolve(sentinelFrame(view, param));
    },
  };
}
