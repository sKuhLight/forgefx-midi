/**
 * VP4 config for `createModernFractalDescriptor`.
 *
 * The VP4 (model byte 0x14) is a gen-3 effects pedal: it reuses the gen-3
 * SysEx envelope + the III's effects codec and block effect IDs, but it is
 * AM4-SHAPE on the front panel — a serial 4-slot chain with 4 scenes,
 * A-D channels, and A01..Z04 preset locations (NOT the gen-3 6x14 grid /
 * 8 scenes). It has no amp/cab section.
 *
 * VERIFICATION / GATING. The gen-3 envelope/checksum/effect-ID layer and the
 * VP4 fn=0x01 frame are confirmed byte-exact from community captures (fw 4.03).
 * The VP4 SET frame is its OWN shape (no sub-action, a `tc` sub-opcode, a
 * swapped-septet float — see `fractal-midi/gen3/vp4/setParam.ts`). This config ships
 * READS plus two byte-exact, community-beta (untested-on-hardware) writes:
 * `set_bypass` and `save_preset` (see `write_allowlist`). Every OTHER write
 * stays GATED (`writes_gated: true`): `set_param` (per-param value calibration +
 * discrete/continuous distinction undecoded), `set_block` (placement value→slot
 * math undecoded), `switch_scene` (value↔scene mapping unconfirmed), plus
 * apply_preset / rename / switch_preset refuse with a clear message. community-beta.
 *
 * CATALOG. paramIds are VP4-true (mined from VP4-Edit's own binary; reusing
 * the III's mis-addresses 99.1% of shared params — see
 * `docs/_private/MINING-FINDINGS-FM-VP4.md`). The mined catalog is shared
 * across the gen-3 editor family, so it carries DISTORT (amp) + CABINET
 * params even though the physical VP4 has no amp/cab; `exclude_blocks`
 * drops those two blocks from the surface (device_true_roster alone won't —
 * it only drops EMPTY mapped families, and these are non-empty in the mine).
 */
import { VP4_PARAMS_BY_FAMILY } from '../../../gen3/vp4/index.js';
import type { FractalModernConfig } from '../factory.js';
import type { PresetSpec } from '../../../core/protocol-generic/types.js';
import {
  MODERN_AGENT_GUIDANCE,
  MODERN_BLOCK_PARAMS_SUMMARY,
} from './shared.js';

// VP4 is a serial 4-slot chain (AM4-shape), so the example places blocks by
// 1-based slot index, not grid cell. Writes are gated, so this spec is
// illustrative (it shapes the describe_device example), never sent.
const VP4_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      // The user-facing Drive / OD pedal (ID_FUZZ family): drive/tone/level.
      slot: 1,
      block_type: 'drive',
      params_by_channel: {
        A: { type: 3, drive: 5, tone: 5, level: 5 },
      },
    },
    {
      slot: 2,
      block_type: 'reverb',
      params_by_channel: {
        A: { type: 3, time: 5, mix: 25 },
      },
    },
    {
      slot: 3,
      block_type: 'delay',
      params_by_channel: {
        A: { time: 5, mix: 25 },
      },
    },
    { slot: 4, block_type: 'chorus' },
  ],
  scenes: [
    { scene: 1, name: 'Rhythm', channels: { reverb: 'A', delay: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { reverb: 'A', delay: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

export const VP4_CONFIG: FractalModernConfig = {
  id: 'vp4',
  display_name: 'Fractal VP4',
  model_byte: 0x14,
  connection_label: 'vp4',
  port_match: [
    { pattern: /vp ?4/i }, // "VP4", "VP 4", "VP-4" (transport strips the dash via needles)
  ],
  // Serial AM4-shape: 4 effect slots, 4 scenes, A-D channels, A01..Z04
  // locations (26 banks x 4 = 104). NOT the gen-3 grid / 8-scene shape.
  slot_count: 4,
  scene_count: 4,
  channel_names: ['A', 'B', 'C', 'D'],
  preset_count: 104,
  preset_location_format: /^[A-Z]0?[1-4]$/,
  support_tier: 'community-beta',
  // Reads work; most writes gated. set_bypass + save_preset are decoded
  // byte-exact from a community capture (fw 4.03, 2026-06-09) and ship as
  // community-beta (untested on hardware). set_param (calibration + discrete/
  // continuous undecoded), set_block (placement value-math), and switch_scene
  // (value mapping) stay gated pending more captures.
  writes_gated: true,
  // Decoded byte-exact from a community capture (fw 4.03). Continuous set_param
  // works (raw 0..65534 wire value → normalized float; DISCRETE/enum set refuses,
  // no captured evidence). set_block (placement value→slot math) and switch_scene
  // (value mapping) stay gated — genuinely undecoded, not just untested.
  write_allowlist: ['set_param', 'set_params', 'set_bypass', 'save_preset'],
  verification:
    'Model byte 0x14 wire-confirmed. The gen-3 envelope/checksum/septet layer and the block ' +
    'effect-ID table are confirmed on VP4 hardware (community captures, fw 4.03). The VP4 fn=0x01 ' +
    'WRITE frame is decoded byte-exact (its own shape: no sub-action, a tc sub-opcode, a ' +
    'swapped-septet float). set_param (continuous knobs; raw 0..65534 value, %/ms calibration ' +
    'pending — enum/type set refuses), set_bypass, and save_preset ship as community-beta (untested ' +
    'on hardware, confirm on the front panel). set_block / apply_preset (placement value→slot math ' +
    'undecoded — cannot build a move) and switch_scene (value↔scene mapping unconfirmed) stay GATED. ' +
    'Param catalog ' +
    'is VP4-true (mined from VP4-Edit; paramIds device-specific). No amp/cab.',
  params_by_family: VP4_PARAMS_BY_FAMILY,
  device_true_roster: true,
  // The mined catalog carries DISTORT (amp) + CABINET params from the shared
  // gen-3 editor binary, but the physical VP4 has neither block. Drop both.
  exclude_blocks: ['amp', 'cab'],
  canonical_terms: {
    block: 'block',
    slot: 'effect slot (1..4 in the serial chain)',
    preset: 'preset',
    scene: 'scene 1..4',
    channel: 'channel A/B/C/D',
    location: 'preset location A01..Z04',
  },
  agent_guidance: {
    ...MODERN_AGENT_GUIDANCE,
    // Override the shared beta_status: on VP4 every device-state write refuses
    // (writes_gated), so the family-default "writes attempt a wire send" is
    // wrong here. Keep it consistent with device_note below.
    beta_status: [
      'COMMUNITY BETA. Reads work. WRITES decoded byte-exact from a community',
      'capture, shipping UNTESTED (confirm on the VP4 front panel):',
      '• set_param / set_params — CONTINUOUS knobs only; the value is the raw',
      '  0..65534 wire field (NOT calibrated to %/ms yet). Setting an enum/TYPE',
      '  selector refuses (no captured evidence).',
      '• set_bypass, save_preset.',
      'GENUINELY UNDECODED, still gated (refuse): set_block / apply_preset',
      '(block-placement value→slot math is unknown — we cannot build a move),',
      'switch_scene (value↔scene mapping), switch_preset, rename. These are not',
      'just untested — the wire bytes are undecoded. Do not present a gated',
      'write as applied; do not present a continuous value as an exact %/ms.',
    ].join('\n'),
    device_note: [
      'This is the Fractal VP4 (community beta). It reuses the Axe-Fx III',
      'gen-3 effects codec but is AM4-shape: a serial 4-slot chain with 4',
      'scenes, A-D channels, A01..Z04 preset locations, and NO amp/cab.',
      'The param catalog is VP4-true (mined from VP4-Edit\'s own binary).',
      '',
      'WRITES (community beta, byte-exact captured wire shape, untested on',
      'hardware — tell the user to confirm on the front panel):',
      'set_param/set_params (CONTINUOUS knobs; value is the raw 0..65534 wire',
      'field, not %/ms — enum/TYPE set refuses), set_bypass, and save_preset',
      '(needs explicit save intent). STILL GATED (wire bytes undecoded, not just',
      'untested): set_block / apply_preset (block placement), switch_scene,',
      'switch_preset, rename. Do not present a gated write as applied.',
    ].join('\n'),
  },
  example_spec: VP4_EXAMPLE_SPEC,
  block_params_summary: MODERN_BLOCK_PARAMS_SUMMARY,
};
