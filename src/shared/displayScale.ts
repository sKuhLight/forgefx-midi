/**
 * Display↔wire resolver shared across Fractal codecs.
 *
 * Maps a panel display value (0..10 knob, dB, ms, Hz) onto the 16-bit
 * 0..65534 wire field, linearly or log-base-10. Originally calibrated
 * and hardware-verified on the Axe-Fx II (HW-079 goldens in
 * `scripts/verify-axe-fx-ii-encoding.ts`); the gen-3 catalog
 * (`fractal-gen3/src/catalog.ts`) uses the same resolver for params
 * with a calibrated display range. Housed in `shared/` so neither
 * generation's codec depends on the other's module at runtime.
 *
 * Moved verbatim from `gen2/axe-fx-ii/setParam.ts` (which re-exports
 * it for compatibility).
 */

/**
 * Convert a display value to its corresponding 16-bit wire value, given
 * a param's calibrated `displayMin` / `displayMax` / `displayScale`.
 *
 * Two scale shapes supported:
 *
 * **`'linear'`** (default) — wire 0..65534 maps linearly onto
 * displayMin..displayMax. Confirmed by  /  /  across
 * 0..10 (AMP knobs), 0..100% (mix), -100..+100% (feedback / balance /
 * pan), -80..+20 dB (cab level).
 *
 * **`'log10'`** — wire 0..65534 maps log-base-10 onto
 * displayMin..displayMax. Used for frequency knobs ( confirmed
 * cab.low_cut 20..2000 Hz and cab.high_cut 200..20000 Hz both fit
 * `displayHz = displayMin × (displayMax/displayMin)^(wire/65534)`
 * exactly at every measured anchor). Requires displayMin > 0.
 *
 * Callers should only invoke this on params with populated displayMin
 * AND displayMax. For uncalibrated params, the tool layer falls back
 * to the wire-value path.
 *
 * Clamps to [displayMin, displayMax] silently — the wire value pins to
 * [0, 65534] either way, so an out-of-range display value rounds to
 * the same endpoint. The tool layer surfaces a clamp note when needed.
 */
export type DisplayScale = 'linear' | 'log10';

export interface DisplayToWireOptions {
    readonly displayMin: number;
    readonly displayMax: number;
    readonly displayScale?: DisplayScale; // defaults to 'linear'
}

export function displayToWire(display: number, opts: DisplayToWireOptions): number {
    if (!Number.isFinite(display)) {
        throw new Error(`displayToWire: display value must be finite, got ${display}`);
    }
    const { displayMin, displayMax, displayScale = 'linear' } = opts;
    if (displayMin >= displayMax) {
        throw new Error(`displayToWire: displayMin (${displayMin}) must be < displayMax (${displayMax})`);
    }

    if (displayScale === 'log10') {
        if (displayMin <= 0 || displayMax <= 0) {
            throw new Error(`displayToWire: log10 scale requires positive displayMin/displayMax, got ${displayMin}/${displayMax}`);
        }
        const clamped = Math.min(displayMax, Math.max(displayMin, display));
        const ratio = Math.log10(clamped / displayMin) / Math.log10(displayMax / displayMin);
        return Math.round(ratio * 65534);
    }

    // linear (default)
    const clamped = Math.min(displayMax, Math.max(displayMin, display));
    const ratio = (clamped - displayMin) / (displayMax - displayMin);
    return Math.round(ratio * 65534);
}

/**
 * Inverse of `displayToWire`. Wire 0..65534 → display value via the
 * param's linear or log10 scale.
 */
export function wireToDisplay(wire: number, opts: DisplayToWireOptions): number {
    if (!Number.isInteger(wire) || wire < 0 || wire > 65534) {
        throw new Error(`wireToDisplay: wire value out of range: ${wire}`);
    }
    const { displayMin, displayMax, displayScale = 'linear' } = opts;
    if (displayMin >= displayMax) {
        throw new Error(`wireToDisplay: displayMin (${displayMin}) must be < displayMax (${displayMax})`);
    }

    if (displayScale === 'log10') {
        if (displayMin <= 0 || displayMax <= 0) {
            throw new Error(`wireToDisplay: log10 scale requires positive displayMin/displayMax, got ${displayMin}/${displayMax}`);
        }
        return displayMin * Math.pow(displayMax / displayMin, wire / 65534);
    }

    return displayMin + (wire / 65534) * (displayMax - displayMin);
}
