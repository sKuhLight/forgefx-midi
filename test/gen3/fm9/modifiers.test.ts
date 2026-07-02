/**
 * FM9 Modifier field-map — catalog cross-checks.
 *
 * Every modifier field pid must resolve by name in FM9_PARAMS with the same paramId (the field
 * map and the param catalog are independently sourced). Confirms eid 3 / 32 slots and the
 * target-binding helper wiring.
 */
import {
  FM9_MOD_EFFECT_ID,
  FM9_MOD_SLOT_COUNT,
  FM9_MOD_FIELDS,
  fm9ModSlotEid,
  fm9ModParamId,
  fm9ModBindFrames,
} from '../../../src/gen3/fm9/modifiers.js';
import { FM9_PARAMS } from '../../../src/gen3/fm9/params.js';

export const FM9_MODIFIER_CASE_COUNT = 25;

export function runFm9ModifierTests(): void {
  const byName = new Map(FM9_PARAMS.map((p) => [p.name, p]));
  const modByPid = new Map(FM9_PARAMS.filter((p) => p.family === 'MOD').map((p) => [p.paramId, p]));

  // 1. effect id + slots
  if (FM9_MOD_EFFECT_ID !== 3) throw new Error(`[fm9/mod] eid must be 3 (ID_MODIFIER1), got ${FM9_MOD_EFFECT_ID}`);
  if (FM9_MOD_SLOT_COUNT !== 32) throw new Error(`[fm9/mod] slot count must be 32, got ${FM9_MOD_SLOT_COUNT}`);
  if (fm9ModSlotEid(1) !== 3 || fm9ModSlotEid(32) !== 34)
    throw new Error('[fm9/mod] slot-eid arithmetic wrong (slot1=3, slot32=34)');

  // 2. every field pid resolves by name in FM9_PARAMS with the same pid + MOD family
  let count = 0;
  for (const [field, def] of Object.entries(FM9_MOD_FIELDS)) {
    const cat = byName.get(def.paramName);
    if (!cat) throw new Error(`[fm9/mod] ${field}: ${def.paramName} not present in FM9_PARAMS`);
    if (cat.paramId !== def.pid)
      throw new Error(`[fm9/mod] ${field}: pid ${def.pid} disagrees with FM9_PARAMS ${def.paramName}=${cat.paramId}`);
    if (cat.family !== 'MOD') throw new Error(`[fm9/mod] ${field}: ${def.paramName} family '${cat.family}' != 'MOD'`);
    if (fm9ModParamId(field as keyof typeof FM9_MOD_FIELDS) !== def.pid)
      throw new Error(`[fm9/mod] fm9ModParamId(${field}) wrong`);
    count++;
  }
  if (count !== FM9_MODIFIER_CASE_COUNT)
    throw new Error(`[fm9/mod] expected ${FM9_MODIFIER_CASE_COUNT} fields, got ${count}`);

  // 3. the 25 MOD-family pids in FM9_PARAMS are exactly 0..24 and all covered
  if (modByPid.size !== 25) throw new Error(`[fm9/mod] FM9_PARAMS MOD family should have 25 entries, got ${modByPid.size}`);
  for (let pid = 0; pid <= 24; pid++) {
    if (!modByPid.has(pid)) throw new Error(`[fm9/mod] FM9_PARAMS MOD family missing pid ${pid}`);
  }

  // 4. binding pids: source=0, targetEffectId=8, targetParam=9
  if (FM9_MOD_FIELDS.source.pid !== 0) throw new Error('[fm9/mod] source pid must be 0');
  if (FM9_MOD_FIELDS.targetEffectId.pid !== 8) throw new Error('[fm9/mod] targetEffectId pid must be 8');
  if (FM9_MOD_FIELDS.targetParam.pid !== 9) throw new Error('[fm9/mod] targetParam pid must be 9');

  // 5. bind-frames helper emits (8,eid)(9,pid)(0,source)
  const frames = fm9ModBindFrames(106, 13, 10);
  if (frames.length !== 3) throw new Error('[fm9/mod] bind frames must be 3 writes');
  if (frames[0].pid !== 8 || frames[0].value !== 106) throw new Error('[fm9/mod] bind frame 0 wrong');
  if (frames[1].pid !== 9 || frames[1].value !== 13) throw new Error('[fm9/mod] bind frame 1 wrong');
  if (frames[2].pid !== 0 || frames[2].value !== 10) throw new Error('[fm9/mod] bind frame 2 wrong');
}
