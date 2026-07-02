/**
 * AM4 block-layout snapshot helpers.
 *
 * Pure goldens — no wire I/O. Covers the snapshot constructor and the
 * `isBlockPlaced` lookup used by  phantom-param pre-flight.
 */
import {
  buildBlockLayoutSnapshot,
  isBlockPlaced,
} from '../../src/am4/index.js';
import type { BlockTypeName, BlockLayoutSnapshot } from '../../src/am4/index.js';

interface Case {
  label: string;
  snapshot: BlockLayoutSnapshot;
  block: string;
  expected: boolean;
}

const fullChain = buildBlockLayoutSnapshot(['drive', 'amp', 'delay', 'reverb']);
const partial = buildBlockLayoutSnapshot(['amp', 'none', 'none', 'none']);
const empty = buildBlockLayoutSnapshot(['none', 'none', 'none', 'none']);

const cases: Case[] = [
  { label: 'drive placed in slot 1', snapshot: fullChain, block: 'drive', expected: true },
  { label: 'amp placed in slot 2', snapshot: fullChain, block: 'amp', expected: true },
  { label: 'reverb placed in slot 4', snapshot: fullChain, block: 'reverb', expected: true },
  { label: 'chorus absent (full chain)', snapshot: fullChain, block: 'chorus', expected: false },
  { label: 'phaser absent (full chain)', snapshot: fullChain, block: 'phaser', expected: false },
  { label: 'amp placed (partial)', snapshot: partial, block: 'amp', expected: true },
  { label: 'reverb absent (partial)', snapshot: partial, block: 'reverb', expected: false },
  { label: 'none never matches as placed', snapshot: partial, block: 'none', expected: false },
  { label: 'empty layout — drive not placed', snapshot: empty, block: 'drive', expected: false },
];

export const AM4_BLOCK_LAYOUT_CASE_COUNT = cases.length;

export function runAm4BlockLayoutTests(): void {
  for (const c of cases) {
    const actual = isBlockPlaced(c.snapshot, c.block);
    if (actual !== c.expected) {
      throw new Error(
        `[am4/blockLayout] ${c.label}: isBlockPlaced returned ${actual}, expected ${c.expected}`,
      );
    }
  }
  // Sanity: placedBlocks must exclude 'none' even on a partial slot set.
  if (partial.placedBlocks.has('none' as BlockTypeName)) {
    throw new Error(`[am4/blockLayout] placedBlocks must filter out 'none'`);
  }
  if (partial.placedBlocks.size !== 1) {
    throw new Error(
      `[am4/blockLayout] partial snapshot should have exactly 1 placed block, got ${partial.placedBlocks.size}`,
    );
  }
}
