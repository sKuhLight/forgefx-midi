/**
 * AM4 → IR adapter. PARTIAL depth: the AM4 preset decode exposes the preset
 * name, the four scene names, and the AMP block's per-channel knob values (the
 * only block family with a validated record shape). Cab / FX blocks are not
 * yet decoded, so they are absent from the lift and `decodeDepth` is
 * `'partial'`.
 */

import type { Am4DecodedPreset } from '../../devices/am4/presetDump.js';
import { conceptKeyForLocal } from '../conceptLookup.js';
import type { ConverterPreset, ConverterBlock, ConverterParam } from '../ir.js';

/** AM4 units carry 4 scenes. */
const AM4_SCENE_COUNT = 4;
/** AM4 model byte. */
const AM4_MODEL_BYTE = 0x15;

/**
 * Lift a decoded AM4 preset into the IR. Emits a single `amp1` block when the
 * preset carries an amp; its params come from channel A, annotated with
 * concept keys where the registry knows them.
 */
export function liftAm4Preset(decoded: Am4DecodedPreset): ConverterPreset {
  const blocks: ConverterBlock[] = [];

  const chA = decoded.ampParams?.channels?.A;
  if (chA) {
    const params: ConverterParam[] = [];
    let typeName: string | undefined;
    for (const [nativeName, raw] of Object.entries(chA)) {
      if (nativeName === 'type') {
        if (typeof raw === 'string') typeName = raw;
        continue;
      }
      if (typeof raw !== 'number') continue;
      params.push({
        nativeName,
        conceptKey: conceptKeyForLocal('am4', 'amp', nativeName),
        value: raw,
        displayValue: String(raw),
      });
    }
    blocks.push({
      key: 'amp1',
      family: 'amp',
      instance: 1,
      typeName,
      params,
      liftedFrom: 'full-decode',
    });
  }

  return {
    sourceDevice: 'am4',
    name: decoded.presetName,
    sceneNames: [...decoded.sceneNames],
    sceneCount: AM4_SCENE_COUNT,
    blocks,
    routing: { seriesChains: blocks.length > 0 ? [blocks.map((b) => b.key)] : [] },
    decodeDepth: 'partial',
    meta: {
      modelByte: AM4_MODEL_BYTE,
      notes: ['AM4 decode is amp-block-only; cab/FX blocks are not yet decoded.'],
    },
  };
}
