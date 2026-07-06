/**
 * AM4 live-poll candidates from BigCapture 2026-07-05.
 *
 * AM4-Edit did not expose a separate telemetry function in this capture.
 * It polls ordinary PARAM_RW addresses, mainly with action=0x0010. This
 * table names the addresses that correlate with the ordered capture plan
 * without claiming value scaling where the capture does not yet prove it.
 */

import type { ParamKey } from './params.js';

export type Am4LivePollConfidence =
  | 'capture-confirmed-address'
  | 'capture-correlated-candidate';

export interface Am4LivePollCandidate {
  /** Stable label for diagnostics and documentation. */
  name: string;
  pidLow: number;
  pidHigh: number;
  /** PARAM_RW action codes seen for this address in the capture. */
  observedActions: readonly number[];
  confidence: Am4LivePollConfidence;
  /** Existing catalog param when the address is already public. */
  paramKey?: ParamKey;
  /** Capture-plan phase that made this address identifiable. */
  planPhase: string;
  notes: string;
}

export const AM4_LIVE_POLL_CANDIDATES: readonly Am4LivePollCandidate[] = [
  {
    name: 'ingate.gain_monitor',
    pidLow: 0x0025,
    pidHigh: 0x0010,
    observedActions: [0x0010],
    confidence: 'capture-confirmed-address',
    paramKey: 'ingate.gain_monitor',
    planPhase: 'Meters / Input Gate',
    notes: 'Known catalog monitor address; activity returns in the input-gate meter window.',
  },
  {
    name: 'compressor.gain_monitor',
    pidLow: 0x002e,
    pidHigh: 0x001f,
    observedActions: [0x0010],
    confidence: 'capture-confirmed-address',
    paramKey: 'compressor.gain_monitor',
    planPhase: 'Meters / Compressor',
    notes: 'Known catalog monitor address; dominant variable poll in the compressor meter window.',
  },
  {
    name: 'wah.wah_control',
    pidLow: 0x005e,
    pidHigh: 0x000f,
    observedActions: [0x0026],
    confidence: 'capture-confirmed-address',
    paramKey: 'wah.wah_control',
    planPhase: 'Expression / Modifier',
    notes: 'Known catalog control address; repeatedly polled during the wah/modifier phase.',
  },
  {
    name: 'tuner.live_channel_1',
    pidLow: 0x0023,
    pidHigh: 0x0001,
    observedActions: [0x0010],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Tempo / Tuner',
    notes: 'Tuner-phase cluster; channel meaning and value scaling still unknown.',
  },
  {
    name: 'tuner.live_channel_2',
    pidLow: 0x0023,
    pidHigh: 0x0002,
    observedActions: [0x0010],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Tempo / Tuner',
    notes: 'Tuner-phase cluster; channel meaning and value scaling still unknown.',
  },
  {
    name: 'tuner.live_channel_3',
    pidLow: 0x0023,
    pidHigh: 0x0003,
    observedActions: [0x0010],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Tempo / Tuner',
    notes: 'Tuner-phase cluster; channel meaning and value scaling still unknown.',
  },
  {
    name: 'tuner.live_channel_4',
    pidLow: 0x0023,
    pidHigh: 0x0004,
    observedActions: [0x0010],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Tempo / Tuner',
    notes: 'Tuner-phase cluster; channel meaning and value scaling still unknown.',
  },
  {
    name: 'main_output.live_channel_1',
    pidLow: 0x002a,
    pidHigh: 0x0016,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Meters / Main or Home',
    notes: 'Preset/Main Levels family; appears in the main/home meter window before known scene-level params.',
  },
  {
    name: 'main_output.live_channel_2',
    pidLow: 0x002a,
    pidHigh: 0x0017,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Meters / Main or Home',
    notes: 'Preset/Main Levels family; appears in the main/home meter window before known scene-level params.',
  },
  {
    name: 'volpan.auto_swell_monitor_candidate',
    pidLow: 0x0066,
    pidHigh: 0x0014,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Meters / Volume-Pan',
    notes: 'Adjacent to known Auto-Swell release/hysteresis addresses; meaning and scaling still unknown.',
  },
];

export function am4LivePollCandidateFor(pidLow: number, pidHigh: number): Am4LivePollCandidate | undefined {
  return AM4_LIVE_POLL_CANDIDATES.find((candidate) => candidate.pidLow === pidLow && candidate.pidHigh === pidHigh);
}
