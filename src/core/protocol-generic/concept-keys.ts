/**
 * Cross-device concept-key registry.
 *
 * The same conceptual knob is spelled differently across devices:
 *   - Drive output level: II `volume`, AM4 `level`, III `level`.
 *   - Amp power-amp master: II `master_volume`, AM4 `master`, III `master`.
 *   - Amp preamp gain: II `input_drive`, AM4 `gain`, III `gain`.
 *
 * `cross-device-aliases.ts` catches per-pair param-name divergences after
 * the agent has already typed one device's word. Concept-keys are the
 * canonical layer ABOVE the per-pair alias table. An agent that learned
 * the concept-key vocabulary writes the SAME word on every device, and
 * the dispatcher rewrites it to the local canonical name before the
 * writer sees it.
 *
 * Shape:
 *
 *   CONCEPT_KEYS['drive.output_level'] = {
 *     'axe-fx-ii': 'volume',
 *     'am4': 'level',
 *     'axe-fx-iii': 'level',
 *   };
 *
 * Lookup:
 *
 *   resolveConceptKey('am4', 'drive.output_level')
 *     => { localName: 'level', block: 'drive' }
 *
 *   resolveConceptKey('am4', 'drive.level')
 *     => undefined  (not a concept-key)
 *
 *   resolveConceptKey('am4', 'drive.unknown_concept')
 *     => undefined
 *
 * Scoping rules:
 *
 *   - Concept-keys are namespaced as `<block>.<concept>` so the same
 *     conceptual word can resolve differently per block (e.g.
 *     `amp.type` selects the amp model; `drive.type` selects the drive
 *     pedal model — both concept-keys, different mappings).
 *
 *   - Each concept-key maps to AT MOST ONE local param per device. If
 *     a device doesn't expose the concept (e.g. Hydrasynth has no
 *     drive block), the entry is omitted and `resolveConceptKey`
 *     returns `undefined` for that (device, key) pair.
 *
 *   - The block portion of the concept-key MUST match the device's
 *     canonical block slug. The dispatcher's existing block-alias
 *     resolution still applies on top, so a Hydrasynth user could
 *     type `module.cutoff` and the block_aliases would resolve
 *     `module` to a canonical block before concept-key lookup.
 *
 * Future work (NOT in this PR):
 *
 *   Enum-value concept-keys. The current
 *   `cross-device-enums.ts:resolveEnumAlias` table is structured as
 *   per-pair pairs (II `"USA IIC+"` <-> AM4 `"USA MK IIC+"`). A future
 *   `CONCEPT_ENUM_VALUES['amp.type.mesa-mark-iic-plus'] = { 'axe-fx-ii':
 *   'USA IIC+', 'am4': 'USA MK IIC+', 'axe-fx-iii': 'USA IIC+' }` would
 *   parallel this file's shape for enum-value cross-device routing.
 */

/**
 * The registry COLUMNS. There is one column per distinct param vocabulary,
 * NOT one per device. The gen-3 family (Axe-Fx III / FM3 / FM9 / VP4) shares
 * a single param vocabulary, so it is represented by ONE column
 * (`axe-fx-iii`); the resolver normalizes the floor-unit model ids onto it
 * (see `normalizeConceptPort`). This keeps the registry from duplicating
 * every entry four times.
 */
export type DevicePortSlug = 'am4' | 'axe-fx-ii' | 'axe-fx-iii' | 'hydrasynth';

/**
 * Model-id → registry-column normalization. `fm3`, `fm9`, and `vp4` reuse the
 * `axe-fx-iii` vocabulary column because they run the same gen-3 param codec
 * with a different model byte (the local param NAMES are identical). Returns
 * `undefined` for ids with no concept-key column (e.g. gen-1).
 */
const PORT_ALIASES: Readonly<Record<string, DevicePortSlug>> = Object.freeze({
  'axe-fx-iii': 'axe-fx-iii',
  fm3: 'axe-fx-iii',
  fm9: 'axe-fx-iii',
  vp4: 'axe-fx-iii',
  'axe-fx-ii': 'axe-fx-ii',
  am4: 'am4',
  hydrasynth: 'hydrasynth',
});

/**
 * Normalize a device id / port slug to its concept-key registry column.
 * Case-insensitive. `undefined` when the device has no column.
 */
export function normalizeConceptPort(port: string): DevicePortSlug | undefined {
  return PORT_ALIASES[port.trim().toLowerCase()];
}

/**
 * Per-model param-name overrides, applied AFTER column normalization. Keyed by
 * the RAW (un-normalized) model id, then by concept-key. Populate an entry here
 * ONLY when a specific gen-3 floor unit genuinely spells a param differently
 * from the Axe-Fx III (they share the vocabulary today, so this is empty). This
 * is the override hook the normalization design calls for; it lets `fm3` /
 * `fm9` / `vp4` diverge from the `axe-fx-iii` column one param at a time
 * without forking the whole registry.
 */
const MODEL_PARAM_OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    // e.g. fm3: { 'amp.preamp_gain': 'someOtherName' }  ← none known
  });

/**
 * One concept-key entry. Maps the canonical cross-device concept-key
 * (e.g. `drive.output_level`) to the local param name on each device
 * that exposes the concept.
 *
 * Per-device entries are partial: a device that doesn't have the
 * concept simply omits its entry. `resolveConceptKey` returns
 * `undefined` for the (device, key) pair in that case.
 */
export type ConceptKeyMap = Partial<Record<DevicePortSlug, string>>;

/**
 * Successful resolution of a concept-key on a device.
 */
export interface ResolvedConceptKey {
  /** The canonical block slug (the `block` portion of the concept-key). */
  block: string;
  /** The device-local param name (the value the writer expects). */
  localName: string;
  /** The full concept-key the caller passed (e.g. `drive.output_level`). */
  conceptKey: string;
}

/**
 * The registry. Keyed by `<block>.<concept>`; values map each device
 * slug to its local param name. Devices that don't expose the concept
 * omit their entry.
 *
 * Curated to cover the common tone-building vocabulary across Fractal
 * devices plus the major Hydrasynth synth concepts. Every Fractal-device
 * local name below is verified to exist in that device's param table by
 * `test/convert/concept-coverage.test.ts`; a device that lacks the param
 * omits its column. Block portion = the converter block/family slug.
 */
export const CONCEPT_KEYS: Readonly<Record<string, ConceptKeyMap>> = Object.freeze({
  // ── Amp (gen-3 DISTORT family) ──────────────────────────────────
  'amp.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'amp.preamp_gain': {
    'axe-fx-ii': 'input_drive',
    am4: 'gain',
    // gen-3 amp is the DISTORT family; its input-drive knob is DISTORT_DRIVE
    // (stripped key `drive`). The `gain` display word resolves via the alias table.
    'axe-fx-iii': 'drive',
  },
  'amp.power_amp_master': {
    'axe-fx-ii': 'master_volume',
    am4: 'master',
    'axe-fx-iii': 'master',
  },
  'amp.master_trim': {
    'axe-fx-ii': 'master_trim',
    am4: 'master_vol_trim',
    'axe-fx-iii': 'mvtrim',
  },
  'amp.output_level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'amp.bass': {
    'axe-fx-ii': 'bass',
    am4: 'bass',
    'axe-fx-iii': 'bass',
  },
  'amp.mid': {
    'axe-fx-ii': 'middle',
    am4: 'mid',
    'axe-fx-iii': 'mid',
  },
  'amp.treble': {
    'axe-fx-ii': 'treble',
    am4: 'treble',
    'axe-fx-iii': 'treble',
  },
  'amp.presence': {
    'axe-fx-ii': 'presence',
    am4: 'presence',
    'axe-fx-iii': 'presence',
  },
  'amp.depth': {
    'axe-fx-ii': 'depth',
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'amp.bright': {
    'axe-fx-ii': 'bright',
    am4: 'bright',
    'axe-fx-iii': 'bright',
  },
  'amp.sag': {
    'axe-fx-ii': 'supply_sag',
    am4: 'supply_sag',
    'axe-fx-iii': 'supplysag',
  },
  'amp.low_cut': {
    'axe-fx-ii': 'preamp_low_cut',
    am4: 'low_cut',
    'axe-fx-iii': 'hpfreq',
  },
  'amp.high_cut': {
    'axe-fx-ii': 'high_cut_freq',
    am4: 'high_cut',
    'axe-fx-iii': 'hicut',
  },
  'amp.input_trim': {
    'axe-fx-ii': 'input_trim',
    am4: 'input_trim',
    'axe-fx-iii': 'trim',
  },

  // ── Cab (gen-3 CABINET family; AM4 has no cab block) ────────────
  'cab.level': {
    'axe-fx-ii': 'level',
    'axe-fx-iii': 'level',
  },
  'cab.low_cut': {
    'axe-fx-ii': 'low_cut',
    'axe-fx-iii': 'locut',
  },
  'cab.high_cut': {
    'axe-fx-ii': 'high_cut',
    'axe-fx-iii': 'hicut',
  },
  'cab.air': {
    'axe-fx-ii': 'air',
    'axe-fx-iii': 'air',
  },

  // ── Drive (gen-3 FUZZ family) ───────────────────────────────────
  'drive.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'drive.gain': {
    'axe-fx-ii': 'gain',
    am4: 'drive',
    // gen-3 drive pedal is the FUZZ family; its gain knob is FUZZ_DRIVE
    // (stripped key `drive`).
    'axe-fx-iii': 'drive',
  },
  'drive.color_tone': {
    'axe-fx-ii': 'tone',
    am4: 'tone',
    'axe-fx-iii': 'tone',
  },
  'drive.output_level': {
    'axe-fx-ii': 'volume',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'drive.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'drive.low_cut': {
    'axe-fx-ii': 'lo_cut',
    am4: 'low_cut',
    'axe-fx-iii': 'locut',
  },
  'drive.high_cut': {
    'axe-fx-ii': 'hi_cut',
    am4: 'high_cut',
    'axe-fx-iii': 'hicut',
  },
  'drive.bass': {
    'axe-fx-ii': 'bass',
    am4: 'bass',
    'axe-fx-iii': 'bass',
  },
  'drive.mid': {
    'axe-fx-ii': 'middle',
    am4: 'mid',
    'axe-fx-iii': 'mid',
  },
  'drive.treble': {
    'axe-fx-ii': 'treble',
    am4: 'treble',
    'axe-fx-iii': 'treble',
  },
  'drive.bias': {
    'axe-fx-ii': 'bias',
    am4: 'bias',
    'axe-fx-iii': 'bias',
  },

  // ── Reverb ──────────────────────────────────────────────────────
  'reverb.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'reverb.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'reverb.time': {
    'axe-fx-ii': 'time',
    am4: 'time',
    'axe-fx-iii': 'time',
  },
  'reverb.predelay': {
    'axe-fx-ii': 'predelay',
    am4: 'pre_delay',
    'axe-fx-iii': 'predelay',
  },
  'reverb.size': {
    'axe-fx-ii': 'size',
    am4: 'size',
    'axe-fx-iii': 'size',
  },
  'reverb.low_cut': {
    'axe-fx-ii': 'low_cut',
    am4: 'low_cut',
    'axe-fx-iii': 'lowcut',
  },
  'reverb.high_cut': {
    'axe-fx-ii': 'high_cut',
    am4: 'high_cut',
    'axe-fx-iii': 'hicut',
  },
  'reverb.level': {
    'axe-fx-ii': 'level',
    'axe-fx-iii': 'level',
  },
  'reverb.depth': {
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'reverb.rate': {
    am4: 'rate',
    'axe-fx-iii': 'rate',
  },

  // ── Delay ───────────────────────────────────────────────────────
  'delay.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'delay.time': {
    'axe-fx-ii': 'time',
    am4: 'time',
    'axe-fx-iii': 'time',
  },
  'delay.feedback': {
    'axe-fx-ii': 'feedback',
    am4: 'feedback',
    'axe-fx-iii': 'feed',
  },
  'delay.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'delay.low_cut': {
    'axe-fx-ii': 'low_cut',
    am4: 'low_cut',
    'axe-fx-iii': 'locut',
  },
  'delay.high_cut': {
    'axe-fx-ii': 'high_cut',
    am4: 'high_cut',
    'axe-fx-iii': 'hicut',
  },
  'delay.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'delay.tempo': {
    'axe-fx-ii': 'tempo',
    am4: 'tempo',
    'axe-fx-iii': 'tempo',
  },
  'delay.drive': {
    'axe-fx-ii': 'drive',
    'axe-fx-iii': 'drive',
  },
  'delay.ratio': {
    'axe-fx-ii': 'ratio',
    'axe-fx-iii': 'ratio',
  },

  // ── Chorus ──────────────────────────────────────────────────────
  'chorus.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'chorus.rate': {
    'axe-fx-ii': 'rate',
    am4: 'rate',
    'axe-fx-iii': 'rate',
  },
  'chorus.depth': {
    'axe-fx-ii': 'depth',
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'chorus.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'chorus.high_cut': {
    'axe-fx-ii': 'high_cut',
    am4: 'high_cut',
    'axe-fx-iii': 'hicut',
  },
  'chorus.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'chorus.width': {
    'axe-fx-ii': 'width',
    'axe-fx-iii': 'width',
  },
  'chorus.drive': {
    'axe-fx-ii': 'drive',
    am4: 'drive',
    'axe-fx-iii': 'drive',
  },

  // ── Flanger ─────────────────────────────────────────────────────
  'flanger.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'flanger.rate': {
    'axe-fx-ii': 'rate',
    am4: 'rate',
    'axe-fx-iii': 'rate',
  },
  'flanger.depth': {
    'axe-fx-ii': 'depth',
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'flanger.feedback': {
    'axe-fx-ii': 'feedback',
    am4: 'feedback',
    'axe-fx-iii': 'feedback',
  },
  'flanger.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'flanger.drive': {
    'axe-fx-ii': 'drive',
    am4: 'drive',
    'axe-fx-iii': 'drive',
  },

  // ── Phaser ──────────────────────────────────────────────────────
  'phaser.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'phaser.rate': {
    'axe-fx-ii': 'rate',
    am4: 'rate',
    'axe-fx-iii': 'rate',
  },
  'phaser.depth': {
    'axe-fx-ii': 'depth',
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'phaser.feedback': {
    'axe-fx-ii': 'feedback',
    am4: 'feedback',
    'axe-fx-iii': 'feedback',
  },
  'phaser.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'phaser.tone': {
    'axe-fx-ii': 'tone',
    am4: 'tone',
    'axe-fx-iii': 'tone',
  },

  // ── Rotary (gen-3 ROTARY family) ────────────────────────────────
  'rotary.rate': {
    'axe-fx-ii': 'rate',
    am4: 'rate',
    'axe-fx-iii': 'rate',
  },
  'rotary.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'rotary.drive': {
    'axe-fx-ii': 'drive',
    am4: 'drive',
    'axe-fx-iii': 'drive',
  },
  'rotary.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },

  // ── Tremolo (II Pan/Trem, gen-3 TREMOLO family) ─────────────────
  'tremolo.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'tremolo.rate': {
    'axe-fx-ii': 'rate',
    am4: 'rate',
    'axe-fx-iii': 'rate',
  },
  'tremolo.depth': {
    'axe-fx-ii': 'depth',
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'tremolo.duty': {
    'axe-fx-ii': 'duty',
    am4: 'duty',
    'axe-fx-iii': 'duty',
  },
  'tremolo.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'tremolo.level': {
    'axe-fx-ii': 'level',
    'axe-fx-iii': 'level',
  },

  // ── Wah ─────────────────────────────────────────────────────────
  'wah.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'wah.mix': {
    'axe-fx-ii': 'level',
    am4: 'mix',
    'axe-fx-iii': 'level',
  },
  'wah.freq_min': {
    'axe-fx-ii': 'freq_min',
    am4: 'minimum_frequency',
    'axe-fx-iii': 'fstart',
  },
  'wah.freq_max': {
    'axe-fx-ii': 'freq_max',
    am4: 'maximum_frequency',
    'axe-fx-iii': 'fstop',
  },
  'wah.q': {
    'axe-fx-ii': 'resonance',
    am4: 'q_resonance',
    'axe-fx-iii': 'q',
  },
  'wah.drive': {
    'axe-fx-ii': 'drive',
    am4: 'drive',
    'axe-fx-iii': 'drive',
  },
  'wah.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },

  // ── Pitch (AM4 has no pitch block) ──────────────────────────────
  'pitch.type': {
    'axe-fx-ii': 'effect_type',
    'axe-fx-iii': 'type',
  },
  'pitch.mix': {
    'axe-fx-ii': 'mix',
    'axe-fx-iii': 'mix',
  },
  'pitch.level': {
    'axe-fx-ii': 'level',
    'axe-fx-iii': 'level',
  },

  // ── Filter ──────────────────────────────────────────────────────
  'filter.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'filter.cutoff': {
    'axe-fx-ii': 'frequency',
    am4: 'frequency',
    'axe-fx-iii': 'freq',
    hydrasynth: 'cutoff',
  },
  'filter.resonance': {
    'axe-fx-ii': 'q',
    am4: 'q',
    'axe-fx-iii': 'q',
    hydrasynth: 'res',
  },
  'filter.gain': {
    'axe-fx-ii': 'gain',
    am4: 'gain',
    'axe-fx-iii': 'gain',
  },
  'filter.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'filter.mix': {
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },

  // ── Compressor ──────────────────────────────────────────────────
  'compressor.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'compressor.threshold': {
    'axe-fx-ii': 'threshold',
    am4: 'threshold',
    'axe-fx-iii': 'thresh',
  },
  'compressor.ratio': {
    'axe-fx-ii': 'ratio',
    am4: 'ratio',
    'axe-fx-iii': 'ratio',
  },
  'compressor.attack': {
    'axe-fx-ii': 'attack',
    am4: 'attack_time',
    'axe-fx-iii': 'attack',
  },
  'compressor.release': {
    'axe-fx-ii': 'release',
    am4: 'release_time',
    'axe-fx-iii': 'release',
  },
  'compressor.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'compressor.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },
  'compressor.knee': {
    'axe-fx-ii': 'knee',
    'axe-fx-iii': 'knee',
  },

  // ── Gate (II Gate/Expander, gen-3 GATE family) ──────────────────
  'gate.type': {
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'gate.threshold': {
    'axe-fx-ii': 'threshold',
    am4: 'threshold',
    'axe-fx-iii': 'thresh',
  },
  'gate.release': {
    'axe-fx-ii': 'release',
    am4: 'release',
    'axe-fx-iii': 'release',
  },
  'gate.attack': {
    'axe-fx-ii': 'attack',
    am4: 'attack',
    'axe-fx-iii': 'attack',
  },
  'gate.hold': {
    'axe-fx-ii': 'hold',
    am4: 'hold',
    'axe-fx-iii': 'hold',
  },
  'gate.ratio': {
    'axe-fx-ii': 'ratio',
    am4: 'ratio',
    'axe-fx-iii': 'ratio',
  },

  // ── Vol/Pan (gen-3 VOLUME family) ───────────────────────────────
  'volpan.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'volpan.pan': {
    'axe-fx-ii': 'balance',
    am4: 'balance',
    'axe-fx-iii': 'bal',
  },

  // ── Enhancer ────────────────────────────────────────────────────
  'enhancer.width': {
    'axe-fx-ii': 'width',
    am4: 'width',
    'axe-fx-iii': 'width',
  },
  'enhancer.depth': {
    'axe-fx-ii': 'depth',
    am4: 'depth',
    'axe-fx-iii': 'depth',
  },
  'enhancer.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'enhancer.low_cut': {
    'axe-fx-ii': 'low_cut',
    am4: 'low_cut',
    'axe-fx-iii': 'lowcut',
  },
  'enhancer.high_cut': {
    'axe-fx-ii': 'high_cut',
    am4: 'high_cut',
    'axe-fx-iii': 'hicut',
  },

  // ── Graphic EQ (II graphiceq, gen-3 GEQ family) ─────────────────
  'geq.type': {
    'axe-fx-ii': 'effect_type',
    am4: 'type',
    'axe-fx-iii': 'type',
  },
  'geq.level': {
    'axe-fx-ii': 'level',
    am4: 'level',
    'axe-fx-iii': 'level',
  },
  'geq.mix': {
    'axe-fx-ii': 'mix',
    am4: 'mix',
    'axe-fx-iii': 'mix',
  },

  // ── Parametric EQ (II parametriceq, gen-3 PEQ family) ───────────
  'peq.level': {
    'axe-fx-ii': 'level',
    'axe-fx-iii': 'level',
  },
  // gen-3 PEQ has no plain `mix` (it exposes `globalmix`); AM4 only.
  'peq.mix': {
    am4: 'mix',
  },

  // ── Hydrasynth-specific synth concepts ──────────────────────────
  // These are synth-only — Fractal devices don't have these concepts,
  // so they map only on hydrasynth. The lookup helper returns
  // `undefined` when called for a Fractal device with these keys.
  'osc.pitch': {
    hydrasynth: 'semi',
  },
  'env.attack': {
    hydrasynth: 'attack',
  },
  'env.decay': {
    hydrasynth: 'decay',
  },
  'env.sustain': {
    hydrasynth: 'sustain',
  },
  'env.release': {
    hydrasynth: 'release',
  },
  'lfo.rate': {
    hydrasynth: 'rate',
  },
});

/**
 * Look up a concept-key on a target device. Returns the resolution
 * envelope (block + local name) or `undefined` if the key is not
 * registered OR if the device doesn't expose the concept.
 *
 * The concept-key must be in the `<block>.<concept>` form. Inputs
 * without a dot or unknown prefixes return `undefined` (the dispatcher
 * then falls through to per-device alias resolution + Levenshtein).
 *
 * Case-insensitive on the concept-key side. Returned `localName` is
 * the verbatim casing the device's param registry uses.
 */
export function resolveConceptKey(
  port: string,
  conceptKey: string,
): ResolvedConceptKey | undefined {
  const rawPort = port.trim().toLowerCase();
  const keyLower = conceptKey.trim().toLowerCase();
  if (!keyLower.includes('.')) return undefined;
  const map = CONCEPT_KEYS[keyLower];
  if (map === undefined) return undefined;
  // Per-model override wins (raw model id, un-normalized) so a floor unit can
  // diverge from the shared gen-3 column one param at a time.
  const override = MODEL_PARAM_OVERRIDES[rawPort]?.[keyLower];
  const column = normalizeConceptPort(rawPort);
  const localName =
    override ??
    (column === undefined
      ? undefined
      : (map as Record<string, string | undefined>)[column]);
  if (localName === undefined) return undefined;
  const dotIdx = keyLower.indexOf('.');
  const block = keyLower.slice(0, dotIdx);
  return { block, localName, conceptKey: keyLower };
}

/**
 * Look up a concept-key when only the `<concept>` portion is supplied
 * AND a target block is known (from the apply_preset slot's
 * `block_type` or a set_param `block` argument). Wraps `resolveConceptKey`
 * by prepending `<block>.` to the input.
 *
 * Used by the dispatcher's per-block param resolution path: the slot's
 * block_type provides the block portion, and the agent only needs to
 * type the bare concept word (e.g. `output_level` instead of the full
 * `drive.output_level`).
 *
 * Returns `undefined` when the resulting key is not in the registry OR
 * the device doesn't expose the concept.
 */
export function resolveConceptKeyForBlock(
  port: string,
  block: string,
  conceptOrParamName: string,
): ResolvedConceptKey | undefined {
  // If the caller already passed a fully-qualified concept-key (contains
  // a dot), defer to the unqualified lookup so we don't double-prefix.
  if (conceptOrParamName.includes('.')) {
    return resolveConceptKey(port, conceptOrParamName);
  }
  const blockKey = block.trim().toLowerCase();
  const conceptKey = `${blockKey}.${conceptOrParamName.trim().toLowerCase()}`;
  return resolveConceptKey(port, conceptKey);
}

/**
 * Return the per-device concept-key map for `describe_device`. Each
 * entry is `{ conceptKey, localName }` so the agent can read it as a
 * flat list and learn the device-specific spelling for each cross-
 * device concept.
 *
 * Pure data — built once from the static CONCEPT_KEYS registry. The
 * dispatcher's discovery executor invokes this on every
 * describe_device call.
 */
export function listConceptKeysForDevice(
  port: string,
): readonly { conceptKey: string; localName: string }[] {
  const rawPort = port.trim().toLowerCase();
  const column = normalizeConceptPort(rawPort);
  if (column === undefined) return [];
  const overrides = MODEL_PARAM_OVERRIDES[rawPort];
  const out: { conceptKey: string; localName: string }[] = [];
  for (const [conceptKey, map] of Object.entries(CONCEPT_KEYS)) {
    const localName =
      overrides?.[conceptKey] ?? (map as Record<string, string | undefined>)[column];
    if (localName !== undefined) {
      out.push({ conceptKey, localName });
    }
  }
  return out;
}
