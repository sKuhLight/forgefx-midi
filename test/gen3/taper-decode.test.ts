/**
 * gen-3 taper-aware value decode.
 *
 * `readBlockParams` decoded every continuous param linearly, so a log-taper param read wrong: an FM3
 * delay low cut (20..2000 Hz) at mid sweep came back as ~1010 Hz instead of 200 Hz. The decode now
 * shares the taper rule with the converter (`gen3TaperIsLog`), and the stored raw / `normalized` stay
 * exact either way.
 *
 * Synthetic input only: a hand-built FM3 body holding one delay block header and a few raw params.
 */
import { liftGen3Preset } from '../../src/convert/adapters/gen3.js';
import { FM3_BODY_LAYOUT, readBlockParamsForModel } from '../../src/devices/gen3/blockParams.js';
import { gen3RawToDisplay, gen3TaperIsLog } from '../../src/devices/gen3/taper.js';
import { displayToWire } from '../../src/shared/index.js';

export const TAPER_DECODE_CASE_COUNT = 4;

const FM3 = 0x11;
const DELAY_EID = 70;
const DELAY_MIX_ID = 0; // linear 0..100 %
const DELAY_LOCUT_ID = 16; // log 20..2000 Hz (typecode nibble 4)
const MID = 32767;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[gen3/taper-decode] ${msg}`);
}
function near(actual: number | null | undefined, want: number, tol: number, what: string): void {
  assert(typeof actual === 'number' && Math.abs(actual - want) <= tol, `${what}: ${actual} (want ${want} ± ${tol})`);
}

function synthDelayBody(raw: Readonly<Record<number, number>>): Uint8Array {
  const header = FM3_BODY_LAYOUT.paramRegionFloor + 16;
  const body = new Uint8Array(header + FM3_BODY_LAYOUT.paramArrayBase + 2 * 200);
  body[header] = DELAY_EID & 0xff;
  body[header + 1] = DELAY_EID >> 8;
  for (const [pid, value] of Object.entries(raw)) {
    const off = header + FM3_BODY_LAYOUT.paramArrayBase + 2 * Number(pid);
    body[off] = value & 0xff;
    body[off + 1] = (value >> 8) & 0xff;
  }
  return body;
}

function decodeDelay(raw: Readonly<Record<number, number>>): Map<string, { raw: number; value: number | null }> {
  const blocks = readBlockParamsForModel(synthDelayBody(raw), new Set([DELAY_EID]), FM3);
  const delay = blocks.find((b) => b.family === 'DELAY');
  assert(delay !== undefined, 'delay block not decoded from the synthetic body');
  return new Map(delay!.params.map((p) => [p.name, { raw: p.raw, value: p.value }]));
}

/** 1. The taper rule on synthetic rows: explicit taper wins, only nibble 4 is log, log needs a positive min. */
function caseRule(): void {
  const row = { displayMin: 20, displayMax: 2000 };
  assert(gen3TaperIsLog({ ...row, typecode: 0x241 }), 'nibble 4 is log');
  assert(!gen3TaperIsLog({ ...row, typecode: 0x252 }), 'nibble 5 is linear');
  assert(!gen3TaperIsLog({ ...row }), 'no typecode and no taper is linear');
  assert(!gen3TaperIsLog({ ...row, typecode: 0x241, taper: 'linear' }), 'an explicit linear taper beats the typecode');
  assert(gen3TaperIsLog({ ...row, typecode: 0x252, taper: 'log' }), 'an explicit log taper beats the typecode');
  assert(!gen3TaperIsLog({ ...row, typecode: 0x241, taper: 'custom' }), 'a custom taper is served linear');
  assert(!gen3TaperIsLog({ displayMin: 0, displayMax: 10, typecode: 0x241 }), 'a log sweep needs a positive min');

  const log = { ...row, typecode: 0x241 };
  near(gen3RawToDisplay(0, log), 20, 1e-9, 'log raw 0');
  near(gen3RawToDisplay(MID, log), 200, 1e-2, 'log mid sweep is the geometric mean');
  near(gen3RawToDisplay(65534, log), 2000, 1e-6, 'log raw 65534');
  near(gen3RawToDisplay(MID, { ...row }), 1010, 1e-1, 'linear mid sweep is the arithmetic mean');
}

/** 2. The block decoder uses it: delay low cut (log) vs delay mix (linear) at mid sweep. */
function caseDecode(): void {
  const mid = decodeDelay({ [DELAY_LOCUT_ID]: MID, [DELAY_MIX_ID]: MID });
  near(mid.get('DELAY_LOCUT')?.value, 200, 1e-2, 'delay low cut at mid sweep');
  near(mid.get('DELAY_MIX')?.value, 50, 1e-2, 'delay mix (linear) at mid sweep');

  const lo = decodeDelay({ [DELAY_LOCUT_ID]: 0 });
  near(lo.get('DELAY_LOCUT')?.value, 20, 1e-9, 'delay low cut at raw 0');
  const hi = decodeDelay({ [DELAY_LOCUT_ID]: 65534 });
  near(hi.get('DELAY_LOCUT')?.value, 2000, 1e-6, 'delay low cut at raw 65534');
}

/** 3. The decode inverts the writers' display -> wire mapping on the same taper. */
function caseRoundTrip(): void {
  for (const hz of [20, 100, 440, 2000]) {
    const raw = displayToWire(hz, { displayMin: 20, displayMax: 2000, displayScale: 'log10' });
    const decoded = decodeDelay({ [DELAY_LOCUT_ID]: raw }).get('DELAY_LOCUT')!;
    assert(decoded.raw === raw, `raw ${decoded.raw} != written ${raw}`);
    near(decoded.value, hz, hz * 1e-3, `low cut ${hz} Hz round trip`);
  }
}

/** 4. The IR lift keeps the exact wire position in `normalized`; only the display `value` changed. */
function caseLiftStaysExact(): void {
  const preset = liftGen3Preset(
    {
      grid: [{ effect_id: DELAY_EID, row: 0, col: 0, route_flag: 0, name: 'Delay 1' }],
      blocks: [],
      decompressed_body: synthDelayBody({ [DELAY_LOCUT_ID]: MID }),
    },
    'fm3',
  );
  const locut = preset.blocks.find((b) => b.family === 'delay')?.params.find((p) => p.nativeName === 'locut');
  assert(locut !== undefined, 'lifted delay locut missing');
  near(locut!.value, 200, 1e-2, 'lifted locut value is the true display value');
  assert(locut!.normalized === MID / 65534, `lifted locut normalized ${locut!.normalized} (want the exact wire fraction)`);
}

export function runTaperDecodeTests(): void {
  caseRule();
  caseDecode();
  caseRoundTrip();
  caseLiftStaysExact();
}
