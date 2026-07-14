/**
 * Shallow-adapter goldens (AM4 / VP4 / gen-2).
 *
 * Drives each shallow adapter from a synthetic minimal input and asserts it
 * produces a valid IR with the correct `decodeDepth`, families, concept-key
 * annotation, and routing shape.
 */
import { liftAm4Preset } from '../../src/convert/adapters/am4.js';
import { liftVp4Preset } from '../../src/convert/adapters/vp4.js';
import { liftGen2Preset } from '../../src/convert/adapters/gen2.js';
import { isConverterFamily } from '../../src/convert/families.js';
import type { Am4DecodedPreset } from '../../src/devices/am4/presetDump.js';
import type { Vp4StructureBlob } from '../../src/gen3/vp4/structureBlob.js';
import type { ParsedPresetDump } from '../../src/devices/gen2/presetDump.js';
import {
  PRESET_NAME_PAYLOAD_OFFSET,
  PRESET_NAME_STRIDE,
  CHUNK_PAYLOAD_LEN,
} from '../../src/devices/gen2/presetDump.js';

export const SHALLOW_ADAPTERS_CASE_COUNT = 3;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[convert/adapters-shallow] ${msg}`);
}

function testAm4(): void {
  // Synthetic decode: only the fields the adapter reads (presetName, scene
  // names, amp channel A). Cast because the full container has many fields the
  // adapter never touches.
  const decoded = {
    presetName: 'Bass NoAmp DI',
    sceneNames: ['Scene 1', 'Scene 2', 'Scene 3', 'Scene 4'],
    ampParams: {
      base: 0x0934,
      channels: {
        A: { type: 'USA MK IIC+', gain: 5.1, master: 5.1, bass: 3.0, treble: 6.5 },
      },
    },
  } as unknown as Am4DecodedPreset;

  const ir = liftAm4Preset(decoded);
  assert(ir.decodeDepth === 'partial', 'am4 decodeDepth');
  assert(ir.sourceDevice === 'am4', 'am4 sourceDevice');
  assert(ir.name === 'Bass NoAmp DI', 'am4 name');
  assert(ir.sceneCount === 4 && ir.sceneNames?.length === 4, 'am4 scenes');
  assert(ir.blocks.length === 1, 'am4 should lift exactly one (amp) block');
  const amp = ir.blocks[0];
  assert(amp.key === 'amp1' && amp.family === 'amp', 'am4 amp key/family');
  assert(amp.typeName === 'USA MK IIC+', 'am4 amp typeName from channel A type');
  assert(amp.liftedFrom === 'full-decode', 'am4 amp liftedFrom');
  const gain = amp.params.find((p) => p.nativeName === 'gain');
  assert(gain?.conceptKey === 'amp.preamp_gain', `am4 gain conceptKey ${gain?.conceptKey}`);
  const master = amp.params.find((p) => p.nativeName === 'master');
  assert(master?.conceptKey === 'amp.power_amp_master', `am4 master conceptKey ${master?.conceptKey}`);
  assert(ir.routing.seriesChains.length === 1 && ir.routing.seriesChains[0][0] === 'amp1', 'am4 chain');
  assert(ir.routing.gridCells === undefined, 'am4 has no grid');
}

function testVp4(): void {
  const blob: Vp4StructureBlob = {
    statusFlag: 0x00,
    currentScene: 0,
    currentSceneDisplay: 1,
    presetName: 'Virtual Pedalboard',
    sceneNames: ['A', 'B', 'C', 'D'],
    chain: [
      { effectId: 118, name: 'Drive' },
      { effectId: 70, name: 'Delay' },
      null,
      { effectId: 66, name: 'Reverb' },
    ],
  };

  const ir = liftVp4Preset(blob);
  assert(ir.decodeDepth === 'skeleton', 'vp4 decodeDepth');
  assert(ir.sourceDevice === 'vp4', 'vp4 sourceDevice');
  assert(ir.name === 'Virtual Pedalboard', 'vp4 name');
  assert(ir.sceneCount === 4 && ir.sceneNames?.length === 4, 'vp4 scenes');
  assert(ir.blocks.length === 3, 'vp4 should lift 3 occupied slots');
  for (const b of ir.blocks) {
    assert(isConverterFamily(b.family), `vp4 bad family ${b.family}`);
    assert(b.params.length === 0, 'vp4 blocks are identity-only');
    assert(b.liftedFrom === 'partial-decode', 'vp4 liftedFrom');
    assert(b.position !== undefined && 'slot' in b.position, 'vp4 block needs a slot position');
  }
  assert(ir.blocks[0].family === 'drive' && ir.blocks[0].typeName === 'Drive', 'vp4 slot 0 = drive');
  assert(
    JSON.stringify(ir.routing.seriesChains) === JSON.stringify([['drive1', 'delay1', 'reverb1']]),
    `vp4 chain ${JSON.stringify(ir.routing.seriesChains)}`,
  );
}

function testGen2(): void {
  // Synthetic parsed dump: only chunk 0 matters (it carries the name at
  // offset 8, one ASCII char per 3-byte triplet).
  const name = 'Plexi 100W';
  const chunk0 = new Uint8Array(CHUNK_PAYLOAD_LEN);
  for (let i = 0; i < name.length; i++) {
    chunk0[PRESET_NAME_PAYLOAD_OFFSET + i * PRESET_NAME_STRIDE] = name.charCodeAt(i);
  }
  const parsed = {
    raw: new Uint8Array(0),
    headerPayload: new Uint8Array(4),
    chunkPayloads: [chunk0],
    footerPayload: new Uint8Array(3),
  } as unknown as ParsedPresetDump;

  const ir = liftGen2Preset(parsed);
  assert(ir.decodeDepth === 'skeleton', 'gen2 decodeDepth');
  assert(ir.sourceDevice === 'axe-fx-ii', 'gen2 sourceDevice');
  assert(ir.name === name, `gen2 name ${ir.name}`);
  assert(ir.blocks.length === 0, 'gen2 blocks empty (opaque binary)');
  assert(ir.sceneCount === 8, 'gen2 sceneCount');
  assert(ir.routing.seriesChains.length === 0, 'gen2 no chains');
  assert((ir.meta?.notes?.length ?? 0) > 0, 'gen2 meta note present');
}

export function runShallowAdaptersTests(): void {
  testAm4();
  testVp4();
  testGen2();
}
