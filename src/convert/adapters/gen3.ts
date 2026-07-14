/**
 * gen-3 (Axe-Fx III / FM9 / FM3) → IR adapter. The REFERENCE adapter: full
 * depth. Lifts the whole decoded preset body — routing grid (both the raw
 * grid-cell view and a derived series/parallel chain view), placed blocks with
 * per-scene channel + bypass state, and (for the amp block, the one family the
 * body decoder extracts named knob values for) per-knob params annotated with
 * cross-device concept keys.
 *
 * Input is a `Gen3PresetBody` (from `decodeGen3Body`) — optionally the richer
 * `Gen3DecodedPreset`, which additionally carries the preset name.
 */

import type {
  Gen3PresetBody,
  Gen3Block,
  Gen3GridCell,
} from '../../devices/gen3/presetBody.js';
import type { ConverterFamily, Gen3DeviceId } from '../families.js';
import { resolveFamily } from '../families.js';
import { conceptKeyForLocal } from '../conceptLookup.js';
import type {
  ConverterPreset,
  ConverterBlock,
  ConverterParam,
  ConverterGridCell,
} from '../ir.js';

/** gen-3 units carry 8 scenes. */
const GEN3_SCENE_COUNT = 8;
/** gen-3 amp knobs are scaled to a 0..10 display range by the body decoder. */
const AMP_KNOB_MAX = 10;
/** Safety cap on enumerated series chains (guards against pathological grids). */
const MAX_CHAINS = 256;

/** A `Gen3PresetBody` that may also carry the raw-patch preset name. */
type Gen3BodyLike = Gen3PresetBody & { preset_name?: string; model_id?: number };

/** Split an effect display name ("Vol/Pan 3") into its base + 1-based instance. */
function splitName(name: string): { base: string; instance: number } {
  const m = /^(.+?)\s+(\d+)$/.exec(name.trim());
  if (m) return { base: m[1], instance: Number.parseInt(m[2], 10) };
  return { base: name.trim(), instance: 1 };
}

/** Cell → { family, instance, key } identity (undefined family = unknown eid). */
interface CellInfo {
  cell: Gen3GridCell;
  family: ConverterFamily | undefined;
  instance: number;
  key: string | undefined;
}

function cellInfo(cell: Gen3GridCell): CellInfo {
  const { base, instance } = splitName(cell.name);
  const family = resolveFamily(base);
  return { cell, family, instance, key: family ? `${family}${instance}` : undefined };
}

/**
 * Build per-block channel + bypass state and (amp-only) params from a matched
 * body block.
 */
function liftBlockDetail(
  device: Gen3DeviceId,
  body: Gen3Block | undefined,
  family: ConverterFamily,
): Pick<ConverterBlock, 'typeName' | 'typeValue' | 'params' | 'channels' | 'bypassPerScene' | 'liftedFrom'> {
  if (body === undefined) {
    return { params: [], liftedFrom: 'partial-decode' };
  }

  const params: ConverterParam[] = [];
  let liftedFrom: ConverterBlock['liftedFrom'] = 'partial-decode';

  // Amp: the body decoder extracts named, scaled per-channel knobs. Lift
  // channel A as the block's params, annotated with concept keys where the
  // registry knows them.
  if (family === 'amp' && body.channels?.A) {
    liftedFrom = 'full-decode';
    for (const [nativeName, raw] of Object.entries(body.channels.A)) {
      if (nativeName === 'type' || nativeName === 'type_id') continue;
      if (typeof raw !== 'number') continue;
      params.push({
        nativeName,
        conceptKey: conceptKeyForLocal(device, 'amp', nativeName),
        value: raw,
        normalized: Math.max(0, Math.min(1, raw / AMP_KNOB_MAX)),
        displayValue: String(raw),
      });
    }
  } else if (body.channels) {
    // Non-amp blocks with per-channel type decode (per-scene type swaps).
    liftedFrom = 'full-decode';
  }

  // Type name/value: prefer the block-level type; fall back to channel A's
  // type for per-channel blocks (FM3/FM9 amp + per-channel type blocks store
  // the type per channel, not at the block header).
  let typeName = body.type;
  let typeValue = body.type_id;
  if (typeName === undefined && body.channels?.A) {
    const chAType = body.channels.A.type;
    const chATypeId = body.channels.A.type_id;
    if (typeof chAType === 'string') typeName = chAType;
    if (typeof chATypeId === 'number') typeValue = chATypeId;
  }

  // Channel state from the per-scene channel-letter array.
  let channels: ConverterBlock['channels'];
  if (body.scene_channels && body.scene_channels.length > 0) {
    const perScene = body.scene_channels.map((c) => {
      const idx = 'ABCD'.indexOf(c.toUpperCase());
      return idx >= 0 ? idx : 0;
    });
    channels = { count: new Set(perScene).size, perScene };
  }

  return {
    typeName,
    typeValue,
    params,
    channels,
    bypassPerScene: body.scene_bypass ? [...body.scene_bypass] : undefined,
    liftedFrom,
  };
}

/**
 * Derive series/parallel chains from the grid. Walks the left→right DAG: an
 * occupied cell at column `c` with `from_rows=[r..]` is fed by the occupied
 * cells at those rows in column `c-1`. Emits every source→sink path as its own
 * chain; shunts are traversed for connectivity but never appear as chain
 * entries (they are routing-only). Chain entries are block keys.
 */
function deriveSeriesChains(cells: readonly CellInfo[]): string[][] {
  const byPos = new Map<string, CellInfo>();
  for (const ci of cells) byPos.set(`${ci.cell.row},${ci.cell.col}`, ci);

  // Adjacency: cell -> successors (cells it feeds).
  const succ = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const ci of cells) {
    const c = ci.cell.col;
    if (c === 0 || !ci.cell.from_rows) continue;
    for (const pr of ci.cell.from_rows) {
      const predKey = `${pr},${c - 1}`;
      if (!byPos.has(predKey)) continue;
      (succ.get(predKey) ?? succ.set(predKey, []).get(predKey)!).push(`${ci.cell.row},${c}`);
      hasIncoming.add(`${ci.cell.row},${c}`);
    }
  }

  const sources = cells
    .map((ci) => `${ci.cell.row},${ci.cell.col}`)
    .filter((p) => !hasIncoming.has(p))
    .sort();

  const chains: string[][] = [];
  const keyOf = (pos: string): string | undefined => {
    const ci = byPos.get(pos);
    return ci && !ci.cell.is_shunt ? ci.key : undefined;
  };

  const walk = (pos: string, acc: string[]): void => {
    if (chains.length >= MAX_CHAINS) return;
    const k = keyOf(pos);
    const next = k ? [...acc, k] : acc; // skip shunts, keep traversing
    const outs = succ.get(pos);
    if (!outs || outs.length === 0) {
      if (next.length > 0) chains.push(next);
      return;
    }
    for (const o of outs) walk(o, next);
  };

  for (const s of sources) walk(s, []);
  return chains;
}

/**
 * Lift a decoded gen-3 preset body into the device-agnostic IR.
 *
 * @param body   `decodeGen3Body(...)` output (or a `Gen3DecodedPreset`).
 * @param device which gen-3 model the body was decoded for.
 */
export function liftGen3Preset(body: Gen3BodyLike, device: Gen3DeviceId): ConverterPreset {
  const grid = body.grid ?? [];
  const infos = grid.map(cellInfo);
  const blockInfos = infos.filter((ci) => !ci.cell.is_shunt && ci.family !== undefined);

  // Match body blocks to grid block cells by family, in instance / walk order.
  const bodyByFamily = new Map<ConverterFamily, Gen3Block[]>();
  for (const b of body.blocks ?? []) {
    const fam = resolveFamily(b.block);
    if (!fam) continue;
    const list = bodyByFamily.get(fam) ?? [];
    list.push(b);
    bodyByFamily.set(fam, list);
  }
  const matched = new Map<CellInfo, Gen3Block | undefined>();
  const byFamilyCells = new Map<ConverterFamily, CellInfo[]>();
  for (const ci of blockInfos) {
    const list = byFamilyCells.get(ci.family!) ?? [];
    list.push(ci);
    byFamilyCells.set(ci.family!, list);
  }
  for (const [fam, list] of byFamilyCells) {
    const sorted = [...list].sort((a, b) => a.instance - b.instance);
    const bodies = bodyByFamily.get(fam) ?? [];
    sorted.forEach((ci, i) => matched.set(ci, bodies[i]));
  }

  const blocks: ConverterBlock[] = blockInfos.map((ci) => {
    const detail = liftBlockDetail(device, matched.get(ci), ci.family!);
    return {
      key: ci.key!,
      family: ci.family!,
      instance: ci.instance,
      position: { row: ci.cell.row, col: ci.cell.col },
      ...detail,
    };
  });

  const gridCells: ConverterGridCell[] = infos.map((ci) => ({
    row: ci.cell.row,
    col: ci.cell.col,
    effectId: ci.cell.effect_id,
    name: ci.cell.name,
    blockKey: ci.cell.is_shunt ? undefined : ci.key,
    isShunt: Boolean(ci.cell.is_shunt),
    routeFlag: ci.cell.route_flag,
    fromRows: ci.cell.from_rows ? [...ci.cell.from_rows] : undefined,
  }));

  const sceneNames = body.scene_names ? [...body.scene_names] : undefined;
  const sceneCount = sceneNames?.length ?? GEN3_SCENE_COUNT;

  return {
    sourceDevice: device,
    name: body.preset_name ?? '',
    sceneNames,
    sceneCount,
    blocks,
    routing: {
      gridCells,
      seriesChains: deriveSeriesChains(infos),
    },
    decodeDepth: 'full',
    meta: body.model_id !== undefined ? { modelByte: body.model_id } : undefined,
  };
}
