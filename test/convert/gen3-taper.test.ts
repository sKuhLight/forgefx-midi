/**
 * W5.1 red/green — gen-3 convert taper must mirror the LIVE server rule.
 *
 * The live server (ForgeFX/server/src/drivers/gen3.ts #display) decides the
 * taper from the DEVICE-TRUE range row: an explicit `range.taper` wins
 * ('log' → log10), otherwise the typecode-nibble heuristic
 * `(typecode >> 4) & 0xf ∈ {4,5}` ⇒ log10 (guarded by displayMin > 0).
 *
 * The convert resolver instead read `param.scaling === 'log10'`, which most
 * FM3 catalog rows do not carry — so `delay.locut` (typecode 0x241, nibble 4,
 * displayMin 20) rendered linear offline but log live.
 */
import { resolveTargetRange } from '../../src/convert/targetRanges.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`gen3-taper: ${msg}`);
}

export const GEN3_TAPER_CASE_COUNT = 5;

export function runGen3TaperTests(): void {
  // delay.locut: FM3 device-true typecode 0x241 → nibble 4 → log10.
  const locut = resolveTargetRange('fm3', 'delay', 'locut');
  assert(locut !== undefined, 'fm3 delay locut range missing');
  assert(
    locut!.min === 20 && locut!.max === 2000,
    `fm3 delay locut expected 20..2000, got ${JSON.stringify(locut)}`,
  );
  assert(
    locut!.log === true,
    `fm3 delay locut must report log === true (typecode 0x241 → nibble 4); got ${JSON.stringify(locut)}`,
  );

  // delay.hicut: typecode 0x240 → nibble 4 → log10.
  const hicut = resolveTargetRange('fm3', 'delay', 'hicut');
  assert(
    hicut!.log === true,
    `fm3 delay hicut must report log === true (typecode 0x240 → nibble 4); got ${JSON.stringify(hicut)}`,
  );

  // A non-log device-true range must stay linear (no false positives).
  const cabLevel = resolveTargetRange('fm3', 'cab', 'level');
  assert(
    cabLevel!.log !== true,
    `fm3 cab level (typecode 0x162 → nibble 6) must stay linear; got ${JSON.stringify(cabLevel)}`,
  );

  // The rule is not delay-specific: amp Bright Cap (typecode 0x841 → nibble 4)
  // must be log too — this param's catalog row DOES carry scaling:'log10', so a
  // genuine range-driven taper is what the test pins.
  const brightCap = resolveTargetRange('fm3', 'amp', 'brightcap');
  assert(
    brightCap !== undefined && brightCap.log === true,
    `fm3 amp brightcap (typecode 0x841 → nibble 4) must report log === true; got ${JSON.stringify(brightCap)}`,
  );
}
