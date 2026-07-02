/**
 * FM3 per-block monitor (meter) parameters.
 *
 * The FM3 has no dedicated per-block meter/VU SysEx. Every per-block meter the editor
 * shows is an ordinary read-only "monitor" parameter — a normal `(effectId, paramId)`
 * in the block's own param space, returned by the standard per-block reads (fn `0x76`
 * bulk read / fn `0x01` GET) — bound to a meter widget with a dB scale. This table
 * names those monitor pids and the widget's dB endpoints where the editor layout
 * states them.
 *
 * Derived from the editor's UI-layout configuration data; every pid cross-checks
 * against `FM3_PARAMS` / `FM3_LAYOUTS` (same id space as the rest of the catalog).
 *
 * VALUE encoding — CONFIRMED normalized 0..1 (live FM3 capture 2026-07-02, decoded from
 * devices/fm3/captures/live-aseqdump.txt). A block's primary monitor level is returned by the
 * per-block GET `F0 00 01 74 11 01 01 00 <eid:14bit LE> 00 00 <value:5×7bit f32 @off 12-16> …`
 * as a normalized float: the INPUT block read 0.0 at true silence (−60 dB floor) → 1.0 at 0 dB,
 * and the −43.6 dB reference landed at ~0.27 = (−43.6−(−60))/60. So the display value is
 * `dB = minDb + clamp(norm,0,1)·(maxDb−minDb)` — see `fm3MonitorDb()`. A below-floor/gated
 * sentinel (≈ −0.44) also appears; clamp to 0.
 *
 * Excluded: the global I/O-page input meter (`INPUT_METERS`, −20…−2.4 dB) — it is not
 * a per-block pid (no paramId recovered), and global levels already ride the home
 * telemetry frame. Also note the FM3's home CPU/audio meters are a separate global
 * frame, not block params.
 */

export type Fm3MeterRole =
  /** signal level (absolute) */
  | 'level'
  /** output VU */
  | 'vu'
  /** downward gain reduction (compressor/gate) */
  | 'gainReduction'
  /** remaining headroom */
  | 'headroom'
  /** supply/rail voltage (amp/drive B+) */
  | 'supply'
  /** envelope-detector level (relative) */
  | 'detector';

export interface Fm3MonitorParamDef {
  /** Catalog family symbol (key into FM3_PARAMS_BY_FAMILY). */
  family: string;
  /** Block-local paramId — same id space as every other param of that block. */
  pid: number;
  role: Fm3MeterRole;
  /** Meter scale endpoints in dB, where the editor layout states them. Omitted = the
   *  widget draws a relative bar or the range was not recovered — pid is still confirmed. */
  minDb?: number;
  maxDb?: number;
  /** true = an explicit meter-widget binding was recovered for this pid;
   *  false = the monitor pid is confirmed but its widget wiring is inferred. */
  widgetConfirmed: boolean;
}

/**
 * Monitor params by catalog parameterName.
 *
 * dB ranges are the base-layout widget scales. Known widget variants: the output VUs
 * extend to +20 dB in the expert layout; the compressor gain widget also has a 0…+40
 * makeup-gain flavor.
 */
export const FM3_MONITOR_PARAMS: Readonly<Record<string, Fm3MonitorParamDef>> = {
  INPUT_GAINMONITOR: { family: 'INPUT', pid: 8, role: 'level', minDb: -60, maxDb: 0, widgetConfirmed: true },
  OUTPUT_VUL: { family: 'OUTPUT', pid: 16, role: 'vu', minDb: -40, maxDb: 6, widgetConfirmed: true },
  OUTPUT_VUR: { family: 'OUTPUT', pid: 17, role: 'vu', minDb: -40, maxDb: 6, widgetConfirmed: true },
  COMP_GAINMONITOR: { family: 'COMP', pid: 25, role: 'gainReduction', minDb: -40, maxDb: 0, widgetConfirmed: true },
  MULTICOMP_GAINMON1: { family: 'MULTICOMP', pid: 28, role: 'gainReduction', widgetConfirmed: false },
  MULTICOMP_GAINMON2: { family: 'MULTICOMP', pid: 29, role: 'gainReduction', widgetConfirmed: false },
  MULTICOMP_GAINMON3: { family: 'MULTICOMP', pid: 30, role: 'gainReduction', widgetConfirmed: false },
  GATE_GAINMONITOR: { family: 'GATE', pid: 13, role: 'gainReduction', minDb: -60, maxDb: 0, widgetConfirmed: true },
  FILTER_DETMON: { family: 'FILTER', pid: 33, role: 'detector', minDb: -40, maxDb: 0, widgetConfirmed: true },
  DISTORT_GAINMON: { family: 'DISTORT', pid: 121, role: 'level', widgetConfirmed: true },
  DISTORT_VCCMON: { family: 'DISTORT', pid: 120, role: 'supply', widgetConfirmed: true },
  DISTORT_VPLATEMON: { family: 'DISTORT', pid: 132, role: 'headroom', minDb: -20, maxDb: 0, widgetConfirmed: true },
  CABINET_GAINMONITOR: { family: 'CABINET', pid: 60, role: 'level', minDb: -40, maxDb: 20, widgetConfirmed: true },
  CABINET_VUMETER: { family: 'CABINET', pid: 61, role: 'vu', minDb: -40, maxDb: 20, widgetConfirmed: true },
  CONTROLLERS_ENV_GAINMONITOR: { family: 'CONTROLLERS', pid: 109, role: 'detector', widgetConfirmed: true },
  VOLUME_METER: { family: 'VOLUME', pid: 14, role: 'level', widgetConfirmed: true },
};

/** Monitor params of one block family, `[paramName, def]` pairs (empty if none). */
export function fm3MonitorParamsFor(family: string): [string, Fm3MonitorParamDef][] {
  return Object.entries(FM3_MONITOR_PARAMS).filter(([, def]) => def.family === family);
}

/**
 * Map a normalized 0..1 monitor level (the wire value — see the module header) to dB for a monitor
 * def. Clamps below-floor/gated values to 0. Returns null when the def has no dB range (relative
 * meter). CONFIRMED encoding: `dB = minDb + clamp(norm,0,1)·(maxDb−minDb)` (FM3 capture 2026-07-02).
 */
export function fm3MonitorDb(def: Fm3MonitorParamDef, norm: number): number | null {
  if (def.minDb == null || def.maxDb == null) return null;
  const n = Math.max(0, Math.min(1, norm));
  return def.minDb + n * (def.maxDb - def.minDb);
}
