/**
 * FM9 config for `createModernFractalDescriptor`.
 *
 * The FM9 (model byte 0x12) is a gen-3 sibling of the Axe-Fx III: same
 * SysEx envelope, same 6×14 grid, 8 scenes, A–D channels. It now ships a
 * DEVICE-TRUE param catalog (`fractal-midi/gen3/fm9`) mined from FM9-Edit's own
 * binary — block roster + effect IDs are the III's (shared across the
 * family), but paramIds are FM9's own (reusing the III's mis-addresses
 * 18.6% of shared params; see `docs/_private/MINING-FINDINGS-FM-VP4.md`).
 * Model byte 0x12 is HARDWARE-CONFIRMED on a real FM9 (firmware 11.0,
 * community fm9-catalog foundation probe, 2026-06-06): a QUERY PATCH NAME
 * built with 0x12 echoes model 0x12 with a valid checksum, scene GET/SET
 * (fn 0x0C) round-trips with the front panel following, and STATUS_DUMP
 * (fn 0x13) framing matches the III family. The FM9 returns NO Universal
 * Identity Reply, so a Fractal-native query is the ID path. community-beta
 * (the explicit-effectId SET path is still owner-round-trip pending).
 */
import { FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES, FM9_RANGES } from '../../../gen3/fm9/index.js';
import { informativeDeviceRanges, toSymbolEnumOverrides } from '../catalog.js';
import type { FractalModernConfig } from '../factory.js';
import {
  MODERN_AGENT_GUIDANCE,
  MODERN_BLOCK_PARAMS_SUMMARY,
  WIDE_GRID_EXAMPLE_SPEC,
} from './shared.js';

// FM9_ENUM_OVERRIDES ships FAMILY-shaped (family → paramId → label list, the
// uniform gen-3 shape); the descriptor factory wants the symbol-keyed
// {paramName → {ordinal → name}} view. Param names are globally unique, so the
// re-key is lossless. Placeholder range rows are dropped so they can't clobber
// inline display bounds (see informativeDeviceRanges).
const FM9_SYMBOL_ENUM_OVERRIDES = toSymbolEnumOverrides(FM9_PARAMS_BY_FAMILY, FM9_ENUM_OVERRIDES);
const FM9_DEVICE_RANGES = informativeDeviceRanges(FM9_RANGES);

export const FM9_CONFIG: FractalModernConfig = {
  id: 'fm9',
  display_name: 'Fractal FM9',
  model_byte: 0x12,
  connection_label: 'fm9',
  port_match: [
    { pattern: /fm ?9/i }, // "FM9", "FM 9", "FM-9" (transport strips the dash via needles)
  ],
  grid: { rows: 6, cols: 14 },
  scene_count: 8,
  channel_names: ['A', 'B', 'C', 'D'],
  // FM9 addresses 512 preset slots (beta assumption; over-permissive
  // validation just defers to the device, which ignores an out-of-range PC).
  preset_count: 512,
  preset_location_format: /^(?:\d{1,4})$/,
  // The FM9 reads MIDI Bank Select from CC0/MSB and ignores CC32 (hardware-
  // confirmed on a real FM9, 2026-06-06). Without this, switch_preset to any
  // preset above 127 lands in bank 0. The FM3 was field-confirmed to ignore
  // CC32 as well (fw 12.00, 2026-06-12 — see fm3.ts); only the III keeps the
  // spec-standard CC0<<7|CC32 default, sourced from the v1.4 spec (the same
  // spec sentence the FM3 falsified) and itself hardware-unverified for
  // presets above 127.
  bank_select: 'msb',
  support_tier: 'community-beta',
  verification:
    'Model byte 0x12 hardware-confirmed on a real FM9 (fw 11.0, community foundation probe ' +
    '2026-06-06: QUERY PATCH NAME echoes 0x12, scene fn 0x0C round-trips, STATUS_DUMP fn 0x13 ' +
    'framing matches the III family, no Universal Identity Reply). ' +
    'Param catalog is FM9-true (mined from FM9-Edit\'s own parameter tables; paramIds are ' +
    'device-specific, not reused from the III). A real FM9 fn=0x01 capture exists (FM9-Edit ' +
    'driving a reverb-mix change on hardware), confirming the model byte + fn=0x01 envelope ' +
    'on a live FM9. UPDATE 2026-06-17 (community FM9 owner test, fw 11.0 / macOS, driving THIS ' +
    'server): get_param + continuous set_param round-trip acked on the device with values ' +
    'confirmed on the FM9-Editor display; channel-specific reads and alias resolution (gain→drive) ' +
    'confirmed too. The READ path and the CONTINUOUS SET path are now FM9-hardware-confirmed ' +
    'end-to-end through this codec\'s own frames. Still community-beta pending the same owner\'s ' +
    'confirmation: discrete enum set-by-name (FM3-hardware-confirmed via the shared codec), ' +
    'save_preset, set_block placement, and the live grid read (fn=0x01 sub=0x2E).',
  params_by_family: FM9_PARAMS_BY_FAMILY,
  device_true_roster: true,
  // Device-true FM9 enum vocabulary, mined COMPLETE from the FM9-Edit
  // effectDefinitions cache (76p0, 2026-07-05) by the strict count-driven
  // walker and validated against hardware ordinal anchors: amp 336 (@65/179/264),
  // drive/FUZZ 87 (@15/36), reverb 79 (@16/45), DISTORT_FBTYPE (@0/39/53),
  // FILTER_TYPE (@6). Covers every enum param (539 lists, 38 families) — modes,
  // LFO shapes, tempo subdivisions, mic picks — not just the type rosters. The
  // ordinal IS the discrete-SET value, so all lists are read labels AND
  // settable by name. See enumOverrides.generated.ts / rosters.generated.ts.
  enum_overrides: FM9_SYMBOL_ENUM_OVERRIDES,
  device_ranges: FM9_DEVICE_RANGES,
  canonical_terms: {
    block: 'block',
    slot: 'grid cell (row 1..6, col 1..14)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel A/B/C/D',
    location: 'preset slot 0..511 (integer)',
  },
  agent_guidance: {
    ...MODERN_AGENT_GUIDANCE,
    device_note: [
      'This is the Fractal FM9 (community beta). It shares the Axe-Fx III',
      'gen-3 SysEx protocol and a 6×14 grid with 8 scenes and A–D channels.',
      'The param catalog is FM9-true (mined from FM9-Edit\'s own binary, so',
      'paramIds address the right knob); block effect IDs are the III\'s,',
      'which are shared across the gen-3 family. Amp, drive, and reverb types',
      'are settable AND readable BY NAME using the FM9\'s own model names',
      '(e.g. amp "Texas Star Clean", drive "Blues OD", reverb "Music Hall"):',
      'the full device-true rosters are wired, not just a few captured points.',
      'get_param, continuous set_param, and channel-specific reads are',
      'FM9-hardware-confirmed (community owner test, fw 11.0). Discrete',
      'set-by-name, save_preset, set_block, and the live grid read are',
      'decoded but not yet FM9-confirmed — confirm those on the device.',
    ].join('\n'),
  },
  example_spec: WIDE_GRID_EXAMPLE_SPEC,
  block_params_summary: MODERN_BLOCK_PARAMS_SUMMARY,
};
