/**
 * Axe-Fx III Modifier map — catalog cross-checks.
 *
 * Every modifier field pid must resolve to the recovered MOD_* symbol in the III catalog (PARAMS)
 * with the same paramId, so drift in either table fails here.
 */
import {
  AXE3_MOD_EFFECT_ID,
  AXE3_MOD_SLOT_COUNT,
  axe3ModSlotEid,
  AXE3_MOD_FIELDS,
  axe3ModParamId,
  axe3ModBindFrames,
  type Axe3ModField,
} from '../../../src/gen3/axe-fx-iii/modifiers.js';
import { PARAMS } from '../../../src/gen3/axe-fx-iii/params.js';

export const AXE3_MOD_CASE_COUNT = 25 + 5;

export function runAxe3ModifierTests(): void {
  // 1. effectId + slot span are enum-confirmed.
  if (AXE3_MOD_EFFECT_ID !== 3) throw new Error(`[axe3/mod] effectId must be 3, got ${AXE3_MOD_EFFECT_ID}`);
  if (AXE3_MOD_SLOT_COUNT !== 32) throw new Error(`[axe3/mod] slot count must be 32, got ${AXE3_MOD_SLOT_COUNT}`);
  if (axe3ModSlotEid(1) !== 3 || axe3ModSlotEid(32) !== 34) {
    throw new Error('[axe3/mod] slot eid mapping wrong (slot1=3, slot32=34)');
  }

  // 2. Every field pid resolves to its recovered symbol in the catalog.
  const byPid = new Map<number, string>();
  for (const p of PARAMS) if (p.family === 'MOD' && !byPid.has(p.paramId)) byPid.set(p.paramId, p.name);
  for (const [field, def] of Object.entries(AXE3_MOD_FIELDS)) {
    const catName = byPid.get(def.pid);
    if (catName !== def.symbol) {
      throw new Error(`[axe3/mod] ${field} pid ${def.pid} in catalog is ${catName}, expected ${def.symbol}`);
    }
    if (axe3ModParamId(field as Axe3ModField) !== def.pid) {
      throw new Error(`[axe3/mod] axe3ModParamId(${field}) != ${def.pid}`);
    }
  }

  // 3. pids are 0..24 contiguous.
  const pids = Object.values(AXE3_MOD_FIELDS).map((d) => d.pid).sort((a, b) => a - b);
  for (let i = 0; i < pids.length; i++) {
    if (pids[i] !== i) throw new Error(`[axe3/mod] field pids must be 0..24 contiguous; missing ${i}`);
  }

  // 4. Binding helper writes target eid, target pid, source in that order.
  const frames = axe3ModBindFrames(58, 3, 10);
  if (frames.length !== 3 || frames[0].pid !== 8 || frames[1].pid !== 9 || frames[2].pid !== 0) {
    throw new Error('[axe3/mod] bind frames must be [pid8, pid9, pid0]');
  }
  if (frames[0].value !== 58 || frames[1].value !== 3 || frames[2].value !== 10) {
    throw new Error('[axe3/mod] bind frame values wrong');
  }
}
