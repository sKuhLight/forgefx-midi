/**
 * FM3 monitor (meter) param table — catalog cross-checks.
 *
 * The monitor pids come from the editor's UI-layout data; FM3_PARAMS comes from
 * an independent mine of the editor binary's own param tables. Every meter entry
 * must resolve by name in FM3_PARAMS with the same paramId and family, so a
 * regression in either table fails here.
 */
import { FM3_MONITOR_PARAMS, fm3MonitorParamsFor, fm3MonitorDb } from '../../../src/gen3/fm3/index.js';
import { FM3_PARAMS } from '../../../src/gen3/fm3/params.js';

const EXPECTED_ENTRY_COUNT = 16;

export const FM3_METERS_CASE_COUNT = EXPECTED_ENTRY_COUNT;

export function runFm3MetersTests(): void {
  const entries = Object.entries(FM3_MONITOR_PARAMS);
  if (entries.length !== EXPECTED_ENTRY_COUNT) {
    throw new Error(
      `[fm3/meters] expected ${EXPECTED_ENTRY_COUNT} monitor params, got ${entries.length}`,
    );
  }

  const byName = new Map(FM3_PARAMS.map((p) => [p.name, p]));

  for (const [name, def] of entries) {
    const cat = byName.get(name);
    if (!cat) {
      throw new Error(`[fm3/meters] ${name}: not present in FM3_PARAMS`);
    }
    if (cat.paramId !== def.pid) {
      throw new Error(
        `[fm3/meters] ${name}: pid ${def.pid} disagrees with FM3_PARAMS paramId ${cat.paramId}`,
      );
    }
    if (cat.family !== def.family) {
      throw new Error(
        `[fm3/meters] ${name}: family '${def.family}' disagrees with FM3_PARAMS '${cat.family}'`,
      );
    }
    if ((def.minDb === undefined) !== (def.maxDb === undefined)) {
      throw new Error(`[fm3/meters] ${name}: minDb/maxDb must be set together`);
    }
    if (def.minDb !== undefined && def.maxDb !== undefined && def.minDb >= def.maxDb) {
      throw new Error(
        `[fm3/meters] ${name}: minDb ${def.minDb} must be below maxDb ${def.maxDb}`,
      );
    }
  }

  // norm→dB transform (CONFIRMED encoding: normalized 0..1, clamped, linear over [minDb,maxDb]).
  const input = FM3_MONITOR_PARAMS.INPUT_GAINMONITOR; // −60..0
  if (fm3MonitorDb(input, 0) !== -60) throw new Error('[fm3/meters] INPUT norm 0 must be −60 dB');
  if (fm3MonitorDb(input, 1) !== 0) throw new Error('[fm3/meters] INPUT norm 1 must be 0 dB');
  if (Math.abs((fm3MonitorDb(input, 0.5) ?? 0) - -30) > 1e-6) throw new Error('[fm3/meters] INPUT norm 0.5 must be −30 dB');
  if (fm3MonitorDb(input, -0.44) !== -60) throw new Error('[fm3/meters] below-floor must clamp to −60 dB');
  if (fm3MonitorDb(input, 2) !== 0) throw new Error('[fm3/meters] above-1 must clamp to 0 dB');
  if (fm3MonitorDb(FM3_MONITOR_PARAMS.VOLUME_METER, 0.5) !== null) throw new Error('[fm3/meters] rangeless monitor must return null');

  // Family filter helper: DISTORT carries its three drive monitors.
  const distort = fm3MonitorParamsFor('DISTORT').map(([n]) => n).sort();
  const expected = ['DISTORT_GAINMON', 'DISTORT_VCCMON', 'DISTORT_VPLATEMON'];
  if (distort.join(',') !== expected.join(',')) {
    throw new Error(
      `[fm3/meters] fm3MonitorParamsFor('DISTORT') returned [${distort.join(', ')}]`,
    );
  }
}
