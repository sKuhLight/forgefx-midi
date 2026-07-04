/**
 * AM4 block-type dictionary.
 *
 * Used by block-placement writes: the AM4 addresses "which block lives in
 * slot N" by writing the target block's own pidLow as a float32 into a
 * dedicated slot register (pidLow=0x00CE, pidHigh=0x0010+slot-1). Passing
 * 0 clears the slot ("none").
 *
 * These pidLows match the addresses used by `KNOWN_PARAMS` in `params.ts`
 * (block.type writes, block.gain writes, etc.) — they're intentionally the
 * same constants, duplicated here only to give block placement a clean
 * dictionary without reaching into the param registry.
 */

export const BLOCK_TYPE_VALUES = {
  none: 0x0000,       // empty slot
  amp: 0x003a,
  compressor: 0x002e,
  geq: 0x0032,
  peq: 0x0036,        // pidLow pinned ; no Type enum known
  reverb: 0x0042,
  delay: 0x0046,
  chorus: 0x004e,
  flanger: 0x0052,
  rotary: 0x0056,     // pidLow pinned ; no Type enum known
  phaser: 0x005a,
  wah: 0x005e,
  volpan: 0x0066,
  tremolo: 0x006a,
  filter: 0x0072,
  drive: 0x0076,
  enhancer: 0x007a,
  gate: 0x0092,
} as const;

export type BlockTypeName = keyof typeof BLOCK_TYPE_VALUES;

/** Reverse lookup: wire value (block pidLow) → block name. */
export const BLOCK_NAMES_BY_VALUE: Record<number, BlockTypeName> = Object.fromEntries(
  (Object.entries(BLOCK_TYPE_VALUES) as [BlockTypeName, number][]).map(([k, v]) => [v, k]),
);

/**
 * Instance-aware reverse lookup for a slot-register block-type value.
 *
 * Observed on the wire (Axis beta log, factory preset "Bass NoAmp DI"):
 * a SECOND instance of a block type occupies base+1 — the preset carries
 * drive 0x76 in slot 4 AND 0x77 in slot 2, and the exact-match table above
 * knows only 0x76. Known bases are ≥4 apart (each block owns a 4-code
 * window; amp's integrated cab sits at its own base 0x3e = amp+4), so a
 * code inside [base, base+3] resolves to that base's block with
 * `instance = code - base` (0 = the plain/base instance).
 *
 * Whether instance N's params answer at pidLow base+N is capture-pending;
 * this resolver pins the NAME + instance index, which is enough to render
 * the chain and address the slot register. Returns undefined for 0
 * ("none") and for codes outside every known window.
 */
export function resolveBlockTypeValue(
  code: number,
): { name: BlockTypeName; base: number; instance: number } | undefined {
  if (!code) return undefined;
  const direct = BLOCK_NAMES_BY_VALUE[code];
  if (direct !== undefined) return { name: direct, base: code, instance: 0 };
  let best: { name: BlockTypeName; base: number } | undefined;
  for (const [name, base] of Object.entries(BLOCK_TYPE_VALUES) as [BlockTypeName, number][]) {
    if (base !== 0 && base < code && code < base + 4 && (best === undefined || base > best.base)) {
      best = { name, base };
    }
  }
  return best === undefined ? undefined : { ...best, instance: code - best.base };
}

/**
 * Resolve a user-supplied block identifier to its wire value. Accepts the
 * lowercase block name (case-insensitive) or a numeric pidLow directly.
 * Returns undefined on an unknown name.
 */
export function resolveBlockType(input: string | number): number | undefined {
  if (typeof input === 'number') return input;
  const norm = input.trim().toLowerCase();
  if (norm in BLOCK_TYPE_VALUES) return BLOCK_TYPE_VALUES[norm as BlockTypeName];
  return undefined;
}
