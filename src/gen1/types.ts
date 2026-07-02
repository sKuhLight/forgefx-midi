// Axe-Fx Standard / Ultra (gen-1) codec types.
//
// Gen-1 is its OWN codec, sibling to axe-fx-ii (gen-2) and the modern
// (gen-3) family — it shares only the Fractal manufacturer envelope. Every
// addressable field (block id, param id, value) is an 8-bit value 0..255
// transmitted as two nibble bytes, low nibble first (see ./nibble.ts). This
// differs from gen-2's septet-packed 16-bit values and gen-3's sub-action
// dispatch.
//
// Source: the published "Axe-FX Ultra System Exclusive Messages" doc (model
// byte 0x01). Wire shape is decoded byte-exactly from that doc's worked
// examples + its full 0..255 conversion table; it is NOT hardware-verified
// (the project does not own gen-1 hardware), so this ships community-beta.

export type AxeFxGen1ControlType = 'enum' | 'switch' | 'continuous';

/**
 * Display-to-wire scaling for a continuous param.
 *   'linear'  — display maps linearly across [min,max] over wire 0..max.
 *   'pending' — the doc marks this param non-linear (or it spans >1 decade);
 *               the curve is unknown, so display conversion is REFUSED until a
 *               formula is supplied. Callers pass/receive the raw wire value.
 */
export type AxeFxGen1Scaling = 'linear' | 'pending';

export interface AxeFxGen1Param {
  /** Block slug, e.g. "amp", "compressor", "graphic_eq". */
  readonly block: string;
  /** snake_case parameter key within the block, e.g. "type", "master_vol". */
  readonly name: string;
  /** Wire paramId within the block (0..254). */
  readonly paramId: number;
  /** Original doc label, e.g. "TYPE", "Master Vol". */
  readonly docName: string;
  readonly controlType: AxeFxGen1ControlType;
  /** Wire value -> display name, for enum / switch params. */
  readonly enumValues?: Readonly<Record<number, string>>;
  /** Display range + unit, for continuous params (from the doc Description). */
  readonly display?: { readonly min: number; readonly max: number; readonly unit: string };
  /** Scaling for continuous params. Absent for enum/switch. */
  readonly scaling?: AxeFxGen1Scaling;
  /** Raw wire min/default/max as printed in the doc (0..254). */
  readonly range: { readonly min?: number; readonly default?: number; readonly max?: number };
}

export interface AxeFxGen1BlockInstance {
  /** Display name, e.g. "Amp 1". */
  readonly name: string;
  /** Wire block id (the nibble-split 0b0b field), e.g. 106. */
  readonly blockId: number;
}

export interface AxeFxGen1Block {
  /** Block slug, e.g. "amp". */
  readonly slug: string;
  /** Doc anchor / display name, e.g. "Amp". */
  readonly docName: string;
  /** One entry per instance (Amp 1 / Amp 2 share params, differ by blockId). */
  readonly instances: readonly AxeFxGen1BlockInstance[];
}
