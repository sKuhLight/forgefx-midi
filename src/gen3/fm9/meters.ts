/**
 * FM9 per-block monitor (meter) parameters.
 *
 * Like the FM3, the FM9 has no dedicated per-block meter/VU SysEx: each meter is a read-only
 * "monitor" parameter in the block's own param space, returned by the standard per-block reads,
 * bound to a meter widget with a dB scale. This table names those monitor pids and their widget
 * dB endpoints.
 *
 * Derived from FM9-Edit's editor layout data (`__block_layout.xml` + amp layout, carved
 * 2026-07-01); every pid cross-checks against `FM9_PARAMS` (same id space). paramIds are
 * FM9-specific — note the DISTORT monitors differ from the FM3/III (FM9 124/125/136).
 *
 * NOT hardware-pinned: the wire VALUE encoding (dB vs normalized vs raw 16-bit) — same open
 * question as the FM3 meter table; the widget maps the value linearly onto [minDb, maxDb].
 */

export type Fm9MeterRole = 'level' | 'vu' | 'gainReduction' | 'headroom' | 'supply' | 'detector';

export interface Fm9MonitorParamDef {
  family: string;
  pid: number;
  role: Fm9MeterRole;
  minDb?: number;
  maxDb?: number;
  /** true = an explicit meter-widget binding (with dB range) was recovered for this pid. */
  widgetConfirmed: boolean;
}

/**
 * Monitor params by catalog parameterName. dB ranges are the base-layout widget scales; known
 * variants: output VUs also appear at −40…20 (expert), and the compressor gain widget is
 * type-gated (−40…0 reduction / 0…40 makeup, per COMP_TYPE).
 */
export const FM9_MONITOR_PARAMS: Readonly<Record<string, Fm9MonitorParamDef>> = {
  INPUT_GAINMONITOR: { family: 'INPUT', pid: 8, role: 'level', minDb: -60, maxDb: 0, widgetConfirmed: true },
  OUTPUT_VUL: { family: 'OUTPUT', pid: 16, role: 'vu', minDb: -40, maxDb: 10, widgetConfirmed: true },
  OUTPUT_VUR: { family: 'OUTPUT', pid: 17, role: 'vu', minDb: -40, maxDb: 10, widgetConfirmed: true },
  COMP_GAINMONITOR: { family: 'COMP', pid: 25, role: 'gainReduction', minDb: -40, maxDb: 0, widgetConfirmed: true },
  MULTICOMP_GAINMON1: { family: 'MULTICOMP', pid: 28, role: 'gainReduction', minDb: -30, maxDb: 0, widgetConfirmed: true },
  MULTICOMP_GAINMON2: { family: 'MULTICOMP', pid: 29, role: 'gainReduction', minDb: -30, maxDb: 0, widgetConfirmed: true },
  MULTICOMP_GAINMON3: { family: 'MULTICOMP', pid: 30, role: 'gainReduction', minDb: -30, maxDb: 0, widgetConfirmed: true },
  GATE_GAINMONITOR: { family: 'GATE', pid: 13, role: 'gainReduction', minDb: -60, maxDb: 0, widgetConfirmed: true },
  FILTER_DETMON: { family: 'FILTER', pid: 33, role: 'detector', minDb: -30, maxDb: 0, widgetConfirmed: true },
  DISTORT_GAINMON: { family: 'DISTORT', pid: 125, role: 'level', minDb: -30, maxDb: 0, widgetConfirmed: true },
  DISTORT_VCCMON: { family: 'DISTORT', pid: 124, role: 'supply', minDb: -9, maxDb: 3, widgetConfirmed: true },
  DISTORT_VPLATEMON: { family: 'DISTORT', pid: 136, role: 'headroom', minDb: -20, maxDb: 0, widgetConfirmed: true },
  CABINET_GAINMONITOR: { family: 'CABINET', pid: 60, role: 'level', widgetConfirmed: false },
  CABINET_VUMETER: { family: 'CABINET', pid: 61, role: 'vu', minDb: -40, maxDb: 20, widgetConfirmed: true },
  CONTROLLERS_ENV_GAINMONITOR: { family: 'CONTROLLERS', pid: 109, role: 'detector', widgetConfirmed: true },
  VOLUME_METER: { family: 'VOLUME', pid: 14, role: 'level', widgetConfirmed: true },
  LOOPER_LEVEL: { family: 'LOOPER', pid: 22, role: 'level', minDb: -80, maxDb: 20, widgetConfirmed: true },
};

/** Monitor params of one block family, `[paramName, def]` pairs (empty if none). */
export function fm9MonitorParamsFor(family: string): [string, Fm9MonitorParamDef][] {
  return Object.entries(FM9_MONITOR_PARAMS).filter(([, def]) => def.family === family);
}

/** Map a normalized 0..1 monitor level to dB (clamps below-floor to 0; null if no dB range).
 *  Encoding shared with the FM3 (see gen3/fm3/meters.ts) — confirmed normalized 0..1. */
export function fm9MonitorDb(def: Fm9MonitorParamDef, norm: number): number | null {
  if (def.minDb == null || def.maxDb == null) return null;
  const n = Math.max(0, Math.min(1, norm));
  return def.minDb + n * (def.maxDb - def.minDb);
}
