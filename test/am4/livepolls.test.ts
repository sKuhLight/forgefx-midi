import {
  AM4_LIVE_POLL_CANDIDATES,
  KNOWN_PARAMS,
  am4LivePollCandidateFor,
} from '../../src/am4/index.js';

export const AM4_LIVE_POLL_CASE_COUNT = AM4_LIVE_POLL_CANDIDATES.length;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function runAm4LivePollTests(): void {
  assert(AM4_LIVE_POLL_CANDIDATES.length >= 10, '[am4/livePolls] expected BigCapture candidates');

  for (const candidate of AM4_LIVE_POLL_CANDIDATES) {
    const resolved = am4LivePollCandidateFor(candidate.pidLow, candidate.pidHigh);
    assert(resolved === candidate, `[am4/livePolls] lookup failed for ${candidate.name}`);
    assert(candidate.observedActions.length > 0, `[am4/livePolls] ${candidate.name} missing observed actions`);

    if (candidate.paramKey) {
      const param = KNOWN_PARAMS[candidate.paramKey];
      assert(Boolean(param), `[am4/livePolls] ${candidate.paramKey} missing from KNOWN_PARAMS`);
      assert(
        param.pidLow === candidate.pidLow && param.pidHigh === candidate.pidHigh,
        `[am4/livePolls] ${candidate.name} address drifted from KNOWN_PARAMS`,
      );
    }
  }

  assert(
    am4LivePollCandidateFor(0x0025, 0x0010)?.name === 'ingate.gain_monitor',
    '[am4/livePolls] input gate gain monitor lookup mismatch',
  );
  assert(
    am4LivePollCandidateFor(0x0023, 0x0004)?.confidence === 'capture-correlated-candidate',
    '[am4/livePolls] tuner candidate confidence mismatch',
  );
}
