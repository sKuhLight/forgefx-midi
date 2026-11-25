/**
 * Gen-3 poll timing facts shared by the scheduler and the visual providers.
 *
 * The reference editors have no per-feature poll timers. One 33 ms clock ticks
 * the whole app; each poll key is gated by a tier interval expressed as a
 * number of those ticks, and the effective period is `ceil(interval / 33) * 33`
 * milliseconds. The per-tier tick counts below are the measured values — treat
 * them as quanta, not as exact millisecond timers.
 *
 * Two limits ride on the same clock: a page may have at most 50 requests
 * pending, and a request's reply timeout is a separate per-function value
 * (default 3000 ms). The timeout is not the poll period.
 *
 * Browser-safe: plain data and arithmetic, no Node imports.
 */

/** Tick of the editor's poll clock. */
export const POLL_QUANTUM_MS = 33;

/** Minimum spacing between two requests on the link. */
export const MIN_FRAME_GAP_MS = 3;

/** Maximum requests a page keeps pending at once. */
export const MAX_REQUESTS_IN_FLIGHT = 50;

/** Default reply timeout, independent of any poll period. */
export const REPLY_TIMEOUT_MS = 3000;

/**
 * Effective poll period for a tier interval: the interval rounded up to whole
 * clock ticks.
 */
export function pollPeriodMs(intervalMs: number): number {
  if (!(intervalMs > 0)) return POLL_QUANTUM_MS;
  return Math.ceil(intervalMs / POLL_QUANTUM_MS) * POLL_QUANTUM_MS;
}

/** One observed poll tier. */
export interface Gen3PollTier {
  /** Stable key for scheduler wiring. */
  key: string;
  /** Scheduler interval in clock ticks (measured). */
  quanta: number;
  /** Median period observed on the wire, in ms (measured). */
  measuredMs: number;
  /** What the tier polls. */
  role: string;
}

/**
 * Per-key poll tiers. `quanta` and `measuredMs` are measured values; the two
 * do not always multiply exactly because the measured median is the rounded
 * on-wire period, not the clock arithmetic.
 */
export const GEN3_POLL_TIERS: readonly Gen3PollTier[] = [
  { key: 'page-monitor', quanta: 2, measuredMs: 66, role: 'open-page meters (sub 0x19) and graph state (sub 0x22)' },
  { key: 'block-state', quanta: 4, measuredMs: 132, role: 'per-block state (sub 0x03, high byte 0x01)' },
  { key: 'aux-state', quanta: 19, measuredMs: 628, role: 'per-control state (sub 0x39)' },
  { key: 'slow-read', quanta: 92, measuredMs: 3040, role: 'slow/auxiliary block reads' },
  { key: 'eid-sweep', quanta: 15, measuredMs: 495, role: 'per-effect-id value sweep (sub 0x01)' },
  { key: 'grid', quanta: 23, measuredMs: 759, role: 'grid layout blob (sub 0x2E)' },
];

/** Tier by key, or undefined. */
export function gen3PollTier(key: string): Gen3PollTier | undefined {
  return GEN3_POLL_TIERS.find((t) => t.key === key);
}
