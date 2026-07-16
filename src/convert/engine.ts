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
import { resolveTargetRange, resolveTargetEnumOptions, targetParamId, targetParamIdByName } from './targetRanges.js';
import {
  resolveConceptKey,
  normalizeConceptPort,
} from '../core/protocol-generic/concept-keys.js';
import type { ConversionEvent } from './events.js';
import { assignFm3GridEffectIds, type SynthPreset } from '../devices/gen3/presetSynth.js';

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

/** Devices whose amp block carries an INTEGRATED cab (no standalone cab slot). On these, a source cab
 *  folds into the amp block rather than being dropped as unavailable. AM4's amp bundles the cab (its
 *  integrated cab lives at the amp's block-type base + 4). */
function ampIntegratesCab(device: ConverterDeviceId): boolean {
  return device === 'am4';
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
  // Integrated-cab devices (AM4): the amp block bundles the cab, so a source cab is NOT missing — it
  // folds into the amp block (recorded as block-merged, an info event, not a loss). Only when there is
  // no amp to host it does the cab fall through to the family-missing drop below.
  if (ampIntegratesCab(targetDevice)) {
    const host = blocks.find((b) => b.family === 'amp');
    if (host) {
      blocks = blocks.filter((b) => {
        if (b.family === 'cab') {
          events.push({ kind: 'block-merged', blockKey: b.key, family: 'cab', intoFamily: 'amp', intoBlockKey: host.key });
          return false;
        }
        return true;
      });
    }
  }

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
  // A grid has a hard cell budget, so blocks beyond it are a genuine loss and get dropped here.
  // Slot/chain devices (AM4, VP4) are filled interactively in the editor: EVERY convertible block is
  // kept as a tray candidate and the user picks which of the few fixed slots to use — so we do NOT
  // pre-drop them to the slot count (that would silently choose for the user and report wanted
  // candidates as losses). An explicit opts.maxBlocks preview cap is still honored for any target.
  const isFixedSlots = topo.kind === 'slots' || topo.kind === 'chain';
  const deviceCapacity = topo.kind === 'grid' ? topo.rows * topo.cols : Number.MAX_SAFE_INTEGER;
  const capacity = Math.min(
    isFixedSlots ? Number.MAX_SAFE_INTEGER : deviceCapacity,
    opts.maxBlocks ?? Number.MAX_SAFE_INTEGER,
  );
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
        const enumOptions = resolveTargetEnumOptions(targetDevice, b.family, tgtName);
        if (range === undefined) {
          events.push({ kind: 'param-unverified', blockKey: b.key, nativeName: tgtName, value: p.value });
          mapped.push({
            nativeName: tgtName,
            conceptKey: p.conceptKey,
            value: p.value,
            displayValue: p.displayValue,
            ...(enumOptions ? { enumOptions } : {}),
          });
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
          min: range.min,
          max: range.max,
          ...(range.unit !== undefined ? { unit: range.unit } : {}),
          ...(range.log ? { log: true } : {}),
          ...(normalized !== undefined ? { normalized } : {}),
          displayValue: String(clamped),
          ...(enumOptions ? { enumOptions } : {}),
        });
      }
      b.params = mapped;
    }
  }
  // (lossless path keeps every param verbatim — nothing to do.)

  // ── 4b. Target paramId re-addressing ──────────────────────────────
  // A param's `paramId` is a DEVICE ADDRESS, and gen-3 paramIds are device-
  // specific (the same concept sits at a different id on FM3 / FM9 / III). Both
  // the lossless pass-through (which carries the SOURCE id verbatim) and the
  // mapped path (which produces params with NO id) must end with the id being
  // the TARGET's, so the authoring encoder can write the param directly by id
  // for EVERY source — not just when source == target.
  //
  // Same-device conversions already carry the target's own id verbatim, so they
  // are left untouched (this keeps the FM3→FM3 result byte-identical). For every
  // cross-device conversion, re-resolve each param to the target device's own id
  // and DROP the id for params the target does not expose — the author then skips
  // those honestly rather than poking a foreign address (`conceptKey`,
  // `normalized`, `value`, `nativeName`, `sharedName` are all left intact).
  //
  // Two resolution paths, concept-key FIRST then NAME-JOIN fallback:
  //   1. `targetParamId` — invert the param's cross-device CONCEPT key to the
  //      target's own id (curated, covers the common tone knobs; also handles
  //      enum/type selectors correctly).
  //   2. `targetParamIdByName` — for a param the concept registry does NOT cover,
  //      EXACT-match its shared catalog symbol (e.g. `PEQ_GAIN1`) against the
  //      target's own family table. gen-3 devices share the param NAME space, so
  //      this widens coverage from the ~few dozen concept knobs to the full set
  //      of CONTINUOUS params — while refusing ambiguous names, enum/type
  //      selectors, and synthetic ids (never guessing a foreign ordinal).
  if (source.sourceDevice !== targetDevice) {
    for (const b of blocks) {
      for (const p of b.params) {
        const tid =
          targetParamId(targetDevice, b.family, p.conceptKey) ??
          targetParamIdByName(targetDevice, b.family, p.sharedName);
        if (tid != null) p.paramId = tid;
        else if (p.paramId !== undefined) delete p.paramId;
      }
    }
  }

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

  // FM3 targets: assign the FM3 grid effect ids NOW (idempotent — same assignment the
  // synthesizer uses) so BOTH the /preset/convert response the Axis UI edits AND the
  // export IR carry distinct, stable per-cell eids. The Axis grid editor keys cells by
  // effectId; leaving cross-device cells unassigned collapsed every cell onto one block
  // (FORGEFXMID-43). Same-device (FM3→FM3) cells already carry source eids → untouched.
  if (targetDevice === 'fm3') {
    const addressed = assignFm3GridEffectIds(target as unknown as SynthPreset) as unknown as ConverterPreset;
    return { target: addressed, events };
  }

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

  // ── Target chain / slots: the user assigns blocks to the fixed slots in the editor ──
  // Slot/chain devices (AM4, VP4) expose a small, fixed number of ordered slots. Rather than
  // auto-pick which converted blocks win those slots, we leave every survivor UNPLACED (position
  // null) so it lands in the editor's tray, and the user chooses which slots to fill and in what
  // order. Slot capacity is therefore enforced interactively — overflow is NOT a loss here, so no
  // block-unplaced events are emitted for it (that would misreport wanted candidates as losses).
  const slots = topo.kind === 'chain' || topo.kind === 'slots' ? topo.slots : ordered.length;
  for (const b of ordered) b.position = undefined; // unplaced → the editor's tray (user assigns the slots)

  if (sourceGrid && srcTopo.kind === 'grid' && ordered.length > 0) {
    events.push({
      kind: 'routing-simplified',
      detail:
        topo.kind === 'chain'
          ? `grid re-mapped to a ${slots}-slot serial chain — choose which blocks to place`
          : `grid re-mapped to ${slots} single-instance slots — choose which blocks to place`,
      affectedBlockKeys: ordered.map((b) => b.key),
    });
  }

  return { blocks: ordered, seriesChains: [] };
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

/** Build grid cells from placed blocks, WITH series connectivity. Blocks were
 *  re-placed contiguously per row (`layoutToGrid`: col = index within the row), so
 *  each block past column 0 is fed from the SAME row of the previous column (the
 *  block placed before it in its row); column-0 blocks start the chain from the
 *  grid input (route_flag 0). route_flag is the device bitmask (parseGrid: bit r =
 *  fed from row r of the previous column), i.e. fromRows.reduce((m,r)=>m|(1<<r),0).
 *  This makes an unedited auto-conversion CONNECTED (a series per row) instead of a
 *  bare disconnected chain. NB rows are independent series from the input; parallel
 *  branches are NOT merged at the output here (a flattened re-placement) — the user
 *  can wire that in the editor, which the edited-IR export path carries verbatim. */
function buildGridCells(blocks: ConverterBlock[]): ConverterGridCell[] {
  const cells: ConverterGridCell[] = [];
  for (const b of blocks) {
    const pos = b.position;
    if (pos && 'row' in pos) {
      const fromRows = pos.col > 0 ? [pos.row] : [];
      cells.push({
        row: pos.row,
        col: pos.col,
        name: b.typeName ?? b.key,
        blockKey: b.key,
        isShunt: false,
        routeFlag: fromRows.reduce((m, r) => m | (1 << r), 0),
        fromRows: fromRows.length ? fromRows : undefined,
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
