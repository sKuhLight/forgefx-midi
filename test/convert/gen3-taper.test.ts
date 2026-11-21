/**
 * Gen-3 convert taper must mirror the LIVE server rule.
 *
 * The live server (ForgeFX/server/src/drivers/gen3.ts #display) decides the
 * taper from the DEVICE-TRUE range row: an explicit `range.taper` wins
 * ('log' → log10), otherwise the typecode-nibble heuristic: only
 * `(typecode >> 4) & 0xf === 4` ⇒ log10 (guarded by displayMin > 0); every other
 * nibble, including 5, is linear.
 *
 * The convert resolver instead read `param.scaling === 'log10'`, which most
 * FM3 catalog rows do not carry — so `delay.locut` (typecode 0x241, nibble 4,
 * displayMin 20) rendered linear offline but log live.
 */
import { gen3TaperIsLog, resolveTargetRange, type Gen3RangeRow } from '../../src/convert/targetRanges.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`gen3-taper: ${msg}`);
}

export const GEN3_TAPER_CASE_COUNT = 7;

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

  // delay.drive is a typecode-0x52 knob: the device shows it on a linear 0..10 scale (the shipped
  // row carries displayMin 0, displayMax 10 and an explicit linear taper), not the definition's
  // 0.5..500 bounds, and it is never log.
  const drive = resolveTargetRange('fm3', 'delay', 'drive');
  assert(drive !== undefined, 'fm3 delay drive range missing');
  assert(
    drive!.min === 0 && drive!.max === 10,
    `fm3 delay drive expected 0..10 (typecode-0x52 knob), got ${JSON.stringify(drive)}`,
  );
  assert(
    drive!.log !== true,
    `fm3 delay drive (typecode 0x52 knob) must be linear; got ${JSON.stringify(drive)}`,
  );

  // The nibble rule itself, on synthetic rows (no shipped FM3 float row with a positive displayMin
  // and nibble 5 exists besides the 0x52 knobs, whose explicit taper now decides): nibble 5 is
  // linear while nibble 4 is log, an explicit taper wins either way, and a log sweep needs a
  // positive displayMin.
  const row = (typecode: number, extra: Partial<Gen3RangeRow> = {}): Gen3RangeRow =>
    ({ kind: 'float', displayMin: 0.5, displayMax: 500, typecode, ...extra });
  assert(!gen3TaperIsLog(row(0x52)), 'synthetic nibble-5 row (0x52, no taper) must be linear');
  assert(gen3TaperIsLog(row(0x42)), 'synthetic nibble-4 row (0x42) must be log');
  assert(gen3TaperIsLog(row(0x52, { taper: 'log' })), 'an explicit log taper must win over nibble 5');
  assert(!gen3TaperIsLog(row(0x42, { taper: 'linear' })), 'an explicit linear taper must win over nibble 4');
  assert(!gen3TaperIsLog(row(0x42, { displayMin: 0 })), 'a log sweep needs a positive displayMin');
  assert(!gen3TaperIsLog(undefined), 'no range row means linear');
}
