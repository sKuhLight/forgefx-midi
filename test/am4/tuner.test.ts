// AM4 tuner decode. The four frames are REAL captures from BigCapture 2026-07-05
// (block 0x0023, action 0x0010), from the same tuning moment: A0 detected at
// 28.108 Hz, +37.9 cents (28.108 Hz is 37.9 cents sharp of A0 = 27.5 Hz),
// string band 5. See docs/AM4-B2-AUDIO-CORRELATION.md and src/am4/tuner.ts.

import { decodeAm4PollResponse } from '../../src/am4/liveDecode.js';
import { decodeAm4Tuner, am4TunerNoteName, isAm4TunerChannel, AM4_TUNER_CHANNEL } from '../../src/am4/tuner.js';

function h(hex: string): number[] {
  return hex.trim().split(/\s+/).map((b) => Number.parseInt(b, 16));
}

const FRAMES = {
  noteIndex: 'F0 00 01 74 15 01 23 00 01 00 10 00 00 00 04 00 00 00 08 04 08 23 F7',
  freqHz: 'F0 00 01 74 15 01 23 00 02 00 10 00 00 00 04 00 2F 37 3C 04 08 0C F7',
  cents: 'F0 00 01 74 15 01 23 00 03 00 10 00 00 00 04 00 2A 1D 22 74 10 54 F7',
  stringBand: 'F0 00 01 74 15 01 23 00 04 00 10 00 00 00 04 00 00 00 14 04 00 32 F7',
};

export const AM4_TUNER_CASE_COUNT = 7;

export function runAm4TunerTests(): void {
  const failed: string[] = [];

  // Decode each channel off the real wire via the shipped codec.
  const ch = {
    noteIndex: decodeAm4PollResponse(h(FRAMES.noteIndex)),
    freqHz: decodeAm4PollResponse(h(FRAMES.freqHz)),
    cents: decodeAm4PollResponse(h(FRAMES.cents)),
    stringBand: decodeAm4PollResponse(h(FRAMES.stringBand)),
  };

  // 1. Addresses resolve to the decoded tuner candidates.
  if (ch.freqHz.candidate?.name !== 'tuner.freq_hz') failed.push(`freq candidate: ${ch.freqHz.candidate?.name}`);
  if (ch.freqHz.candidate?.confidence !== 'capture-decoded-value') failed.push('freq confidence should be capture-decoded-value');
  if (!isAm4TunerChannel(0x0023, AM4_TUNER_CHANNEL.CENTS)) failed.push('isAm4TunerChannel missed cents channel');
  if (isAm4TunerChannel(0x0025, 0x0010)) failed.push('isAm4TunerChannel false-matched a non-tuner address');

  // 2. Compose the reading from the four absolute float32 values.
  const t = decodeAm4Tuner({
    noteIndex: ch.noteIndex.rawFloat,
    freqHz: ch.freqHz.rawFloat,
    cents: ch.cents.rawFloat,
    stringBand: ch.stringBand.rawFloat,
  });
  if (t.noteName !== 'A0') failed.push(`noteName: expected A0, got ${t.noteName}`);
  if (t.midiNote !== 21) failed.push(`midiNote: expected 21, got ${t.midiNote}`);
  if (Math.abs(t.freqHz - 28.108) > 0.01) failed.push(`freqHz: expected ~28.108, got ${t.freqHz}`);
  if (Math.abs(t.cents - 37.86) > 0.1) failed.push(`cents: expected ~37.86, got ${t.cents}`);
  if (t.stringBand !== 5) failed.push(`stringBand: expected 5, got ${t.stringBand}`);
  if (t.inTune) failed.push('inTune should be false at +37.9 cents');

  // 3. Independent cross-check: cents == 1200·log2(freq / nearestNoteFreq).
  const nearestNoteFreq = 440 * Math.pow(2, (t.midiNote - 69) / 12);
  const centsFromFreq = 1200 * Math.log2(t.freqHz / nearestNoteFreq);
  if (Math.abs(centsFromFreq - t.cents) > 1.0) {
    failed.push(`cents mismatch: channel ${t.cents.toFixed(2)} vs freq-derived ${centsFromFreq.toFixed(2)}`);
  }

  // 4. Note-name math anchor: index 60 → MIDI 69 → A4.
  if (am4TunerNoteName(60) !== 'A4') failed.push(`am4TunerNoteName(60): expected A4, got ${am4TunerNoteName(60)}`);

  if (failed.length > 0) {
    throw new Error(`[am4/tuner] ${failed.length} failure(s):\n` + failed.join('\n'));
  }
}
