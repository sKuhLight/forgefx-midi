/**
 * gen-3 knob taper rule, shared by the body decoder (`blockParams.ts`) and the
 * converter's range resolver (`convert/targetRanges.ts`) so a param decodes and
 * converts on ONE scale.
 *
 * The device stores a continuous param as a u16 `0..65534` wire position. How
 * that position maps onto the display range depends on the param's taper:
 *   - linear: `display = min + f * (max - min)`
 *   - log10:  `display = min * (max / min) ^ f`   (frequency-style knobs)
 * with `f = raw / 65534`. The taper itself is not stored in the body; it is
 * recovered from the device range table (see `gen3TaperIsLog`).
 *
 * BROWSER-SAFE: pure functions, no node: imports.
 */

/** The slice of a gen-3 range row the taper rule reads (structural). */
export interface Gen3TaperRow {
  readonly displayMin: number;
  readonly displayMax: number;
  /** Undecoded device taper bitfield (unit/taper candidate). */
  readonly typecode?: number;
  /** Explicit per-parameter taper from the device range table; wins over `typecode`. */
  readonly taper?: 'linear' | 'log' | 'flat' | 'custom';
}

/** Wire value of the top of the scale (`raw / GEN3_WIRE_MAX` is the 0..1 position). */
export const GEN3_WIRE_MAX = 65534;

/**
 * gen-3 taper decision, MIRRORING the live server (`ForgeFX/server/src/
 * drivers/gen3.ts` `#display`): a device-true explicit `range.taper` wins
 * ('log' → log10; 'linear' | 'flat' | 'custom' → linear), otherwise fall back
 * to the typecode-nibble heuristic: only `(typecode >> 4) & 0xf === 4` means
 * log10, every other nibble is linear. Nibble 5 is deliberately NOT log: the
 * explicit tapers in the FM9 and Axe-Fx III catalogs have it linear every
 * time, and the server dropped it from the log set for that reason.
 * A log sweep requires a positive `displayMin` (the live `wireToDisplay` throws
 * on log10 with a non-positive min) — the same guard the live nibble branch
 * uses. Without a range row the taper is unknown → linear (matches the live
 * fall-through). `param.scaling` is deliberately NOT consulted: the live path
 * does not read it, and most FM3 catalog rows do not carry it.
 */
export function gen3TaperIsLog(range: Gen3TaperRow | undefined): boolean {
  if (range === undefined || !(range.displayMin > 0)) return false;
  if (range.taper !== undefined) return range.taper === 'log';
  const nib = ((range.typecode ?? 0) >> 4) & 0xf;
  return nib === 4;
}

/**
 * Display value of a raw gen-3 wire position on `range`, on the taper
 * `gen3TaperIsLog` selects. The inverse of the display→wire mapping the writers
 * use (`displayToWire` with the matching scale). Requires a non-degenerate range
 * (`displayMax !== displayMin`); callers gate on that.
 */
export function gen3RawToDisplay(raw: number, range: Gen3TaperRow): number {
  const f = raw / GEN3_WIRE_MAX;
  if (gen3TaperIsLog(range) && range.displayMax > 0) {
    return range.displayMin * Math.pow(range.displayMax / range.displayMin, f);
  }
  return range.displayMin + f * (range.displayMax - range.displayMin);
}
