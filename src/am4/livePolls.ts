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
  /** Value semantics + scaling proven from capture (B2 audio-correlation). */
  | 'capture-decoded-value'
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
    name: 'compressor.unassigned_monitor',
    pidLow: 0x002e,
    pidHigh: 0x0022,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Meters / Compressor (tentative)',
    notes: 'Flagged unassigned in the 2026-07-05 capture doc. B3: active across 63-933s, not compressor-exclusive as first guessed — spans baseline through volpan windows. Float32 range [-0.24, 0.68] (can go negative, unlike gain_monitor\'s [0,1]) — not a simple normalized meter. Semantics still open.',
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
  // Tuner readout (wire block 0x23). B2 audio-correlation (2026-07-06) DECODED
  // all four channels — see docs/AM4-B2-AUDIO-CORRELATION.md and tuner.ts.
  // NB: these are ABSOLUTE float32 engineering values, NOT the [0,1]/×scale
  // treatment used for meters. (B1's cache-blockTag guess that 0x23 was the
  // "modifier/control" block was the blockTag≠pidLow trap; the value ranges —
  // 23–382 Hz, ±48 cents — refute a 0..10 knob.)
  {
    name: 'tuner.note_index',
    pidLow: 0x0023,
    pidHigh: 0x0001,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'Nearest-note index; MIDI note = value + 9. Decoded (B2): matches note(freq) in 99% of samples.',
  },
  {
    name: 'tuner.freq_hz',
    pidLow: 0x0023,
    pidHigh: 0x0002,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'Detected fundamental in Hz (absolute float32, ~23–382 in capture). Decoded (B2).',
  },
  {
    name: 'tuner.cents',
    pidLow: 0x0023,
    pidHigh: 0x0003,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'Signed cents deviation (±50). Decoded (B2): equals 1200·log2(freq/nearestNoteFreq), r=0.87.',
  },
  {
    name: 'tuner.string_band',
    pidLow: 0x0023,
    pidHigh: 0x0004,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'String/octave band index 0–5. Decoded (B2); literal per-index label still TBD.',
  },
  {
    name: 'main_output.level_l',
    pidLow: 0x002a,
    pidHigh: 0x0016,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-confirmed-address',
    planPhase: 'Meters / Main or Home',
    notes: 'Main output level meter, LEFT. Normalized float32 [0,1] (B2: L/R correlate r=0.999). dB reference not yet pinned.',
  },
  {
    name: 'main_output.level_r',
    pidLow: 0x002a,
    pidHigh: 0x0017,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-confirmed-address',
    planPhase: 'Meters / Main or Home',
    notes: 'Main output level meter, RIGHT. Normalized float32 [0,1] (B2). dB reference not yet pinned.',
  },
  {
    name: 'volpan.meter_candidate',
    pidLow: 0x0066,
    pidHigh: 0x0014,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Meters / Volume-Pan',
    notes: 'Resolver-pinned cache_id 20 = VOLUME_METER (B1). B2: only ~12 discrete values, mostly zero — a discrete state/position indicator, not a continuous meter. Semantics still TBD.',
  },
  // Expression/Modifier stragglers from the 2026-07-05 correlation table
  // (pidLow 0x0003/0x001c and 0x0002/0x0056), resolved in the 2026-07-08 B3
  // pass — see docs/AM4-B3-REMAINING-WINDOWS.md. Block-navigation markers
  // (action=0x0017, pidHigh=0x3e81) pin pidLow 0x0003 = "Modifier 1" slot,
  // opened at the same timestamp this address starts polling.
  {
    name: 'modifier.slot1_live_value',
    pidLow: 0x0003,
    pidHigh: 0x001c,
    observedActions: [0x0010],
    confidence: 'capture-confirmed-address',
    planPhase: 'Expression / Modifier',
    notes: 'Live output of the Modifier 1 slot. Normalized float32 [0,1] (B3: full-range sweep, 262 unique values over 2564 samples), continuous for the whole 1253-1530s modifier test window — shape matches the pedal heel/half/toe sweep in the plan. dB/knob-unit mapping not pinned; depends on whatever the modifier is assigned to.',
  },
  {
    name: 'modifier.slot2_or_envelope_candidate',
    pidLow: 0x0002,
    pidHigh: 0x0056,
    observedActions: [0x0010],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Expression / Modifier',
    notes: 'B3: narrow 1315-1338s sub-window (right after the pedal sweep), float32 in [0,0.03] with only ~20 values — too small/quantised to be the pedal readout again. Coincides with the plan’s "try External 1 / Envelope as sources" step; likely an envelope-follower or second modifier-slot live value. Semantics unpinned.',
  },
];

export function am4LivePollCandidateFor(pidLow: number, pidHigh: number): Am4LivePollCandidate | undefined {
  return AM4_LIVE_POLL_CANDIDATES.find((candidate) => candidate.pidLow === pidLow && candidate.pidHigh === pidHigh);
}
