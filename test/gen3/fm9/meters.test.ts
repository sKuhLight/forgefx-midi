/**
 * FM9 monitor (meter) param table — catalog cross-checks.
 *
 * Every meter entry must resolve by name in FM9_PARAMS with the same paramId and
 * family (the two tables are independently sourced), so a drift in either fails here.
 */
import { FM9_MONITOR_PARAMS, fm9MonitorParamsFor } from '../../../src/gen3/fm9/index.js';
import { FM9_PARAMS } from '../../../src/gen3/fm9/params.js';

const EXPECTED_ENTRY_COUNT = 17;

export const FM9_METERS_CASE_COUNT = EXPECTED_ENTRY_COUNT;

export function runFm9MetersTests(): void {
  const entries = Object.entries(FM9_MONITOR_PARAMS);
  if (entries.length !== EXPECTED_ENTRY_COUNT) {
    throw new Error(`[fm9/meters] expected ${EXPECTED_ENTRY_COUNT} monitor params, got ${entries.length}`);
  }
  const byName = new Map(FM9_PARAMS.map((p) => [p.name, p]));
  for (const [name, def] of entries) {
    const cat = byName.get(name);
    if (!cat) throw new Error(`[fm9/meters] ${name}: not present in FM9_PARAMS`);
    if (cat.paramId !== def.pid) {
      throw new Error(`[fm9/meters] ${name}: pid ${def.pid} disagrees with FM9_PARAMS ${cat.paramId}`);
    }
    if (cat.family !== def.family) {
      throw new Error(`[fm9/meters] ${name}: family '${def.family}' disagrees with FM9_PARAMS '${cat.family}'`);
    }
    if ((def.minDb === undefined) !== (def.maxDb === undefined)) {
      throw new Error(`[fm9/meters] ${name}: minDb/maxDb must be set together`);
    }
    if (def.minDb !== undefined && def.maxDb !== undefined && def.minDb >= def.maxDb) {
      throw new Error(`[fm9/meters] ${name}: minDb ${def.minDb} must be below maxDb ${def.maxDb}`);
    }
  }
  // DISTORT monitors are FM9-specific pids (124/125/136), not the III's 118/119/130.
  if (FM9_MONITOR_PARAMS.DISTORT_GAINMON.pid !== 125) {
    throw new Error('[fm9/meters] DISTORT_GAINMON pid must be FM9-specific 125');
  }
  const distort = fm9MonitorParamsFor('DISTORT').map(([n]) => n).sort().join(',');
  if (distort !== 'DISTORT_GAINMON,DISTORT_VCCMON,DISTORT_VPLATEMON') {
    throw new Error(`[fm9/meters] fm9MonitorParamsFor('DISTORT') = ${distort}`);
  }
}
