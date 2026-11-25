/**
 * Cross-block layout references -> owning effectId (`parseCrossToken`,
 * `crossBlockEffectId` in `src/editorLayouts.ts`, and the device-bound
 * `fm3CrossBlockEffectId` / `fm9CrossBlockEffectId` / `axe3CrossBlockEffectId`).
 *
 * Committed data only. Covers:
 *   1. token parsing (symbol + 1-based instance; non-tokens are null);
 *   2. FM3 goldens: GLOBAL / FC / OUTPUT / DISTORT resolve, MOD / PRESET / unknown /
 *      missing family / beyond-the-device instances do not;
 *   3. FM9 and Axe-Fx III goldens with their own (larger) instance counts;
 *   4. the III resolver is bound to the III table, the FM9 one to the shared FM3 table;
 *   5. an oversized host instance count is capped by the shared gen-3 roster span, and
 *      the generic resolver (re-exported for runtime tables) honours the same cap;
 *   6. corpus: every `crossBlock` in the FM3 / FM9 / III layouts resolves as promised,
 *      and the generated data never carries an `effectId` (the host serves it).
 *
 * Instance counts are a caller input (the host's per-device instance limits); the
 * maps below mirror the device-true counts for the families the layouts reference.
 */
import {
  FM3_LAYOUTS,
  FM3_EFFECT_IDS,
  fm3CrossBlockEffectId,
  parseCrossToken,
  crossBlockEffectId,
  gen3RosterSpan,
  type CrossBlockRefKey,
  type DeviceEditorLayouts,
} from '../../src/gen3/fm3/index.js';
import {
  FM9_LAYOUTS,
  FM9_EFFECT_IDS,
  fm9CrossBlockEffectId,
  crossBlockEffectId as fm9Generic,
  gen3RosterSpan as fm9RosterSpan,
} from '../../src/gen3/fm9/index.js';
import {
  AXE3_LAYOUTS,
  AXE3_EFFECT_IDS,
  AXE3_EFFECT_ID_TABLE,
  axe3CrossBlockEffectId,
  crossBlockEffectId as axe3Generic,
  gen3RosterSpan as axe3RosterSpan,
} from '../../src/gen3/axe-fx-iii/index.js';

const fail = (msg: string): never => {
  throw new Error(`[gen3/crossblock-effectid] ${msg}`);
};

type Resolve = (ref: CrossBlockRefKey, instanceCount: number) => number | null;

/** Device-true instance counts for the families the layouts reference (1 = singleton). */
const FM3_INSTANCES: Readonly<Record<string, number>> = { OUTPUT: 2, DISTORT: 1 };
const FM9_INSTANCES: Readonly<Record<string, number>> = { OUTPUT: 3, DISTORT: 2 };
const AXE3_INSTANCES: Readonly<Record<string, number>> = { OUTPUT: 4, DISTORT: 2 };
const countOf = (limits: Readonly<Record<string, number>>, family: string | null): number =>
  (family && limits[family]) || 1;

interface Golden {
  token: string;
  family: string | null;
  expected: number | null;
}

function checkGoldens(dev: string, resolve: Resolve, limits: Readonly<Record<string, number>>, goldens: Golden[]): void {
  for (const g of goldens) {
    const got = resolve({ effect: g.token, family: g.family }, countOf(limits, g.family));
    if (got !== g.expected) fail(`${dev} ${g.token} (${g.family}): expected ${g.expected}, got ${got}`);
  }
}

const FM3_GOLDENS: Golden[] = [
  { token: 'ID_GLOBAL', family: 'GLOBAL', expected: 1 },
  { token: 'ID_FOOTCONTROLLER', family: 'FC', expected: 199 },
  { token: 'ID_OUTPUT1', family: 'OUTPUT', expected: 42 },
  { token: 'ID_OUTPUT2', family: 'OUTPUT', expected: 43 },
  { token: 'ID_DISTORT1', family: 'DISTORT', expected: 58 },
  // The FM3 has one amp: a second instance is beyond the device, not eid 59.
  { token: 'ID_DISTORT2', family: 'DISTORT', expected: null },
  // The FM3 has two outputs: the shared roster reserves 42..45, the device does not.
  { token: 'ID_OUTPUT3', family: 'OUTPUT', expected: null },
  { token: 'ID_PRESET_FC', family: 'PRESET', expected: null },
  { token: 'ID_MODIFIER1', family: 'MOD', expected: null },
  { token: 'ID_MODIFIER32', family: 'MOD', expected: null },
  { token: 'ID_GLOBAL', family: null, expected: null },
  { token: 'ID_NOPE', family: 'NOPE', expected: null },
  { token: 'ID_OUTPUT5', family: 'OUTPUT', expected: null },
  { token: 'ID_DISTORT9', family: 'DISTORT', expected: null },
  // Not a token, or a prototype key instead of a family.
  { token: 'GLOBAL', family: 'GLOBAL', expected: null },
  { token: 'ID_GLOBAL', family: 'toString', expected: null },
];

const FM9_GOLDENS: Golden[] = [
  { token: 'ID_GLOBAL', family: 'GLOBAL', expected: 1 },
  { token: 'ID_FOOTCONTROLLER', family: 'FC', expected: 199 },
  { token: 'ID_OUTPUT1', family: 'OUTPUT', expected: 42 },
  { token: 'ID_OUTPUT3', family: 'OUTPUT', expected: 44 },
  { token: 'ID_OUTPUT4', family: 'OUTPUT', expected: null },
  { token: 'ID_DISTORT1', family: 'DISTORT', expected: 58 },
  { token: 'ID_DISTORT2', family: 'DISTORT', expected: 59 },
  { token: 'ID_DISTORT3', family: 'DISTORT', expected: null },
  { token: 'ID_PRESET_FC', family: 'PRESET', expected: null },
  { token: 'ID_MODIFIER7', family: 'MOD', expected: null },
];

const AXE3_GOLDENS: Golden[] = [
  { token: 'ID_GLOBAL', family: 'GLOBAL', expected: 1 },
  { token: 'ID_FOOTCONTROLLER', family: 'FC', expected: 199 },
  { token: 'ID_OUTPUT2', family: 'OUTPUT', expected: 43 },
  { token: 'ID_OUTPUT4', family: 'OUTPUT', expected: 45 },
  { token: 'ID_OUTPUT5', family: 'OUTPUT', expected: null },
  { token: 'ID_DISTORT2', family: 'DISTORT', expected: 59 },
  { token: 'ID_DISTORT3', family: 'DISTORT', expected: null },
  // No III effect id of its own.
  { token: 'ID_DYNDIST1', family: 'DYNDIST', expected: null },
  { token: 'ID_PRESET_FC', family: 'PRESET', expected: null },
  { token: 'ID_MODIFIER1', family: 'MOD', expected: null },
];

/** Expected corpus resolution per referenced family (instance-relative for blocks). */
function expectedFor(family: string | null, instance: number): number | null {
  switch (family) {
    case 'GLOBAL': return 1;
    case 'FC': return 199;
    case 'OUTPUT': return 42 + instance - 1;
    case 'DISTORT': return 58 + instance - 1;
    default: return null;
  }
}

function checkCorpus(
  dev: string,
  layouts: DeviceEditorLayouts,
  resolve: Resolve,
  limits: Readonly<Record<string, number>>,
  expect: { total: number; resolved: number },
): void {
  let total = 0;
  let resolved = 0;
  for (const block of Object.values(layouts)) {
    for (const v of block.variants) for (const p of v.pages) for (const r of p.rows) for (const c of r.controls) {
      const cb = c.crossBlock;
      if (!cb) continue;
      total++;
      if ('effectId' in cb) fail(`${dev} ${block.family}/${cb.effect}: generated data carries an effectId (host-served only)`);
      const tok = parseCrossToken(cb.effect);
      if (!tok) fail(`${dev} ${block.family}: unparseable cross token '${cb.effect}'`);
      const got = resolve(cb, countOf(limits, cb.family));
      const want = expectedFor(cb.family, tok!.instance);
      if (got !== want) fail(`${dev} ${block.family}/${cb.effect} (${cb.family}): expected ${want}, got ${got}`);
      if (got !== null) resolved++;
    }
  }
  if (total !== expect.total) fail(`${dev}: ${total} cross-block refs, expected ${expect.total}`);
  if (resolved !== expect.resolved) fail(`${dev}: ${resolved} refs resolve to an effectId, expected ${expect.resolved}`);
}

const cases: Array<[string, () => void]> = [
  ['parseCrossToken splits symbol and instance', () => {
    const ok: Array<[string, string, number]> = [
      ['ID_GLOBAL', 'GLOBAL', 1],
      ['ID_OUTPUT2', 'OUTPUT', 2],
      ['ID_DISTORT1', 'DISTORT', 1],
      ['ID_MODIFIER32', 'MODIFIER', 32],
      ['ID_FOOTCONTROLLER', 'FOOTCONTROLLER', 1],
      ['ID_PRESET_FC', 'PRESET_FC', 1],
    ];
    for (const [token, symbol, instance] of ok) {
      const t = parseCrossToken(token);
      if (!t || t.symbol !== symbol || t.instance !== instance) {
        fail(`parseCrossToken('${token}') = ${JSON.stringify(t)}, expected ${symbol}/${instance}`);
      }
    }
    for (const bad of ['', 'GLOBAL', 'id_global', 'ID_', 'ID_1', 'ID_OUTPUT0', ' ID_GLOBAL', 'ID_GLOBAL ', 'ID_X_2']) {
      if (parseCrossToken(bad) !== null) fail(`parseCrossToken('${bad}') should be null`);
    }
  }],
  ['FM3 goldens (device instance bound)', () => checkGoldens('FM3', fm3CrossBlockEffectId, FM3_INSTANCES, FM3_GOLDENS)],
  ['FM9 goldens', () => checkGoldens('FM9', fm9CrossBlockEffectId, FM9_INSTANCES, FM9_GOLDENS)],
  ['Axe-Fx III goldens', () => checkGoldens('III', axe3CrossBlockEffectId, AXE3_INSTANCES, AXE3_GOLDENS)],
  ['instance count is validated', () => {
    const ref = { effect: 'ID_GLOBAL', family: 'GLOBAL' };
    for (const n of [0, -1, Number.NaN, 1.5]) {
      if (fm3CrossBlockEffectId(ref, n) !== null) fail(`instanceCount ${n} must give null`);
    }
    if (fm3CrossBlockEffectId(ref, 1) !== 1) fail('instanceCount 1 must resolve GLOBAL');
  }],
  ['each device resolver is bound to its own table', () => {
    if (FM9_EFFECT_IDS !== FM3_EFFECT_IDS) fail('FM9 is documented to share the FM3 table');
    if ((axe3CrossBlockEffectId as unknown) === (fm3CrossBlockEffectId as unknown)) fail('III resolver must not be the FM3 one');
    for (const e of AXE3_EFFECT_ID_TABLE) {
      for (let i = 1; i <= Math.max(e.instances, 1); i++) {
        const ref = { effect: `ID_X${i}`, family: e.family };
        const got = axe3CrossBlockEffectId(ref, e.instances);
        const want = crossBlockEffectId(ref, AXE3_EFFECT_IDS, e.instances);
        if (got !== want) fail(`III ${e.family}#${i}: ${got} vs table ${want}`);
        const direct = e.firstId === null || e.family === 'MOD' ? null : e.firstId + i - 1;
        if (got !== direct) fail(`III ${e.family}#${i}: ${got}, expected ${direct}`);
      }
    }
  }],
  ['oversized instance counts are capped by the roster span', () => {
    if (gen3RosterSpan(42) !== 4 || gen3RosterSpan(58) !== 4 || gen3RosterSpan(199) !== 1) fail('roster spans');
    if (gen3RosterSpan(1) !== undefined || gen3RosterSpan(43) !== undefined) fail('no span for GLOBAL / a non-first id');
    if (fm9RosterSpan !== gen3RosterSpan || axe3RosterSpan !== gen3RosterSpan) fail('one shared roster span');
    const out4 = { effect: 'ID_OUTPUT4', family: 'OUTPUT' };
    const out5 = { effect: 'ID_OUTPUT5', family: 'OUTPUT' };
    for (const [dev, resolve] of [['FM3', fm3CrossBlockEffectId], ['FM9', fm9CrossBlockEffectId], ['III', axe3CrossBlockEffectId]] as const) {
      if (resolve(out4, 8) !== 45) fail(`${dev}: OUTPUT4 with count 8 must be 45`);
      if (resolve(out5, 8) !== null) fail(`${dev}: OUTPUT5 must not reach COMP1 (46)`);
      if (resolve({ effect: 'ID_GLOBAL', family: 'GLOBAL' }, 8) !== 1) fail(`${dev}: GLOBAL has no span and resolves`);
      if (resolve({ effect: 'ID_GLOBAL2', family: 'GLOBAL' }, 1) !== null) fail(`${dev}: GLOBAL instance 2 beyond the count`);
    }
    // Generic: without a span the caller's count is trusted; with one it caps.
    if (crossBlockEffectId(out5, FM3_EFFECT_IDS, 8) !== 46) fail('generic without span trusts the count');
    if (crossBlockEffectId(out5, FM3_EFFECT_IDS, 8, gen3RosterSpan) !== null) fail('generic with span caps');
    if (fm9Generic !== crossBlockEffectId || axe3Generic !== crossBlockEffectId) fail('one generic resolver on every device subpath');
    // A host runtime table (synthetic here; e.g. a block-map family) resolves through the generic.
    if (axe3Generic({ effect: 'ID_DYNDIST2', family: 'DYNDIST' }, { DYNDIST: 210 }, 4) !== 211) fail('runtime table');
  }],
  ['FM3 corpus', () => checkCorpus('FM3', FM3_LAYOUTS, fm3CrossBlockEffectId, FM3_INSTANCES, { total: 186, resolved: 103 })],
  ['FM9 corpus', () => checkCorpus('FM9', FM9_LAYOUTS, fm9CrossBlockEffectId, FM9_INSTANCES, { total: 167, resolved: 84 })],
  ['Axe-Fx III corpus', () => checkCorpus('III', AXE3_LAYOUTS, axe3CrossBlockEffectId, AXE3_INSTANCES, { total: 229, resolved: 146 })],
];

export const CROSSBLOCK_EFFECTID_CASE_COUNT = cases.length;

export function runCrossBlockEffectIdTests(): void {
  for (const [name, run] of cases) {
    try {
      run();
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
}
