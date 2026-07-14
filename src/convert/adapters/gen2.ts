/**
 * Axe-Fx II → IR adapter. SKELETON depth: the Axe-Fx II preset binary is
 * treated as opaque beyond the preset name (its per-scene / per-block layout
 * is not decoded — that is the capture-gated FORGEFXMID-31 work). So the lift
 * carries the name only, with empty blocks and `decodeDepth` `'skeleton'`.
 */

import { extractPresetName, type ParsedPresetDump } from '../../devices/gen2/presetDump.js';
import type { ConverterPreset } from '../ir.js';

/** Axe-Fx II units carry 8 scenes (not decoded here — a device fact). */
const AXE_FX_II_SCENE_COUNT = 8;
/** Axe-Fx II model byte. */
const AXE_FX_II_MODEL_BYTE = 0x07;

/**
 * Lift a parsed Axe-Fx II preset dump into the IR. Only the preset name is
 * available at current decode depth.
 */
export function liftGen2Preset(parsed: ParsedPresetDump): ConverterPreset {
  return {
    sourceDevice: 'axe-fx-ii',
    name: extractPresetName(parsed),
    sceneCount: AXE_FX_II_SCENE_COUNT,
    blocks: [],
    routing: { seriesChains: [] },
    decodeDepth: 'skeleton',
    meta: {
      modelByte: AXE_FX_II_MODEL_BYTE,
      notes: [
        'Axe-Fx II preset binary is opaque beyond the name; deeper decode is ' +
          'capture-gated (FORGEFXMID-31).',
      ],
    },
  };
}

// NOTE: there is intentionally NO gen-1 (Axe-Fx Standard/Ultra) adapter yet —
// its dump decode is minimal. gen-1 IS represented in the families taxonomy
// (`axe-fx-gen1` device id, topology, family presence) so the conversion
// engine can TARGET it later; a lift adapter lands when its decode deepens.
