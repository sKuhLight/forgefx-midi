/**
 * AM4 tuner readout — live-poll block `0x0023`.
 *
 * DECODED and verified from BigCapture 2026-07-05 (B2 audio-correlation; see
 * docs/AM4-B2-AUDIO-CORRELATION.md). AM4-Edit's tuner is driven by four
 * `fn 0x01 PARAM_RW action=0x0010` polls of block `0x0023`. Unlike the meter
 * monitors, these payloads are **absolute float32 engineering values**, NOT the
 * normalized `[0,1]` a knob/meter uses — do not run them through `decode()`.
 *
 * | pidHigh | channel      | meaning                                           |
 * |---------|--------------|---------------------------------------------------|
 * | 0x0001  | note index   | nearest-note index; `MIDI note = value + 9`       |
 * | 0x0002  | frequency    | detected fundamental, Hz                          |
 * | 0x0003  | cents        | signed deviation from the nearest note, ±50       |
 * | 0x0004  | string band  | string / octave band index 0–5                    |
 *
 * Self-consistency proven on real capture data: `note(freq)` equals the note
 * index in 99% of samples, and `cents ≈ 1200·log2(freq / nearestNoteFreq)`
 * (matched the observed value to ~0.1 cent on spot checks).
 *
 * Pure code — no MIDI transport. Browser-safe.
 */

/** Wire block id (pidLow) of the AM4 tuner readout. */
export const AM4_TUNER_PID_LOW = 0x0023;

/** Per-channel pidHigh addresses within the tuner block. */
export const AM4_TUNER_CHANNEL = {
  NOTE_INDEX: 0x0001,
  FREQ_HZ: 0x0002,
  CENTS: 0x0003,
  STRING_BAND: 0x0004,
} as const;

/** True if `(pidLow, pidHigh)` is one of the four tuner channels. */
export function isAm4TunerChannel(pidLow: number, pidHigh: number): boolean {
  return (
    pidLow === AM4_TUNER_PID_LOW &&
    pidHigh >= AM4_TUNER_CHANNEL.NOTE_INDEX &&
    pidHigh <= AM4_TUNER_CHANNEL.STRING_BAND
  );
}

/** Offset from the AM4 tuner note-index to a standard MIDI note number. */
export const AM4_TUNER_MIDI_OFFSET = 9;

// Standard note names, indexed by (MIDI % 12) with 0 = C.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/**
 * Render a note name (e.g. `"D#1"`, `"A4"`) from an AM4 tuner note index
 * (channel 0x0001). `MIDI = index + AM4_TUNER_MIDI_OFFSET`; octave numbering
 * follows the convention MIDI 60 = C4.
 */
export function am4TunerNoteName(noteIndex: number): string {
  const midi = Math.round(noteIndex) + AM4_TUNER_MIDI_OFFSET;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export interface Am4TunerReading {
  /** Raw nearest-note index (channel 0x0001). */
  noteIndex: number;
  /** Standard MIDI note number (`noteIndex + 9`). */
  midiNote: number;
  /** Rendered note name, e.g. `"D#1"`. */
  noteName: string;
  /** Detected fundamental frequency in Hz (channel 0x0002). */
  freqHz: number;
  /** Signed cents deviation from the nearest note (channel 0x0003). */
  cents: number;
  /** String / octave band index 0–5 (channel 0x0004). */
  stringBand: number;
  /** True when |cents| ≤ tolerance (default 3 cents) — i.e. "in tune". */
  inTune: boolean;
}

/**
 * Compose a full tuner reading from the four channel float32 values (each the
 * `asFloat32()` of its poll response). `inTuneCents` is the ± tolerance used to
 * set `inTune` (default 3 cents).
 */
export function decodeAm4Tuner(
  channels: { noteIndex: number; freqHz: number; cents: number; stringBand: number },
  inTuneCents = 3,
): Am4TunerReading {
  const noteIndex = Math.round(channels.noteIndex);
  const midiNote = noteIndex + AM4_TUNER_MIDI_OFFSET;
  return {
    noteIndex,
    midiNote,
    noteName: am4TunerNoteName(noteIndex),
    freqHz: channels.freqHz,
    cents: channels.cents,
    stringBand: Math.round(channels.stringBand),
    inTune: Math.abs(channels.cents) <= inTuneCents,
  };
}
