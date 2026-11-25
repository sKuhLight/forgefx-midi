/**
 * Gen-3 poll timing facts: quantum, effective period, in-flight cap, reply
 * timeout, and the measured per-key tiers.
 */
import {
  POLL_QUANTUM_MS,
  MIN_FRAME_GAP_MS,
  MAX_REQUESTS_IN_FLIGHT,
  REPLY_TIMEOUT_MS,
  pollPeriodMs,
  GEN3_POLL_TIERS,
  gen3PollTier,
} from '../../src/shared/pollTiming.js';

function fail(msg: string): never {
  throw new Error(`[shared/pollTiming] ${msg}`);
}

export const SHARED_POLLTIMING_CASE_COUNT = 5;

export function runSharedPollTimingTests(): void {
  // 1 - clock and safety limits are separate facts.
  if (POLL_QUANTUM_MS !== 33) fail(`quantum ${POLL_QUANTUM_MS}`);
  if (MIN_FRAME_GAP_MS !== 3) fail(`frame gap ${MIN_FRAME_GAP_MS}`);
  if (MAX_REQUESTS_IN_FLIGHT !== 50) fail(`in-flight cap ${MAX_REQUESTS_IN_FLIGHT}`);
  if (REPLY_TIMEOUT_MS !== 3000) fail(`reply timeout ${REPLY_TIMEOUT_MS}`);
  if (REPLY_TIMEOUT_MS === POLL_QUANTUM_MS) fail('reply timeout is not independent of the period');

  // 2 - period = ceil(interval / 33) * 33.
  const cases: Array<[number, number]> = [
    [1, 33],
    [32, 33],
    [33, 33],
    [34, 66],
    [66, 66],
    [67, 99],
    [100, 132],
    [628, 660],
    [3000, 3003],
  ];
  for (const [interval, expected] of cases) {
    if (pollPeriodMs(interval) !== expected) fail(`pollPeriodMs(${interval}) = ${pollPeriodMs(interval)}, expected ${expected}`);
  }
  if (pollPeriodMs(0) !== POLL_QUANTUM_MS) fail('non-positive interval did not fall back to one quantum');

  // 3 - the measured per-key tiers, as quanta.
  const quanta = GEN3_POLL_TIERS.map((t) => t.quanta);
  if (quanta.join(',') !== '2,4,19,92,15,23') fail(`tier quanta ${quanta.join(',')}`);
  const measured = GEN3_POLL_TIERS.map((t) => t.measuredMs);
  if (measured.join(',') !== '66,132,628,3040,495,759') fail(`tier measured periods ${measured.join(',')}`);

  // 4 - tier keys are unique and resolvable.
  const keys = new Set(GEN3_POLL_TIERS.map((t) => t.key));
  if (keys.size !== GEN3_POLL_TIERS.length) fail('duplicate tier key');
  const page = gen3PollTier('page-monitor');
  if (!page || page.quanta !== 2) fail('page-monitor tier missing');
  if (gen3PollTier('nope') !== undefined) fail('unknown tier key resolved');

  // 5 - a tier's clock period is its quanta exactly (the measured median may differ
  //     by rounding; the scheduler uses the quantum period).
  for (const tier of GEN3_POLL_TIERS) {
    if (pollPeriodMs(tier.quanta * POLL_QUANTUM_MS) !== tier.quanta * POLL_QUANTUM_MS) {
      fail(`tier ${tier.key} quanta do not round-trip`);
    }
    if (Math.abs(tier.measuredMs - tier.quanta * POLL_QUANTUM_MS) > POLL_QUANTUM_MS) {
      fail(`tier ${tier.key} measured ${tier.measuredMs} is more than one quantum from ${tier.quanta}`);
    }
  }
}
