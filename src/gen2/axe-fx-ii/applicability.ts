/**
 * Per-(block, name) applicability helpers for Axe-Fx II — translates the
 * `typeApplicability.ts` generated data into runtime predicates.
 *
 * Mirrors `fractal-midi/src/am4/applicability.ts` so the wiring at the
 * MCP descriptor layer can follow the same pattern for both devices.
 * AM4 sibling carries `describeApplicability` + `findCompatibleTypes`;
 * II ships only `checkApplicability` + `getApplicability` in this first
 * cut — the richer surface lands once the per-block enum-display
 * lookup table is wired (the II `*_VALUES` consts in `./params.ts`).
 *
 * Closes the silent-no-op-trap class on II: prior to this, set_param
 * on a knob whose XML row gates on a type not currently active (e.g.
 * `multidelay.diffmix` on a Stereo Delay) silently succeeded on the
 * wire but had zero audible effect. Now the predicate refuses the
 * write with a structured warning naming the gate.
 */
import {
  TYPE_APPLICABILITY,
  type Applicability,
  type ApplicabilityGate,
} from './typeApplicability.js';

export type { Applicability, ApplicabilityGate };

/** Direct lookup. Returns undefined when the key has no applicability data. */
export function getApplicability(blockDotName: string): Applicability | undefined {
  return TYPE_APPLICABILITY[blockDotName];
}

/**
 * Primary type enum for each II block — the enum the agent picks via
 * `block.type` and that primary-type applicability gates filter on.
 *
 * Returns undefined for blocks with no primary type enum (controllers,
 * mixer, output, etc. — fixed-shape blocks without a type selector).
 *
 * Note for the wiring layer: many II blocks expose multiple "type"-
 * like enums (e.g. amp has DISTORT_TYPE for the amp model AND
 * DISTORT_DRIVETYPE / DISTORT_TONESTACK for sub-modes). The primary is
 * the one a musician would identify as "the amp model" / "the comp
 * type" — sub-mode enums are surfaced separately via `isGateForBlock`.
 */
export function primaryTypeEnumFor(block: string): string | undefined {
  switch (block) {
    case 'amp':            return 'DISTORT_TYPE';
    case 'cab':            return 'CABINET_TYPE';
    case 'chorus':         return 'CHORUS_TYPE';
    case 'compressor':     return 'COMP_TYPE';
    case 'delay':          return 'DELAY_TYPE';
    case 'drive':          return 'FUZZ_TYPE';
    case 'filter':         return 'FILTER_TYPE';
    case 'flanger':        return 'FLANGER_TYPE';
    case 'gateexpander':   return 'GATE_TYPE';
    case 'graphiceq':      return 'GEQ_TYPE';
    case 'multidelay':     return 'DELAY_MODEL';
    case 'pantrem':        return 'PANTREM_TYPE';
    case 'phaser':         return 'PHASER_TYPE';
    case 'reverb':         return 'REVERB_TYPE';
    case 'wah':            return 'WAH_TYPE';
    default:               return undefined;
  }
}

function isPrimaryTypeEnum(typeEnum: string, block: string): boolean {
  return primaryTypeEnumFor(block) === typeEnum
      || (block === 'reverb' && typeEnum === 'REVERB_BASETYPE');
}

/**
 * Whether a gate's typeEnum corresponds to a given block. The bulk of
 * gates are intra-block (DELAY_TYPE on delay params, FUZZ_TYPE on drive
 * params), but a few cross over (REVERB_BASETYPE on reverb params,
 * DISTORT_DRIVETYPE / DISTORT_TONESTACK on amp params).
 */
function isGateForBlock(typeEnum: string, block: string): boolean {
  switch (block) {
    case 'amp':
      return typeEnum === 'DISTORT_TYPE'
          || typeEnum === 'DISTORT_DRIVETYPE'
          || typeEnum === 'DISTORT_TONESTACK';
    case 'cab':            return typeEnum === 'CABINET_TYPE';
    case 'chorus':         return typeEnum === 'CHORUS_TYPE';
    case 'compressor':     return typeEnum === 'COMP_TYPE';
    case 'delay':          return typeEnum === 'DELAY_TYPE';
    case 'drive':          return typeEnum === 'FUZZ_TYPE';
    case 'filter':         return typeEnum === 'FILTER_TYPE';
    case 'flanger':        return typeEnum === 'FLANGER_TYPE';
    case 'gateexpander':   return typeEnum === 'GATE_TYPE';
    case 'graphiceq':      return typeEnum === 'GEQ_TYPE';
    case 'multidelay':     return typeEnum === 'DELAY_MODEL';
    case 'pantrem':        return typeEnum === 'PANTREM_TYPE';
    case 'phaser':         return typeEnum === 'PHASER_TYPE';
    case 'reverb':         return typeEnum === 'REVERB_TYPE' || typeEnum === 'REVERB_BASETYPE';
    case 'wah':            return typeEnum === 'WAH_TYPE';
    default:               return false;
  }
}

/** State the agent passes when checking applicability — current active type per block. */
export interface ActiveTypeContext {
  /** Block name (e.g. `amp`, `multidelay`) → wire enum index of its currently active type. */
  readonly currentTypes?: Readonly<Record<string, number>>;
}

/**
 * Predicate: is this parameter applicable on the active type?
 *
 *   - `{ applicable: true }` — always-on, OR at least one primary-type
 *     gate matches the current type.
 *   - `{ applicable: false, gates }` — strictly type-gated and none of
 *     the primary-type gates match. Returned with the gates list so the
 *     caller can surface which types WOULD expose the param.
 *   - `{ applicable: 'unknown' }` — we don't have applicability data
 *     for this key, OR we have data but only sub-mode gates and can't
 *     enforce against them (caller's fallback is "let the write through
 *     with a warning").
 */
export type ApplicabilityCheck =
  | { applicable: true }
  | { applicable: false; gates: readonly ApplicabilityGate[] }
  | { applicable: 'unknown' };

export function checkApplicability(
  blockDotName: string,
  ctx: ActiveTypeContext,
): ApplicabilityCheck {
  const a = TYPE_APPLICABILITY[blockDotName];
  if (!a) return { applicable: 'unknown' };
  if (a.gates.length === 0) {
    return a.always ? { applicable: true } : { applicable: 'unknown' };
  }
  // Per the AM4 sibling's HW-tested correction (5F8 Tweed Normal test,
  // 2026-05-13): when primary-type gates exist, the active type MUST be
  // in the gate list — even when `always: true`. This catches the
  // "wire write goes through but device silently no-ops" case.
  // Sub-mode gates (e.g. DISTORT_DRIVETYPE / REVERB_BASETYPE) are
  // informational — we don't track sub-mode state, so we downgrade
  // checks against them.
  const block = blockDotName.split('.')[0];
  const activeIndex = ctx.currentTypes?.[block];
  if (activeIndex === undefined) return { applicable: 'unknown' };
  let hasPrimaryGate = false;
  for (const g of a.gates) {
    if (!isGateForBlock(g.typeEnum, block)) continue;
    if (!isPrimaryTypeEnum(g.typeEnum, block)) continue;
    hasPrimaryGate = true;
    if (g.values.includes(activeIndex)) return { applicable: true };
  }
  if (!hasPrimaryGate) {
    return a.always ? { applicable: true } : { applicable: 'unknown' };
  }
  return { applicable: false, gates: a.gates };
}
