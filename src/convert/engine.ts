/**
 * Cross-device preset conversion engine (P2).
 *
 * `convertPreset(source, targetDevice, opts?)` lowers a device-agnostic
 * `ConverterPreset` (lifted by a P0 adapter) onto a chosen target device,
 * best-effort, and returns the target IR alongside an ordered list of
 * `ConversionEvent`s describing every lossy or approximate decision. The
 * pipeline is DETERMINISTIC and PURE: the same input always yields the same
 * output, and the source preset is never mutated. No `Date`, no `Math.random`.
 *
 * Pipeline (see `docs/PRESET-CONVERTER-IR.md § Conversion engine`):
 *   0. source-partial caveat (when the source wasn't fully decoded).
 *   1. family presence + target instancing.
 *   2. capacity (drop lowest-priority overflow).
 *   3. type/model mapping via the lineage index.
 *   4. param mapping via concept keys + target range validation.
 *   5. routing / placement onto the target topology.
 *   6. scene + per-block channel collapse.
 *   7. assemble the target IR (source device preserved; convertedFrom/To meta).
 */

import {
  type ConverterDeviceId,
  type ConverterFamily,
  deviceTopology,
  familyPresence,
  deviceSceneCount,
  deviceChannelCount,
  sharesTypeRoster,
} from './families.js';
import type {
  ConverterPreset,
  ConverterBlock,
  ConverterParam,
  ConverterGridCell,
} from './ir.js';
import { matchModel, modelOnDevice, type LineageMatch } from './lineageIndex.js';
import { resolveTargetRange } from './targetRanges.js';
import {
  resolveConceptKey,
  normalizeConceptPort,
} from '../core/protocol-generic/concept-keys.js';
import type { ConversionEvent } from './events.js';

// ── Public API ───────────────────────────────────────────────────────

/** Options controlling a conversion. */
export interface ConvertOptions {
  /**
   * Hard cap on how many blocks the target may carry, applied on top of the
   * device's own capacity. Useful for UI previews. Default: the device
   * capacity.
   */
  maxBlocks?: number;
  /**
   * When a block's type cannot be resolved on the target (no roster data),
   * KEEP the block with an undefined `typeName` and emit `type-unresolved`
   * (default `true`) so the fake-grid can offer a picker. When `false`, the
   * block is removed (still emits `type-unresolved`, plus `block-unplaced`).
   */
  keepUnresolvedTypes?: boolean;
}

/** The result of a conversion. */
export interface ConversionResult {
  target: ConverterPreset;
  events: ConversionEvent[];
}

/**
 * Block-family priority, highest first. Drives capacity/overflow decisions:
 * when the target can't host every block, the LOWEST-priority ones are dropped
 * so the amp core survives. Families not listed rank below all listed ones and
 * fall back to source signal order for a stable tiebreak. Exported so the
 * ForgeFX/Axis layers can present the same ordering.
 */
export const FAMILY_PRIORITY: readonly ConverterFamily[] = [
  'amp',
  'cab',
  'drive',
  'delay',
  'reverb',
  'pitch',
  'compressor',
];

function priorityRank(family: ConverterFamily): number {
  const i = FAMILY_PRIORITY.indexOf(family);
  return i < 0 ? FAMILY_PRIORITY.length : i;
}

// ── Small helpers ────────────────────────────────────────────────────

/** Deep-ish clone of a block (arrays copied so the source is never mutated). */
function cloneBlock(b: ConverterBlock): ConverterBlock {
  return {
    ...b,
    params: b.params.map((p) => ({ ...p })),
    channels: b.channels
      ? { count: b.channels.count, perScene: b.channels.perScene ? [...b.channels.perScene] : undefined }
      : undefined,
    bypassPerScene: b.bypassPerScene ? [...b.bypassPerScene] : undefined,
    position: b.position ? { ...b.position } : undefined,
  };
}

/** Block keys in SOURCE signal order (series chains first, then leftovers). */
function signalOrder(preset: ConverterPreset): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chain of preset.routing.seriesChains) {
    for (const k of chain) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  for (const b of preset.blocks) {
    if (!seen.has(b.key)) {
      seen.add(b.key);
      out.push(b.key);
    }
  }
  return out;
}

/** True when two devices share one concept-key param vocabulary column. */
function sameVocabulary(a: ConverterDeviceId, b: ConverterDeviceId): boolean {
  const pa = normalizeConceptPort(a);
  const pb = normalizeConceptPort(b);
  return pa !== undefined && pa === pb;
}

// ── Engine ───────────────────────────────────────────────────────────

/**
 * Convert `source` onto `targetDevice`. Returns the target IR and the ordered
 * event log. Pure + deterministic.
 */
export function convertPreset(
  source: ConverterPreset,
  targetDevice: ConverterDeviceId,
  opts: ConvertOptions = {},
): ConversionResult {
  const keepUnresolvedTypes = opts.keepUnresolvedTypes ?? true;
  const events: ConversionEvent[] = [];

  const orderIndex = new Map<string, number>();
  signalOrder(source).forEach((k, i) => orderIndex.set(k, i));
  const idxOf = (key: string): number => orderIndex.get(key) ?? Number.MAX_SAFE_INTEGER;

  // ── 0. Source-partial caveat ──────────────────────────────────────
  if (source.decodeDepth !== 'full') {
    events.push({
      kind: 'source-partial',
      decodeDepth: source.decodeDepth,
      detail: `source ${source.sourceDevice} preset decoded at '${source.decodeDepth}' depth; converted fields are limited to what the source exposed`,
    });
  }

  // Working set: cloned blocks in source signal order.
  let blocks: ConverterBlock[] = [...source.blocks]
    .sort((a, b) => idxOf(a.key) - idxOf(b.key))
    .map(cloneBlock);

  // ── 1. Family presence + target instancing ────────────────────────
  const presence = familyPresence(targetDevice);
  blocks = blocks.filter((b) => {
    if (!presence.has(b.family)) {
      events.push({ kind: 'block-dropped', blockKey: b.key, family: b.family, reason: 'family-missing' });
      return false;
    }
    return true;
  });

  const topo = deviceTopology(targetDevice);
  if (topo.kind === 'slots' && topo.instancing === 'single-per-family') {
    const kept = new Set<ConverterFamily>();
    blocks = blocks.filter((b) => {
      if (kept.has(b.family)) {
        events.push({ kind: 'block-dropped', blockKey: b.key, family: b.family, reason: 'instance-limit' });
        return false;
      }
      kept.add(b.family);
      return true;
    });
  }

  // ── 2. Capacity ───────────────────────────────────────────────────
  const deviceCapacity =
    topo.kind === 'grid' ? topo.rows * topo.cols : topo.kind === 'slots' ? topo.slots : topo.kind === 'chain' ? topo.slots : Number.MAX_SAFE_INTEGER;
  const capacity = Math.min(deviceCapacity, opts.maxBlocks ?? Number.MAX_SAFE_INTEGER);
  if (blocks.length > capacity) {
    // Rank by (priority asc, signal-order asc); keep the top `capacity`.
    const ranked = [...blocks].sort((a, b) => {
      const pr = priorityRank(a.family) - priorityRank(b.family);
      return pr !== 0 ? pr : idxOf(a.key) - idxOf(b.key);
    });
    const keep = new Set(ranked.slice(0, capacity).map((b) => b.key));
    for (const b of blocks) {
      if (!keep.has(b.key)) {
        events.push({ kind: 'block-dropped', blockKey: b.key, family: b.family, reason: 'capacity-exceeded' });
      }
    }
    blocks = blocks.filter((b) => keep.has(b.key));
  }

  // ── 3. Type / model mapping ───────────────────────────────────────
  // Shared-roster short-circuit: when source and target run the same
  // block/type vocabulary (gen-3 trio + VP4), types transfer VERBATIM with
  // ZERO type events — same rationale as the param pass-through. The one
  // exception: the target's (reduced) roster verifiably lacks the specific
  // model (`modelOnDevice` = 'absent') → normal matchModel path below. With
  // no roster data to check ('unknown'), the shared codec is trusted.
  const sharedRoster = sharesTypeRoster(source.sourceDevice, targetDevice);
  const unresolvedForRemoval = new Set<string>();
  for (const b of blocks) {
    if (sharedRoster) {
      if (b.typeName === undefined) continue; // same codec — nothing to re-pick.
      if (modelOnDevice(b.family, b.typeName, targetDevice) !== 'absent') continue;
      // verifiably absent on the reduced target roster → fall through to matchModel.
    }
    if (b.typeName === undefined) {
      // Nothing to match against (source never decoded a type).
      events.push({ kind: 'type-unresolved', blockKey: b.key, family: b.family, sourceTypeName: '' });
      if (!keepUnresolvedTypes) unresolvedForRemoval.add(b.key);
      continue;
    }
    const matches: LineageMatch[] = matchModel(
      { device: source.sourceDevice, family: b.family, typeName: b.typeName, typeValue: b.typeValue },
      targetDevice,
    );
    if (matches.length === 0) {
      events.push({ kind: 'type-unresolved', blockKey: b.key, family: b.family, sourceTypeName: b.typeName });
      if (!keepUnresolvedTypes) unresolvedForRemoval.add(b.key);
      else b.typeName = undefined; // keep the block; let the picker resolve it.
      b.typeValue = undefined;
      continue;
    }
    const best = matches[0];
    events.push({
      kind: 'type-substituted',
      blockKey: b.key,
      family: b.family,
      sourceTypeName: b.typeName,
      targetTypeName: best.targetTypeName,
      confidence: best.confidence,
      ...(best.score !== undefined ? { score: best.score } : {}),
    });
    b.typeName = best.targetTypeName;
    b.typeValue = best.targetTypeValue;
  }
  if (unresolvedForRemoval.size > 0) {
    for (const b of blocks) {
      if (unresolvedForRemoval.has(b.key)) {
        events.push({ kind: 'block-unplaced', blockKey: b.key, family: b.family, reason: 'type unresolved and keepUnresolvedTypes=false' });
      }
    }
    blocks = blocks.filter((b) => !unresolvedForRemoval.has(b.key));
  }

  // ── 4. Param mapping ──────────────────────────────────────────────
  const lossless = sameVocabulary(source.sourceDevice, targetDevice);
  if (!lossless) {
    for (const b of blocks) {
      const mapped: ConverterParam[] = [];
      for (const p of b.params) {
        if (p.conceptKey === undefined) {
          events.push({ kind: 'param-dropped', blockKey: b.key, nativeName: p.nativeName, reason: 'no-concept-mapping' });
          continue;
        }
        const resolved = resolveConceptKey(targetDevice, p.conceptKey);
        if (resolved === undefined) {
          events.push({ kind: 'param-dropped', blockKey: b.key, nativeName: p.nativeName, reason: 'target-lacks-param' });
          continue;
        }
        const tgtName = resolved.localName;
        const range = resolveTargetRange(targetDevice, b.family, tgtName);
        if (range === undefined) {
          events.push({ kind: 'param-unverified', blockKey: b.key, nativeName: tgtName, value: p.value });
          mapped.push({ nativeName: tgtName, conceptKey: p.conceptKey, value: p.value, displayValue: p.displayValue });
          continue;
        }
        const clamped = Math.min(range.max, Math.max(range.min, p.value));
        if (clamped !== p.value) {
          events.push({
            kind: 'param-clamped',
            blockKey: b.key,
            nativeName: tgtName,
            conceptKey: p.conceptKey,
            sourceValue: p.value,
            targetValue: clamped,
            targetMin: range.min,
            targetMax: range.max,
          });
        }
        const normalized = range.max !== range.min ? (clamped - range.min) / (range.max - range.min) : undefined;
        mapped.push({
          nativeName: tgtName,
          conceptKey: p.conceptKey,
          value: clamped,
          ...(normalized !== undefined ? { normalized } : {}),
          displayValue: String(clamped),
        });
      }
      b.params = mapped;
    }
  }
  // (lossless path keeps every param verbatim — nothing to do.)

  // ── 5. Routing / placement ────────────────────────────────────────
  const placed = placeBlocks(source, blocks, targetDevice, topo, idxOf, events);
  blocks = placed.blocks;

  // ── 6. Scene + channel collapse ───────────────────────────────────
  const targetScenes = deviceSceneCount(targetDevice);
  const effectiveScenes = Math.min(source.sceneCount, targetScenes);
  let sceneNames = source.sceneNames ? [...source.sceneNames] : undefined;
  if (source.sceneCount > targetScenes) {
    events.push({ kind: 'scene-collapsed', sourceScenes: source.sceneCount, targetScenes });
    if (sceneNames) sceneNames = sceneNames.slice(0, targetScenes);
    for (const b of blocks) {
      if (b.bypassPerScene) b.bypassPerScene = b.bypassPerScene.slice(0, targetScenes);
      if (b.channels?.perScene) b.channels.perScene = b.channels.perScene.slice(0, targetScenes);
    }
  }

  const targetChannels = deviceChannelCount(targetDevice);
  for (const b of blocks) {
    if (b.channels && b.channels.count > targetChannels) {
      events.push({ kind: 'channel-collapsed', blockKey: b.key, sourceChannels: b.channels.count, targetChannels });
      b.channels.count = targetChannels;
      if (b.channels.perScene) {
        b.channels.perScene = b.channels.perScene.map((c) => Math.min(c, targetChannels - 1));
      }
    }
  }

  // ── 7. Assemble the target IR ─────────────────────────────────────
  const meta: NonNullable<ConverterPreset['meta']> = {
    ...(source.meta ?? {}),
    convertedFrom: source.sourceDevice,
    convertedTo: targetDevice,
  };

  const target: ConverterPreset = {
    sourceDevice: source.sourceDevice, // ORIGINAL source preserved for provenance.
    name: source.name,
    sceneNames,
    sceneCount: effectiveScenes,
    blocks,
    routing: { gridCells: placed.gridCells, seriesChains: placed.seriesChains },
    decodeDepth: source.decodeDepth,
    meta,
  };

  return { target, events };
}

// ── Placement ────────────────────────────────────────────────────────

interface PlacementResult {
  blocks: ConverterBlock[];
  gridCells?: ConverterGridCell[];
  seriesChains: string[][];
}

/**
 * Place the surviving blocks onto the target topology, mutating each block's
 * `position` and producing the target routing views. Emits `routing-simplified`
 * when structure is flattened and `block-unplaced` for any block with no free
 * position (those are removed from the returned block list).
 */
function placeBlocks(
  source: ConverterPreset,
  survivors: ConverterBlock[],
  targetDevice: ConverterDeviceId,
  topo: ReturnType<typeof deviceTopology>,
  idxOf: (key: string) => number,
  events: ConversionEvent[],
): PlacementResult {
  const byKey = new Map(survivors.map((b) => [b.key, b]));
  const survivorKeys = new Set(byKey.keys());
  const sourceGrid = source.routing.gridCells;
  const srcTopo = deviceTopology(source.sourceDevice);

  const ordered = [...survivors].sort((a, b) => idxOf(a.key) - idxOf(b.key));

  // ── Target grid ──
  if (topo.kind === 'grid') {
    // Upsize / same-size grid→grid: keep the source layout verbatim (lossless).
    if (
      sourceGrid &&
      srcTopo.kind === 'grid' &&
      topo.rows >= srcTopo.rows &&
      topo.cols >= srcTopo.cols
    ) {
      const gridCells = sourceGrid.filter((c) => c.isShunt || (c.blockKey !== undefined && survivorKeys.has(c.blockKey)));
      const seriesChains = source.routing.seriesChains
        .map((ch) => ch.filter((k) => survivorKeys.has(k)))
        .filter((ch) => ch.length > 0);
      return { blocks: ordered, gridCells, seriesChains };
    }

    // Down-size grid→grid: re-lay from the source chains, row by row.
    // Non-grid source → grid: single row.
    let rowLayouts: string[][];
    let simplified = false;
    if (sourceGrid && srcTopo.kind === 'grid') {
      rowLayouts = chainsToRows(source, survivorKeys);
      simplified = true;
    } else {
      rowLayouts = [ordered.map((b) => b.key)];
      simplified = false; // expanding a linear source into a grid loses nothing.
    }

    const { seriesChains, unplaced } = layoutToGrid(rowLayouts, byKey, topo.rows, topo.cols);
    emitUnplaced(unplaced, byKey, events, `target grid ${topo.rows}x${topo.cols} has no free cell`);

    const placedKeys = new Set(seriesChains.flat());
    const placedBlocks = ordered.filter((b) => placedKeys.has(b.key));
    if (simplified && placedBlocks.length > 0) {
      events.push({
        kind: 'routing-simplified',
        detail: `source grid ${srcTopo.kind === 'grid' ? `${srcTopo.rows}x${srcTopo.cols}` : '?'} re-placed onto ${topo.rows}x${topo.cols}; parallel branches flattened to series rows`,
        affectedBlockKeys: [...placedKeys],
      });
    }
    const gridCells = buildGridCells(placedBlocks);
    return { blocks: placedBlocks, gridCells, seriesChains };
  }

  // ── Target chain / slots: a single serial line ──
  const slots = topo.kind === 'chain' ? topo.slots : topo.kind === 'slots' ? topo.slots : ordered.length;
  const kept: ConverterBlock[] = [];
  const unplaced: string[] = [];
  ordered.forEach((b, i) => {
    if (i < slots) {
      b.position = { slot: i };
      kept.push(b);
    } else {
      unplaced.push(b.key);
    }
  });
  emitUnplaced(unplaced, byKey, events, `target has only ${slots} slots`);

  if (sourceGrid && srcTopo.kind === 'grid' && kept.length > 0) {
    events.push({
      kind: 'routing-simplified',
      detail:
        topo.kind === 'chain'
          ? `grid flattened to a ${slots}-slot serial chain`
          : `grid flattened to single-instance slots`,
      affectedBlockKeys: kept.map((b) => b.key),
    });
  }

  return { blocks: kept, seriesChains: kept.length > 0 ? [kept.map((b) => b.key)] : [] };
}

/**
 * Turn the source series chains into rows of survivor keys. Longest chain
 * first (so the main signal path lands in row 0 intact); each subsequent chain
 * contributes only blocks not already placed. Blocks in no chain become a
 * trailing row.
 */
function chainsToRows(source: ConverterPreset, survivorKeys: Set<string>): string[][] {
  const chains = source.routing.seriesChains
    .map((ch, i) => ({ ch: ch.filter((k) => survivorKeys.has(k)), i }))
    .filter((x) => x.ch.length > 0)
    .sort((a, b) => (b.ch.length - a.ch.length) || (a.i - b.i));

  const rows: string[][] = [];
  const placed = new Set<string>();
  for (const { ch } of chains) {
    const row = ch.filter((k) => !placed.has(k));
    if (row.length === 0) continue;
    for (const k of row) placed.add(k);
    rows.push(row);
  }
  const leftover = [...survivorKeys].filter((k) => !placed.has(k));
  if (leftover.length > 0) rows.push(leftover);
  return rows;
}

/** Assign rows/cols to a row layout; return series chains + unplaced keys. */
function layoutToGrid(
  rowLayouts: string[][],
  byKey: Map<string, ConverterBlock>,
  rows: number,
  cols: number,
): { seriesChains: string[][]; unplaced: string[] } {
  const seriesChains: string[][] = [];
  const unplaced: string[] = [];
  rowLayouts.forEach((row, r) => {
    if (r >= rows) {
      unplaced.push(...row);
      return;
    }
    const chain: string[] = [];
    row.forEach((key, c) => {
      const b = byKey.get(key);
      if (!b) return;
      if (c >= cols) {
        unplaced.push(key);
        return;
      }
      b.position = { row: r, col: c };
      chain.push(key);
    });
    if (chain.length > 0) seriesChains.push(chain);
  });
  return { seriesChains, unplaced };
}

/** Build minimal grid cells from placed blocks (shunts are not synthesized). */
function buildGridCells(blocks: ConverterBlock[]): ConverterGridCell[] {
  const cells: ConverterGridCell[] = [];
  for (const b of blocks) {
    const pos = b.position;
    if (pos && 'row' in pos) {
      cells.push({
        row: pos.row,
        col: pos.col,
        name: b.typeName ?? b.key,
        blockKey: b.key,
        isShunt: false,
      });
    }
  }
  return cells;
}

function emitUnplaced(
  keys: string[],
  byKey: Map<string, ConverterBlock>,
  events: ConversionEvent[],
  reason: string,
): void {
  for (const k of keys) {
    const b = byKey.get(k);
    if (b) events.push({ kind: 'block-unplaced', blockKey: k, family: b.family, reason });
  }
}
