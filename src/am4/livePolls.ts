/**
 * AM4 live-poll candidates (hardware-observed, 2026-07-05).
 *
 * AM4-Edit does not use a separate telemetry function. It polls ordinary
 * PARAM_RW addresses, mainly with action=0x0010. This table names the
 * addresses that correlate with editor activity without claiming value
 * scaling where it is not yet proven. See docs/AM4-LIVE-POLLS.md.
 */

import type { ParamKey } from './params.js';

export type Am4LivePollConfidence =
  /** Value semantics + scaling proven from capture (tuner channels). */
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
  /** Editor activity phase that made this address identifiable. */
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
    notes: 'Not assigned. Active across the whole session, not compressor-exclusive as first guessed — spans baseline through the volume/pan activity. Float32 range [-0.24, 0.68] (can go negative, unlike gain_monitor\'s [0,1]) — not a simple normalized meter. Semantics still open.',
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
  // Tuner readout (wire block 0x23). All four channels are DECODED — see
  // docs/AM4-LIVE-POLLS.md and tuner.ts.
  // NB: these are ABSOLUTE float32 engineering values, NOT the [0,1]/×scale
  // treatment used for meters. (The cache blockTag 0x23 is the modifier/control
  // block — the blockTag≠pidLow trap; the value ranges — 23–382 Hz, ±48 cents —
  // refute a 0..10 knob.)
  {
    name: 'tuner.note_index',
    pidLow: 0x0023,
    pidHigh: 0x0001,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'Nearest-note index; MIDI note = value + 9. Decoded: matches note(freq) in 99% of samples.',
  },
  {
    name: 'tuner.freq_hz',
    pidLow: 0x0023,
    pidHigh: 0x0002,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'Detected fundamental in Hz (absolute float32, ~23–382 observed). Decoded.',
  },
  {
    name: 'tuner.cents',
    pidLow: 0x0023,
    pidHigh: 0x0003,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'Signed cents deviation (±50). Decoded: equals 1200·log2(freq/nearestNoteFreq), r=0.87.',
  },
  {
    name: 'tuner.string_band',
    pidLow: 0x0023,
    pidHigh: 0x0004,
    observedActions: [0x0010],
    confidence: 'capture-decoded-value',
    planPhase: 'Tempo / Tuner',
    notes: 'String/octave band index 0–5. Decoded; literal per-index label still TBD.',
  },
  {
    name: 'main_output.level_l',
    pidLow: 0x002a,
    pidHigh: 0x0016,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-confirmed-address',
    planPhase: 'Meters / Main or Home',
    notes: 'Main output level meter, LEFT. Normalized float32 [0,1] (L/R correlate r=0.999). dB reference not yet pinned.',
  },
  {
    name: 'main_output.level_r',
    pidLow: 0x002a,
    pidHigh: 0x0017,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-confirmed-address',
    planPhase: 'Meters / Main or Home',
    notes: 'Main output level meter, RIGHT. Normalized float32 [0,1]. dB reference not yet pinned.',
  },
  {
    name: 'volpan.meter_candidate',
    pidLow: 0x0066,
    pidHigh: 0x0014,
    observedActions: [0x0010, 0x0026],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Meters / Volume-Pan',
    notes: 'Resolver-pinned cache_id 20 = VOLUME_METER. Only ~12 discrete values, mostly zero — a discrete state/position indicator, not a continuous meter. Semantics still TBD.',
  },
  // Expression/Modifier readouts (pidLow 0x0003/0x001c and 0x0002/0x0056) —
  // see docs/AM4-LIVE-POLLS.md. Block-navigation markers (action=0x0017,
  // pidHigh=0x3e81) pin pidLow 0x0003 = "Modifier 1" slot, opened at the same
  // moment this address starts polling.
  {
    name: 'modifier.slot1_live_value',
    pidLow: 0x0003,
    pidHigh: 0x001c,
    observedActions: [0x0010],
    confidence: 'capture-confirmed-address',
    planPhase: 'Expression / Modifier',
    notes: 'Live output of the Modifier 1 slot. Normalized float32 [0,1] (full-range sweep, 262 unique values), continuous while the modifier is swept — shape matches a pedal heel/half/toe sweep. dB/knob-unit mapping not pinned; depends on whatever the modifier is assigned to.',
  },
  {
    name: 'modifier.slot2_or_envelope_candidate',
    pidLow: 0x0002,
    pidHigh: 0x0056,
    observedActions: [0x0010],
    confidence: 'capture-correlated-candidate',
    planPhase: 'Expression / Modifier',
    notes: 'Narrow window right after a pedal sweep, float32 in [0,0.03] with only ~20 values — too small/quantised to be the pedal readout again. Coincides with selecting External 1 / Envelope as modifier sources; likely an envelope-follower or second modifier-slot live value. Semantics unpinned.',
  },
];

export function am4LivePollCandidateFor(pidLow: number, pidHigh: number): Am4LivePollCandidate | undefined {
  return AM4_LIVE_POLL_CANDIDATES.find((candidate) => candidate.pidLow === pidLow && candidate.pidHigh === pidHigh);
}
