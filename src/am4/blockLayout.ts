/**
 * AM4 working-buffer block-layout snapshot — pure helpers.
 *
 * The AM4 holds 4 signal-chain slots. Each slot register reports the
 * pidLow of the block currently placed there (or `BLOCK_TYPE_VALUES.none`
 * for empty). Reading the four slot registers produces a `BlockLayoutSnapshot`
 * — the union of placed block types in the active working buffer.
 *
 * Used by  phantom-param pre-flight: a `set_param` write against a
 * block that isn't placed in any slot wire-acks but silently no-ops on
 * the device. The dispatcher consults the cached snapshot before each
 * write and surfaces a `validation_info[]` warning when the target block
 * is absent.
 *
 * The codec layer is wire-bytes agnostic — the consumer reads the four
 * slots however its transport prefers, then constructs a snapshot from
 * the (slot-index → block-type) pairs.
 */

import type { BlockTypeName } from './blockTypes.js';

/**
 * Working-buffer block layout. One entry per slot (1..4); each entry is
 * the canonical block-type name placed there, or 'none' for an empty
 * slot. `placedBlocks` is a derived Set of unique placed block names for
 * fast `isBlockPlaced` lookup.
 *
 * AM4 enforces single-instance-per-type (no two slots hold the same
 * block type), so a Set is sufficient. Grid devices (II/III) need a
 * different snapshot shape — they ship their own helper.
 */
export interface BlockLayoutSnapshot {
  /** Slot 1..4 block-type name, 'none' for empty. */
  slots: readonly [BlockTypeName, BlockTypeName, BlockTypeName, BlockTypeName];
  /** Unique non-'none' block names from `slots`, for O(1) `isBlockPlaced` lookup. */
  placedBlocks: ReadonlySet<BlockTypeName>;
}

/**
 * Build a snapshot from a 4-element block-type array. Filters 'none'
 * out of `placedBlocks` so callers don't accidentally match an empty
 * slot when checking placement.
 */
export function buildBlockLayoutSnapshot(
  slots: readonly [BlockTypeName, BlockTypeName, BlockTypeName, BlockTypeName],
): BlockLayoutSnapshot {
  const placed = new Set<BlockTypeName>();
  for (const s of slots) {
    if (s !== 'none') placed.add(s);
  }
  return { slots, placedBlocks: placed };
}

/**
 * True when `block` is placed in any slot of the snapshot. Case-sensitive
 * (the snapshot uses canonical block names); the dispatcher resolves the
 * block name to canonical before calling this helper.
 */
export function isBlockPlaced(
  snapshot: BlockLayoutSnapshot,
  block: string,
): boolean {
  return snapshot.placedBlocks.has(block as BlockTypeName);
}
