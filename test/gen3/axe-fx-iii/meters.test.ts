/**
 * Axe-Fx III monitor (meter) param table — catalog cross-checks.
 *
 * Every meter entry must resolve by name in the III catalog (PARAMS) with the same
 * paramId and family, so a drift in either table fails here.
 */
import { AXE3_MONITOR_PARAMS, axe3MonitorParamsFor } from '../../../src/gen3/axe-fx-iii/index.js';
import { PARAMS } from '../../../src/gen3/axe-fx-iii/params.js';

const EXPECTED_ENTRY_COUNT = 17;

export const AXE3_METERS_CASE_COUNT = EXPECTED_ENTRY_COUNT;

export function runAxe3MetersTests(): void {
  const entries = Object.entries(AXE3_MONITOR_PARAMS);
  if (entries.length !== EXPECTED_ENTRY_COUNT) {
    throw new Error(`[axe3/meters] expected ${EXPECTED_ENTRY_COUNT} monitor params, got ${entries.length}`);
  }
  // A param name can have several catalog rows (variants); index the first by name.
  const byName = new Map<string, (typeof PARAMS)[number]>();
  for (const p of PARAMS) if (!byName.has(p.name)) byName.set(p.name, p);
  for (const [name, def] of entries) {
    const cat = byName.get(name);
    if (!cat) throw new Error(`[axe3/meters] ${name}: not present in III PARAMS`);
    if (cat.paramId !== def.pid) {
      throw new Error(`[axe3/meters] ${name}: pid ${def.pid} disagrees with PARAMS ${cat.paramId}`);
    }
    if (cat.family !== def.family) {
      throw new Error(`[axe3/meters] ${name}: family '${def.family}' disagrees with PARAMS '${cat.family}'`);
    }
    if ((def.minDb === undefined) !== (def.maxDb === undefined)) {
      throw new Error(`[axe3/meters] ${name}: minDb/maxDb must be set together`);
    }
    if (def.minDb !== undefined && def.maxDb !== undefined && def.minDb >= def.maxDb) {
      throw new Error(`[axe3/meters] ${name}: minDb ${def.minDb} must be below maxDb ${def.maxDb}`);
    }
  }
  // DISTORT monitors are III-specific pids (118/119/130), not the FM9's 124/125/136.
  if (AXE3_MONITOR_PARAMS.DISTORT_GAINMON.pid !== 119) {
    throw new Error('[axe3/meters] DISTORT_GAINMON pid must be III-specific 119');
  }
  const distort = axe3MonitorParamsFor('DISTORT').map(([n]) => n).sort().join(',');
  if (distort !== 'DISTORT_GAINMON,DISTORT_VCCMON,DISTORT_VPLATEMON') {
    throw new Error(`[axe3/meters] axe3MonitorParamsFor('DISTORT') = ${distort}`);
  }
}
