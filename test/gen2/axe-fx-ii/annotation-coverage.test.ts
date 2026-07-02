/**
 * Axe-Fx II annotation-coverage golden.
 *
 * Locks the 67 catalog-symbol + display-label annotations added to
 * params.ts. Each row's parameterName was anchored to the SeekParamTablesII
 * Ghidra catalog at the SHIPPING paramId, and each xmlLabel is the verbatim
 * AxeEdit __block_layout label. This test guards three invariants:
 *
 *   1. Wire address unchanged: paramId is exactly the shipping value (the
 *      annotation must never move a wire address).
 *   2. parameterName matches the decoded catalog symbol.
 *   3. xmlLabel matches the verbatim catalog label (including embedded "\n"),
 *      and the two pitch voice-delay params carry NO xmlLabel (their "Delay 1"
 *      / "Delay 2" label is shared with PITCH_TIME1/2, so it was withheld).
 *   4. controlType is correct: 17 continuous controls upgraded "unknown" ->
 *      "knob"; the 11 dropdowns stay "select"; none remain "unknown".
 *
 * Self-contained (no samples/ dependency) so it runs in CI. Regenerate the
 * expectation table with scripts/_research/validate-ii-annotation-coverage.ts
 * if the source catalogs change.
 */
import { KNOWN_PARAMS } from '../../../src/gen2/axe-fx-ii/index.js';

interface Expect {
  key: string;
  paramId: number;
  parameterName: string;
  xmlLabel: string | null; // null = must be absent
  controlType: 'knob' | 'select';
}

const EXPECT: Expect[] = [
  { key: 'amp.geq_band_1', paramId: 55, parameterName: 'DISTORT_EQ1', xmlLabel: '63', controlType: 'knob' },
  { key: 'amp.geq_band_2', paramId: 56, parameterName: 'DISTORT_EQ2', xmlLabel: '125', controlType: 'knob' },
  { key: 'amp.geq_band_3', paramId: 57, parameterName: 'DISTORT_EQ3', xmlLabel: '250', controlType: 'knob' },
  { key: 'amp.geq_band_4', paramId: 58, parameterName: 'DISTORT_EQ4', xmlLabel: '500', controlType: 'knob' },
  { key: 'amp.geq_band_5', paramId: 59, parameterName: 'DISTORT_EQ5', xmlLabel: '1K', controlType: 'knob' },
  { key: 'amp.geq_band_6', paramId: 60, parameterName: 'DISTORT_EQ6', xmlLabel: '2K', controlType: 'knob' },
  { key: 'amp.geq_band_7', paramId: 61, parameterName: 'DISTORT_EQ7', xmlLabel: '4K', controlType: 'knob' },
  { key: 'amp.geq_band_8', paramId: 62, parameterName: 'DISTORT_EQ8', xmlLabel: '8K', controlType: 'knob' },
  { key: 'output.scene_1_main', paramId: 8, parameterName: 'OUTPUT_MAIN1', xmlLabel: 'Main\nScene 1', controlType: 'knob' },
  { key: 'output.scene_2_main', paramId: 9, parameterName: 'OUTPUT_MAIN2', xmlLabel: 'Main\nScene 2', controlType: 'knob' },
  { key: 'output.scene_3_main', paramId: 10, parameterName: 'OUTPUT_MAIN3', xmlLabel: 'Main\nScene 3', controlType: 'knob' },
  { key: 'output.scene_4_main', paramId: 11, parameterName: 'OUTPUT_MAIN4', xmlLabel: 'Main\nScene 4', controlType: 'knob' },
  { key: 'output.scene_5_main', paramId: 12, parameterName: 'OUTPUT_MAIN5', xmlLabel: 'Main\nScene 5', controlType: 'knob' },
  { key: 'output.scene_6_main', paramId: 13, parameterName: 'OUTPUT_MAIN6', xmlLabel: 'Main\nScene 6', controlType: 'knob' },
  { key: 'output.scene_7_main', paramId: 14, parameterName: 'OUTPUT_MAIN7', xmlLabel: 'Main\nScene 7', controlType: 'knob' },
  { key: 'output.scene_8_main', paramId: 15, parameterName: 'OUTPUT_MAIN8', xmlLabel: 'Main\nScene 8', controlType: 'knob' },
  { key: 'amp.tone_stack', paramId: 34, parameterName: 'DISTORT_TONETYPE', xmlLabel: 'Tonestack Type', controlType: 'select' },
  { key: 'amp.pwr_amp_tube', paramId: 68, parameterName: 'DISTORT_TUBETYPE', xmlLabel: 'Power Tube Type', controlType: 'select' },
  { key: 'amp.preamp_tubes', paramId: 69, parameterName: 'DISTORT_PRETUBETYPE', xmlLabel: 'Preamp Tube Type', controlType: 'select' },
  { key: 'amp.char_type', paramId: 102, parameterName: 'DISTORT_HMTYPE', xmlLabel: 'Character\nType', controlType: 'select' },
  { key: 'amp.cf_comp_type', paramId: 111, parameterName: 'DISTORT_PRECOMPTYPE', xmlLabel: 'Preamp CF\nCompType', controlType: 'select' },
  { key: 'parametriceq.freq_type_1', paramId: 15, parameterName: 'PEQ_LFTYPE', xmlLabel: 'Frequency 1 Type', controlType: 'select' },
  { key: 'parametriceq.freq_type_5', paramId: 16, parameterName: 'PEQ_HFTYPE', xmlLabel: 'Frequency 5 Type', controlType: 'select' },
  { key: 'parametriceq.freq_type_2', paramId: 17, parameterName: 'PEQ_LMTYPE', xmlLabel: 'Frequency 2 Type', controlType: 'select' },
  { key: 'parametriceq.freq_type_4', paramId: 18, parameterName: 'PEQ_HMTYPE', xmlLabel: 'Frequency 4 Type', controlType: 'select' },
  { key: 'reverb.spring_number', paramId: 23, parameterName: 'REVERB_NUMSPRINGS', xmlLabel: 'Number Springs', controlType: 'knob' },
  { key: 'pitch.voice_1_pan', paramId: 15, parameterName: 'PITCH_PAN1', xmlLabel: 'Pan 1', controlType: 'knob' },
  { key: 'pitch.voice_2_pan', paramId: 16, parameterName: 'PITCH_PAN2', xmlLabel: 'Pan 2', controlType: 'knob' },
  { key: 'pitch.voice_1_feedback', paramId: 19, parameterName: 'PITCH_FEEDBACK1', xmlLabel: 'Feedback 1', controlType: 'knob' },
  { key: 'pitch.voice_2_feedback', paramId: 20, parameterName: 'PITCH_FEEDBACK2', xmlLabel: 'Feedback 2', controlType: 'knob' },
  { key: 'pitch.voice_1_splice', paramId: 31, parameterName: 'PITCH_SPLICE1', xmlLabel: 'V1 Splice', controlType: 'knob' },
  { key: 'pitch.voice_2_splice', paramId: 32, parameterName: 'PITCH_SPLICE2', xmlLabel: 'V2 Splice', controlType: 'knob' },
  { key: 'pitch.amplitube_alpha', paramId: 76, parameterName: 'PITCH_AMPALPHA', xmlLabel: 'Amplitude Alpha', controlType: 'knob' },
  { key: 'pitch.amplitube_shape', paramId: 75, parameterName: 'PITCH_AMPSHAPE', xmlLabel: 'Amplitude Shape', controlType: 'select' },
  { key: 'pitch.voice_1_delay', paramId: 17, parameterName: 'PITCH_DELAY1', xmlLabel: null, controlType: 'knob' },
  { key: 'pitch.voice_2_delay', paramId: 18, parameterName: 'PITCH_DELAY2', xmlLabel: null, controlType: 'knob' },
  { key: 'synth.filter_1', paramId: 9, parameterName: 'SYNTH_HICUT1', xmlLabel: 'Filter', controlType: 'knob' },
  { key: 'synth.filter_2', paramId: 20, parameterName: 'SYNTH_HICUT2', xmlLabel: 'Filter', controlType: 'knob' },
  { key: 'synth.filter_3', paramId: 38, parameterName: 'SYNTH_HICUT3', xmlLabel: 'Filter', controlType: 'knob' },
  { key: 'amp.neg_feedback', paramId: 24, parameterName: 'DISTORT_BETA', xmlLabel: 'Negative Feedback', controlType: 'knob' },
  { key: 'amp.cathode_resist', paramId: 93, parameterName: 'DISTORT_CBRATIO', xmlLabel: 'Cathode Resistance', controlType: 'knob' },
  { key: 'amp.preamp_low_cut', paramId: 6, parameterName: 'DISTORT_HPFREQ', xmlLabel: 'Low Cut Freq', controlType: 'knob' },
  { key: 'amp.high_cut_freq', paramId: 7, parameterName: 'DISTORT_LPFREQ', xmlLabel: 'Hi Cut Freq', controlType: 'knob' },
  { key: 'amp.master_trim', paramId: 77, parameterName: 'DISTORT_MVTRIM', xmlLabel: 'Master Vol Trim', controlType: 'knob' },
  { key: 'amp.low_res', paramId: 27, parameterName: 'DISTORT_SPKRLFGAIN', xmlLabel: 'Low Resonance', controlType: 'knob' },
  { key: 'amp.b_time_const', paramId: 35, parameterName: 'DISTORT_TIMECONST', xmlLabel: 'B+ Time Constant', controlType: 'knob' },
  { key: 'cab.air_freq', paramId: 25, parameterName: 'CABINET_DIRECTFREQ', xmlLabel: 'Air Frequency', controlType: 'knob' },
  { key: 'cab.motor_time_constant', paramId: 38, parameterName: 'CABINET_TIMECONST', xmlLabel: 'Motor Time Const', controlType: 'knob' },
  { key: 'chorus.high_cut', paramId: 5, parameterName: 'CHORUS_HICUT', xmlLabel: 'Hi Cut', controlType: 'knob' },
  { key: 'compressor.threshold', paramId: 0, parameterName: 'COMP_THRESH', xmlLabel: 'Threshold', controlType: 'knob' },
  { key: 'delay.duck_attn', paramId: 42, parameterName: 'DELAY_ATTEN', xmlLabel: 'Ducker Atten', controlType: 'knob' },
  { key: 'delay.lfo1_depth_range', paramId: 67, parameterName: 'DELAY_MAXDEPTH', xmlLabel: 'Depth Range', controlType: 'select' },
  { key: 'delay.duck_thres', paramId: 43, parameterName: 'DELAY_THRESH', xmlLabel: 'Ducker Threshold', controlType: 'knob' },
  { key: 'drive.gain', paramId: 1, parameterName: 'FUZZ_DRIVE', xmlLabel: 'Drive', controlType: 'knob' },
  { key: 'drive.volume', paramId: 3, parameterName: 'FUZZ_LEVEL', xmlLabel: 'Level', controlType: 'knob' },
  { key: 'flanger.high_cut', paramId: 19, parameterName: 'FLANGER_HICUT', xmlLabel: 'Hi Cut', controlType: 'knob' },
  { key: 'flanger.lfo_highcut', paramId: 9, parameterName: 'FLANGER_LFOFILTER', xmlLabel: 'LFO Hicut', controlType: 'knob' },
  { key: 'flanger.dry_delay_shift', paramId: 6, parameterName: 'FLANGER_MANUAL', xmlLabel: 'Dry Delay', controlType: 'knob' },
  { key: 'looper.thres_level', paramId: 7, parameterName: 'LOOPER_THRESHLEV', xmlLabel: 'Threshold Level', controlType: 'knob' },
  { key: 'multidelay.master_freq', paramId: 45, parameterName: 'MULTITAP_MSTRFREQ', xmlLabel: 'Master Frequency', controlType: 'knob' },
  { key: 'multidelay.ducker_thres', paramId: 40, parameterName: 'MULTITAP_THRESH', xmlLabel: 'Ducker Threshold', controlType: 'knob' },
  { key: 'phaser.freq_span', paramId: 8, parameterName: 'PHASER_FSPAN', xmlLabel: 'Frequency Span', controlType: 'knob' },
  { key: 'phaser.freq_start', paramId: 7, parameterName: 'PHASER_FSTART', xmlLabel: 'Frequency Start', controlType: 'knob' },
  { key: 'ringmod.f_multiplier', paramId: 1, parameterName: 'RINGMOD_FINE', xmlLabel: 'Frequency Multiplier', controlType: 'knob' },
  { key: 'wah.freq_min', paramId: 1, parameterName: 'WAH_FSTART', xmlLabel: 'Frequency Min', controlType: 'knob' },
  { key: 'wah.freq_max', paramId: 2, parameterName: 'WAH_FSTOP', xmlLabel: 'Frequency Max', controlType: 'knob' },
  { key: 'wah.low_cut_freq', paramId: 14, parameterName: 'WAH_HPF', xmlLabel: 'Low Cut Frequency', controlType: 'knob' },
];

// Hardware-verified display ranges from PROBE-II-CAL-SWEEP (Axe-Fx II XL+,
// effectId 106, 5-point fn 0x02 sweep, device-rendered labels). Locks the
// ranges so a future params.ts edit cannot silently regress them.
interface CalExpect { key: string; displayMin: number; displayMax: number; displayScale?: 'linear' | 'log10'; }
const CAL_EXPECT: CalExpect[] = [
  { key: 'amp.geq_band_1', displayMin: -12, displayMax: 12 },
  { key: 'amp.geq_band_2', displayMin: -12, displayMax: 12 },
  { key: 'amp.geq_band_3', displayMin: -12, displayMax: 12 },
  { key: 'amp.geq_band_4', displayMin: -12, displayMax: 12 },
  { key: 'amp.geq_band_5', displayMin: -12, displayMax: 12 },
  { key: 'amp.geq_band_6', displayMin: -12, displayMax: 12 },
  { key: 'amp.geq_band_7', displayMin: -12, displayMax: 12 },
  { key: 'amp.geq_band_8', displayMin: -12, displayMax: 12 },
  { key: 'amp.low_res', displayMin: 0, displayMax: 10 },
  { key: 'amp.b_time_const', displayMin: 1, displayMax: 100, displayScale: 'log10' },
  { key: 'amp.cathode_resist', displayMin: 0, displayMax: 100 },
  { key: 'amp.neg_feedback', displayMin: 0, displayMax: 10 },
  { key: 'amp.master_trim', displayMin: 0.1, displayMax: 10, displayScale: 'log10' },
  { key: 'output.scene_1_main', displayMin: -20, displayMax: 20 },
  { key: 'output.scene_2_main', displayMin: -20, displayMax: 20 },
  { key: 'output.scene_3_main', displayMin: -20, displayMax: 20 },
  { key: 'output.scene_4_main', displayMin: -20, displayMax: 20 },
  { key: 'output.scene_5_main', displayMin: -20, displayMax: 20 },
  { key: 'output.scene_6_main', displayMin: -20, displayMax: 20 },
  { key: 'output.scene_7_main', displayMin: -20, displayMax: 20 },
  { key: 'output.scene_8_main', displayMin: -20, displayMax: 20 },
  { key: 'pitch.voice_1_pan', displayMin: -100, displayMax: 100 },
  { key: 'pitch.voice_2_pan', displayMin: -100, displayMax: 100 },
  { key: 'pitch.voice_1_feedback', displayMin: 0, displayMax: 100 },
  { key: 'pitch.voice_2_feedback', displayMin: 0, displayMax: 100 },
  { key: 'pitch.voice_1_delay', displayMin: 0, displayMax: 2000 },
  { key: 'pitch.voice_2_delay', displayMin: 0, displayMax: 2000 },
  { key: 'pitch.voice_1_splice', displayMin: 1, displayMax: 2000 },
  { key: 'pitch.voice_2_splice', displayMin: 1, displayMax: 2000 },
  { key: 'pitch.amplitube_alpha', displayMin: 0, displayMax: 100 },
];

export async function runAxeFxIIAnnotationCoverageTests(): Promise<void> {
  const params = KNOWN_PARAMS as Readonly<Record<string, {
    paramId: number;
    parameterName?: string;
    xmlLabel?: string;
    controlType: string;
    displayMin?: number;
    displayMax?: number;
    displayScale?: string;
  }>>;
  const failed: string[] = [];
  for (const e of EXPECT) {
    const p = params[e.key];
    if (!p) { failed.push(`${e.key}: missing from KNOWN_PARAMS`); continue; }
    if (p.paramId !== e.paramId) failed.push(`${e.key}: paramId ${p.paramId} != ${e.paramId} (wire address moved!)`);
    if (p.parameterName !== e.parameterName) failed.push(`${e.key}: parameterName ${JSON.stringify(p.parameterName)} != ${JSON.stringify(e.parameterName)}`);
    if (e.xmlLabel === null) {
      if (p.xmlLabel !== undefined) failed.push(`${e.key}: xmlLabel should be absent (shared "Delay" label), got ${JSON.stringify(p.xmlLabel)}`);
    } else if (p.xmlLabel !== e.xmlLabel) {
      failed.push(`${e.key}: xmlLabel ${JSON.stringify(p.xmlLabel)} != ${JSON.stringify(e.xmlLabel)}`);
    }
    if (p.controlType !== e.controlType) failed.push(`${e.key}: controlType ${JSON.stringify(p.controlType)} != ${JSON.stringify(e.controlType)}`);
    if (p.controlType === 'unknown') failed.push(`${e.key}: controlType still "unknown" (annotation upgrade missing)`);
  }
  for (const c of CAL_EXPECT) {
    const p = params[c.key];
    if (!p) { failed.push(`${c.key}: missing from KNOWN_PARAMS (cal)`); continue; }
    if (p.displayMin !== c.displayMin) failed.push(`${c.key}: displayMin ${p.displayMin} != ${c.displayMin}`);
    if (p.displayMax !== c.displayMax) failed.push(`${c.key}: displayMax ${p.displayMax} != ${c.displayMax}`);
    const wantScale = c.displayScale ?? undefined;
    if (p.displayScale !== wantScale) failed.push(`${c.key}: displayScale ${JSON.stringify(p.displayScale)} != ${JSON.stringify(wantScale)}`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length}/${EXPECT.length + CAL_EXPECT.length} II annotation-coverage golden(s) failed:\n  ` + failed.join('\n  '));
  }
}

export const AXEFX2_ANNOTATION_CASE_COUNT = EXPECT.length;
