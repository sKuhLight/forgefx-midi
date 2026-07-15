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
import {
  readBlockParamsForModel,
  gen3BlockParamModel,
  typeParamForFamily,
  hasBlockParamModel,
  type DecodedBlock,
  type Gen3BlockParamTables,
} from '../../devices/gen3/blockParams.js';
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
/** The device value model: continuous params + enum ordinals are stored as u16 0..65534. */
const VALUE_MODEL_MAX = 65534;
/**
 * paramIds at/above this floor are SYNTHETIC UI-only catalog entries (cab IR
 * pickers + name fields, the amp "Zero All" control), not real per-param body
 * slots — they live in the 0xFF00 range with no addressable body offset. The
 * generic reader tolerates them (bounds-safe reads → 0), but they must NOT be
 * carried as writable params: the authoring encoder addresses `header + 2*id`
 * and such an id overflows the body. Real body params are a dense low range.
 */
const SYNTHETIC_PARAM_ID_FLOOR = 0xff00;
/** Safety cap on enumerated series chains (guards against pathological grids). */
const MAX_CHAINS = 256;

/** Converter gen-3 device id → SysEx model byte (for `readBlockParams` calibration). */
const MODEL_BY_DEVICE: Readonly<Record<Gen3DeviceId, number>> = {
  'axe-fx-iii': 0x10,
  fm3: 0x11,
  fm9: 0x12,
};

/**
 * A `Gen3PresetBody` that may also carry the raw-patch preset name and the raw
 * DECOMPRESSED body bytes (present when lifted from `decodeGen3PresetDump`);
 * the latter drives the generic per-block param extraction below.
 */
type Gen3BodyLike = Gen3PresetBody & {
  preset_name?: string;
  model_id?: number;
  decompressed_body?: Uint8Array;
};

/** Catalog symbol → concept-registry local name: strip the `<FAMILY>_` prefix
 *  and lower-case (e.g. `DISTORT_DRIVE` → `drive`, `REVERB_TIME` → `time`). This
 *  is the form both the concept-key registry and the existing amp lift use. */
function localParamName(catalogName: string, catalogFamily: string): string {
  const pfx = `${catalogFamily}_`;
  const base = catalogName.startsWith(pfx) ? catalogName.slice(pfx.length) : catalogName;
  return base.toLowerCase();
}

/**
 * Lift one decoded block's generic params into IR params. Carries the codec
 * `paramId` VERBATIM (the device address — enables the high-fidelity same-
 * generation authoring write), the concept key when the registry knows one, the
 * decoded display `value`, and `normalized = raw/65534` so the author's
 * `valueToRaw` reproduces the EXACT stored raw (enum ordinals included). The
 * single TYPE/model selector param is skipped — the block's type is carried
 * separately as `typeName`/`typeValue` and written by the type path.
 */
function liftParams(
  device: Gen3DeviceId,
  family: ConverterFamily,
  decoded: DecodedBlock,
  typePid: number | null,
): ConverterParam[] {
  const out: ConverterParam[] = [];
  for (const p of decoded.params) {
    if (typePid != null && p.paramId === typePid) continue;
    if (p.paramId >= SYNTHETIC_PARAM_ID_FLOOR) continue; // UI-only pseudo param, not a writable body slot
    const nativeName = localParamName(p.name, decoded.family);
    const conceptKey = conceptKeyForLocal(device, family, nativeName);
    out.push({
      paramId: p.paramId,
      nativeName,
      // The full catalog symbol (e.g. `DISTORT_DRIVE`) — gen-3 devices share this
      // name space, so it is the exact key a cross-device name-join matches on.
      sharedName: p.name,
      ...(conceptKey ? { conceptKey } : {}),
      value: p.value ?? p.raw,
      normalized: p.raw / VALUE_MODEL_MAX,
      ...(p.enumLabel ? { displayValue: p.enumLabel } : {}),
    });
  }
  return out;
}

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
 * Build per-block channel + bypass state, type identity, and (for calibrated
 * families) full per-block params from a matched body block + its decoded param
 * set. Params are sourced from the generic decoder (`readBlockParams`) for ALL
 * families it calibrates — not amp only. Uncalibrated families yield no decoded
 * block → params stay empty (never fabricated).
 */
function liftBlockDetail(
  device: Gen3DeviceId,
  body: Gen3Block | undefined,
  family: ConverterFamily,
  decoded: DecodedBlock | undefined,
  typePid: number | null,
): Pick<ConverterBlock, 'typeName' | 'typeValue' | 'params' | 'channels' | 'bypassPerScene' | 'liftedFrom'> {
  const params: ConverterParam[] = decoded ? liftParams(device, family, decoded, typePid) : [];

  if (body === undefined) {
    return { params, liftedFrom: params.length > 0 ? 'full-decode' : 'partial-decode' };
  }

  // Full-decode when we extracted generic params, or (fallback) when the walk
  // decoded per-channel type state (per-scene type swaps).
  const liftedFrom: ConverterBlock['liftedFrom'] =
    params.length > 0 || body.channels ? 'full-decode' : 'partial-decode';

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

  // Generic per-block param extraction (`readBlockParams`) over the raw
  // decompressed body, keyed by grid effect id. Only runs for a CALIBRATED
  // model (FM3 hardware / FM9+III community-beta) and only when the dump carried
  // the body bytes; otherwise the lift stays structure-only (empty params) —
  // the calibration boundary is respected, never bypassed with foreign tables.
  const modelId = MODEL_BY_DEVICE[device];
  const decodedByEid = new Map<number, DecodedBlock>();
  let paramTables: Gen3BlockParamTables | undefined;
  const rawBody = body.decompressed_body;
  if (rawBody && rawBody.length > 0 && hasBlockParamModel(modelId)) {
    try {
      paramTables = gen3BlockParamModel(modelId).tables;
      const placedEids = new Set<number>(
        infos.filter((ci) => !ci.cell.is_shunt && ci.cell.effect_id > 0).map((ci) => ci.cell.effect_id),
      );
      for (const db of readBlockParamsForModel(rawBody, placedEids, modelId)) {
        // Amp emits one decoded block per channel A-D; keep channel A (0) as the
        // block's params (mirrors the prior amp lift). Non-amp blocks have no channel.
        if (db.channel != null && db.channel !== 0) continue;
        if (!decodedByEid.has(db.effectId)) decodedByEid.set(db.effectId, db);
      }
    } catch {
      // Uncalibrated model / extraction failure → structure-only lift (no generic params).
      paramTables = undefined;
      decodedByEid.clear();
    }
  }

  const blocks: ConverterBlock[] = blockInfos.map((ci) => {
    const decoded = decodedByEid.get(ci.cell.effect_id);
    const typePid = paramTables && decoded ? typeParamForFamily(paramTables, decoded.family) : null;
    const detail = liftBlockDetail(device, matched.get(ci), ci.family!, decoded, typePid);
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
