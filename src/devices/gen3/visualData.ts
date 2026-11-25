/**
 * Gen-3 per-block visual data descriptors.
 *
 * A block page draws three kinds of live data:
 *
 *   - the device curve: `fn 0x01 sub 0x23 (effectId, graphIndex)` — the 512-byte
 *     float32 container, fetched on graph-state change (not polled);
 *   - marker positions: `fn 0x01 sub 0x19 (effectId, markerPid)` — a normalized
 *     0..1 X position, polled while the page is open;
 *   - meters: `fn 0x01 sub 0x19 (effectId, monitorPid)` — a normalized 0..1 level
 *     (or RMS energy for the output VU) mapped onto the widget's dB span.
 *
 * This module only names those bindings and delegates every frame to the
 * existing builders/parsers in `gen3/axe-fx-iii/telemetry.ts`; it does not
 * compute curves or touch rendering.
 *
 * Marker and meter pids are device-specific. `LOOPER_STOP` is bound as the
 * Looper graph's marker but carries the loop playhead position, not a stop
 * flag. Only the marker symbols in `MARKER_PIDS` are ever polled as graph
 * markers.
 */

import {
  GRAPH_CURVE_SLOTS,
  SUB_GRAPH_CURVE,
  buildBlockMonitorPoll,
  buildGraphCurvePoll,
  isBlockMonitorResponse,
  isGraphCurveResponse,
  parseBlockMonitorNorm,
  parseGraphCurve,
} from '../../gen3/axe-fx-iii/telemetry.js';
import { AXE3_MONITOR_PARAMS } from '../../gen3/axe-fx-iii/meters.js';
import { FM3_MONITOR_PARAMS } from '../../gen3/fm3/meters.js';
import { FM9_MONITOR_PARAMS } from '../../gen3/fm9/meters.js';
import { FRACTAL_MODEL_BYTES } from '../../shared/effectId.js';

/** Models whose marker/meter pids are known. VP4 has no confirmed live telemetry. */
export type Gen3VisualModel = 'fm3' | 'fm9' | 'iii';

/** Wire value meaning of a `sub 0x19` visual read. */
export type Gen3VisualEncoding =
  /** normalized 0..1 level, mapped onto the widget's dB span */
  | 'normalized'
  /** RMS energy (≈0..8), displayed as 10·log10 */
  | 'rms'
  /** normalized 0..1 position along the graph's X axis */
  | 'position';

export interface Gen3VisualParamDef {
  /** Catalog parameter symbol (`COMP_GAINMONITOR`, `COMP_XMARK`, ...). */
  name: string;
  /** Block-local param id on the wire. */
  pid: number;
  role: 'meter' | 'marker';
  /** Meter scale endpoints in dB (role `meter` only, where the widget states them). */
  minDb?: number;
  maxDb?: number;
  encoding: Gen3VisualEncoding;
  /** Why the param is polled, when its name is misleading. */
  note?: string;
  /** false = the pid is confirmed but its widget wiring is inferred. */
  widgetConfirmed: boolean;
}

export interface Gen3BlockVisual {
  /** Catalog family symbol (`COMP`, `CABINET`, ...). */
  family: string;
  /** Curve slots the page draws; each slot is one `sub 0x23` fetch. */
  curveSlots: readonly number[];
  /** True when slot 0 streams the Looper envelope (same container, envelope values). */
  waveform: boolean;
  markers: readonly Gen3VisualParamDef[];
  meters: readonly Gen3VisualParamDef[];
}

interface BlockVisualSpec {
  /** Curve slots shared by every model, unless `curveSlotsByModel` overrides. */
  curveSlots?: readonly number[];
  /** Per-model slot sets where the block page exposes a different number of slots. */
  curveSlotsByModel?: Partial<Record<Gen3VisualModel, readonly number[]>>;
  waveform?: boolean;
  markers?: readonly MarkerName[];
  /** Models that host the block at all; omitted = every supported model. */
  models?: readonly Gen3VisualModel[];
}

type MarkerName =
  | 'COMP_XMARK'
  | 'MOD_XMARK'
  | 'CONTROLLERS_ADSR1_XMARK'
  | 'CONTROLLERS_ADSR2_XMARK'
  | 'LOOPER_STOP';

/**
 * Marker pids per model. Every marker is read with the ordinary
 * `sub 0x19 (effectId, pid)` state read.
 */
const MARKER_PIDS: Readonly<Record<Gen3VisualModel, Partial<Record<MarkerName, number>>>> = {
  fm3: {
    COMP_XMARK: 28,
    MOD_XMARK: 18,
    CONTROLLERS_ADSR1_XMARK: 123,
    CONTROLLERS_ADSR2_XMARK: 125,
    LOOPER_STOP: 14,
  },
  fm9: {
    COMP_XMARK: 28,
    MOD_XMARK: 18,
    CONTROLLERS_ADSR1_XMARK: 123,
    CONTROLLERS_ADSR2_XMARK: 125,
    LOOPER_STOP: 14,
  },
  iii: {
    COMP_XMARK: 28,
    MOD_XMARK: 18,
    CONTROLLERS_ADSR1_XMARK: 171,
    CONTROLLERS_ADSR2_XMARK: 173,
    LOOPER_STOP: 14,
  },
};

const MARKER_NOTES: Partial<Record<MarkerName, string>> = {
  COMP_XMARK: 'X position across the compressor transfer plot.',
  MOD_XMARK: 'X position along the modifier curve; MOD_YMARK is never polled.',
  CONTROLLERS_ADSR1_XMARK: 'ADSR 1 position across the drawn envelope.',
  CONTROLLERS_ADSR2_XMARK: 'ADSR 2 position across the drawn envelope.',
  LOOPER_STOP: 'Loop playhead position, not a stop flag.',
};

/**
 * Curve slots and markers per block family. Slot numbers are the values bound
 * in the block pages; a family that is not listed has no known device curve.
 * Chorus is deliberately absent: it carries no graph widget on any of the
 * three block layouts, so a slot-0 fetch would only time out.
 */
const BLOCK_VISUALS: Readonly<Record<string, BlockVisualSpec>> = {
  COMP: { curveSlots: [0, 1], markers: ['COMP_XMARK'] },
  PEQ: { curveSlots: [0] },
  GEQ: { curveSlots: [0] },
  FILTER: { curveSlots: [0, 1] },
  CABINET: { curveSlots: [0, 1, 2, 3] },
  RTA: { curveSlots: [0] },
  DELAY: { curveSlots: [0] },
  MULTITAP: { curveSlots: [0] },
  PLEX: { curveSlots: [0] },
  REVERB: { curveSlots: [0] },
  FLANGER: { curveSlots: [0] },
  PHASER: { curveSlots: [0] },
  TREMOLO: { curveSlots: [0] },
  MEGATAP: { curveSlots: [0, 1, 2, 3] },
  MULTICOMP: { curveSlots: [0] },
  GLOBAL: { curveSlotsByModel: { fm3: [0, 1], fm9: [0, 1, 2], iii: [0, 1, 2, 3] } },
  MOD: { curveSlots: [0], markers: ['MOD_XMARK'] },
  CONTROLLERS: {
    curveSlots: [0, 1, 2, 3],
    markers: ['CONTROLLERS_ADSR1_XMARK', 'CONTROLLERS_ADSR2_XMARK'],
  },
  LOOPER: { curveSlots: [0], waveform: true, markers: ['LOOPER_STOP'] },
  TONEMATCH: { curveSlots: [0, 1, 2, 3], models: ['iii'] },
  DYNDIST: { curveSlots: [0], models: ['iii'] },
};

const METERS_BY_MODEL: Readonly<
  Record<Gen3VisualModel, Readonly<Record<string, { family: string; pid: number; minDb?: number; maxDb?: number; widgetConfirmed: boolean }>>>
> = {
  fm3: FM3_MONITOR_PARAMS,
  fm9: FM9_MONITOR_PARAMS,
  iii: AXE3_MONITOR_PARAMS,
};

/** Wire model byte for a supported model. */
export function gen3VisualModelByte(model: Gen3VisualModel): number {
  if (model === 'fm3') return FRACTAL_MODEL_BYTES.fm3;
  if (model === 'fm9') return FRACTAL_MODEL_BYTES.fm9;
  return FRACTAL_MODEL_BYTES.axeFxIII;
}

/** Block families with a visual descriptor for `model`, sorted. */
export function gen3VisualFamilies(model: Gen3VisualModel): string[] {
  const families = new Set<string>();
  for (const [family, spec] of Object.entries(BLOCK_VISUALS)) {
    if (spec.models && !spec.models.includes(model)) continue;
    families.add(family);
  }
  for (const def of Object.values(METERS_BY_MODEL[model])) families.add(def.family);
  return [...families].sort();
}

/** Meters of one family, from the model's monitor table. */
function metersFor(family: string, model: Gen3VisualModel): Gen3VisualParamDef[] {
  const table = METERS_BY_MODEL[model];
  const out: Gen3VisualParamDef[] = [];
  for (const [name, def] of Object.entries(table)) {
    if (def.family !== family) continue;
    out.push({
      name,
      pid: def.pid,
      role: 'meter',
      minDb: def.minDb,
      maxDb: def.maxDb,
      encoding: family === 'OUTPUT' && (name === 'OUTPUT_VUL' || name === 'OUTPUT_VUR') ? 'rms' : 'normalized',
      widgetConfirmed: def.widgetConfirmed,
    });
  }
  return out;
}

function markersFor(names: readonly MarkerName[] | undefined, model: Gen3VisualModel): Gen3VisualParamDef[] {
  const pids = MARKER_PIDS[model];
  const out: Gen3VisualParamDef[] = [];
  for (const name of names ?? []) {
    const pid = pids[name];
    if (pid === undefined) continue;
    out.push({
      name,
      pid,
      role: 'marker',
      encoding: 'position',
      note: MARKER_NOTES[name],
      widgetConfirmed: true,
    });
  }
  return out;
}

/**
 * The visual data descriptor for one block family on one model, or null when
 * the family has no known device visuals. Marker definitions the model does
 * not expose (e.g. ADSR 2) are omitted rather than approximated.
 */
export function gen3BlockVisual(family: string, model: Gen3VisualModel): Gen3BlockVisual | null {
  const spec = BLOCK_VISUALS[family];
  if (spec?.models && !spec.models.includes(model)) return null;
  const meters = metersFor(family, model);
  const markers = markersFor(spec?.markers, model);
  const curveSlots = spec?.curveSlotsByModel?.[model] ?? spec?.curveSlots ?? [];
  if (spec === undefined && meters.length === 0 && markers.length === 0) return null;
  return {
    family,
    curveSlots,
    waveform: spec?.waveform === true,
    markers,
    meters,
  };
}

/** Look up one marker or meter by catalog symbol. */
export function gen3VisualParam(
  visual: Gen3BlockVisual,
  name: string,
): Gen3VisualParamDef | null {
  return visual.markers.find((m) => m.name === name) ?? visual.meters.find((m) => m.name === name) ?? null;
}

/** Build the `sub 0x23` curve fetch for one slot of a descriptor. */
export function buildGen3VisualCurvePoll(
  visual: Gen3BlockVisual,
  model: Gen3VisualModel,
  effectId: number,
  slot = 0,
): number[] {
  if (!visual.curveSlots.includes(slot)) {
    throw new Error(`${visual.family} has no curve slot ${slot} (slots: ${visual.curveSlots.join(', ')}).`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= GRAPH_CURVE_SLOTS) {
    throw new Error(`Curve slot ${slot} out of range 0..${GRAPH_CURVE_SLOTS - 1}.`);
  }
  return buildGraphCurvePoll(effectId, slot, gen3VisualModelByte(model));
}

/** True for the reply to `buildGen3VisualCurvePoll(visual, model, effectId, slot)`. */
export function isGen3VisualCurveResponse(
  visual: Gen3BlockVisual,
  frame: readonly number[],
  effectId: number,
  slot = 0,
): boolean {
  return visual.curveSlots.includes(slot) && isGraphCurveResponse(frame, effectId, slot);
}

/**
 * Decode a curve reply for this descriptor. The Looper waveform uses the same
 * 512-byte float32 container; its values are the loop envelope magnitudes.
 */
export function parseGen3VisualCurve(
  visual: Gen3BlockVisual,
  frame: readonly number[],
): number[] {
  if (frame[6] !== SUB_GRAPH_CURVE) {
    throw new Error(`Reply for ${visual.family} is not a 0x23 curve frame.`);
  }
  return parseGraphCurve(frame);
}

/** Build the `sub 0x19` read for a marker or meter of this descriptor. */
export function buildGen3VisualValuePoll(
  visual: Gen3BlockVisual,
  model: Gen3VisualModel,
  effectId: number,
  name: string,
): number[] {
  const def = gen3VisualParam(visual, name);
  if (!def) throw new Error(`${visual.family} has no visual param "${name}".`);
  return buildBlockMonitorPoll(effectId, def.pid, gen3VisualModelByte(model));
}

/** True for the reply to `buildGen3VisualValuePoll(visual, model, effectId, name)`. */
export function isGen3VisualValueResponse(
  visual: Gen3BlockVisual,
  frame: readonly number[],
  effectId: number,
  name: string,
): boolean {
  const def = gen3VisualParam(visual, name);
  if (!def) return false;
  return isBlockMonitorResponse(frame, effectId, def.pid);
}

/** Normalized 0..1 value of a marker or meter reply. */
export function parseGen3VisualValue(frame: readonly number[]): number {
  return parseBlockMonitorNorm(frame);
}

/**
 * Map a meter's 0..1 wire value to dB. RMS meters are converted with
 * `10·log10`; normalized meters map linearly onto the widget span.
 */
export function gen3VisualMeterDb(def: Gen3VisualParamDef, value: number): number | null {
  if (def.role !== 'meter' || def.minDb == null || def.maxDb == null) return null;
  if (def.encoding === 'rms') {
    if (!(value > 1e-7)) return def.minDb;
    const db = 10 * Math.log10(value);
    return Math.max(def.minDb, Math.min(def.maxDb, db));
  }
  const n = Math.max(0, Math.min(1, value));
  return def.minDb + n * (def.maxDb - def.minDb);
}
