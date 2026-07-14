/**
 * VP4 → IR adapter. SKELETON depth: the VP4 structure blob exposes the preset
 * name, the four scene names, and the 4-slot serial chain as effect IDs. Only
 * block IDENTITY (family + type name) is available — no params — so
 * `decodeDepth` is `'skeleton'`.
 */

import type { Vp4StructureBlob } from '../../gen3/vp4/structureBlob.js';
import type { ConverterFamily } from '../families.js';
import { resolveFamily } from '../families.js';
import type { ConverterPreset, ConverterBlock } from '../ir.js';

/** VP4 units carry 4 scenes. */
const VP4_SCENE_COUNT = 4;
/** VP4 model byte. */
const VP4_MODEL_BYTE = 0x14;

/** Base name of a chain-slot display name ("Drive 2" → "Drive"). */
function baseName(name: string): string {
  const m = /^(.+?)\s+\d+$/.exec(name.trim());
  return m ? m[1] : name.trim();
}

/**
 * Lift a decoded VP4 structure blob into the IR. Each occupied chain slot
 * becomes an identity-only block; the four slots form a single serial chain.
 */
export function liftVp4Preset(blob: Vp4StructureBlob): ConverterPreset {
  const blocks: ConverterBlock[] = [];
  const instanceByFamily = new Map<ConverterFamily, number>();

  blob.chain.forEach((slot, i) => {
    if (slot === null || slot.name === undefined) return;
    const family = resolveFamily(baseName(slot.name));
    if (family === undefined) return;
    const instance = (instanceByFamily.get(family) ?? 0) + 1;
    instanceByFamily.set(family, instance);
    blocks.push({
      key: `${family}${instance}`,
      family,
      instance,
      typeName: slot.name,
      typeValue: slot.effectId,
      params: [],
      position: { slot: i + 1 },
      liftedFrom: 'partial-decode',
    });
  });

  return {
    sourceDevice: 'vp4',
    name: blob.presetName,
    sceneNames: [...blob.sceneNames],
    sceneCount: VP4_SCENE_COUNT,
    blocks,
    routing: { seriesChains: blocks.length > 0 ? [blocks.map((b) => b.key)] : [] },
    decodeDepth: 'skeleton',
    meta: {
      modelByte: VP4_MODEL_BYTE,
      notes: ['VP4 decode is a skeleton: chain identity only, no block params.'],
    },
  };
}
