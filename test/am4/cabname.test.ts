/**
 * AM4 cab/IR name read (user bank + scratchpads).
 *
 * The request is the READ_PRESET_NAME encoder pointed at a different register
 * pair (`0x3E` / `0x0C`); the reply is the same packed 32-byte name field plus
 * an optional attribute byte that carries the IR resolution class. These cases
 * pin the frame shape, the slot space, the reply parser (32- and 33-byte raw
 * forms) and the resolution mapping.
 */
import {
  buildGetCabName,
  parseGetCabNameResponse,
  buildGetPresetName,
  CAB_NAME_PID_LOW,
  CAB_NAME_PID_HIGH,
  CAB_NAME_SLOT_MAX,
  CAB_NAME_EMPTY_SENTINEL,
  CAB_RESOLUTION_BY_ATTRIBUTE,
} from '../../src/am4/setParam.js';
import { packValue, packValueChunked, unpackValue } from '../../src/shared/packValue.js';
import { fractalChecksum } from '../../src/shared/checksum.js';

function fail(msg: string): never {
  throw new Error(`[am4/cabname] ${msg}`);
}

const HX = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');

/** Build a reply frame the way the device does: 16-byte header + packed payload + cs + F7. */
function reply(hdr4: number, raw: number[], extra: number[] = []): number[] {
  // 32/33 raw bytes go through the chunked (7-raw -> 8-wire) packer, like the name field.
  const packed = Array.from(packValueChunked(Uint8Array.from(raw)));
  const body = [
    0xf0, 0x00, 0x01, 0x74, 0x15, 0x01,
    ...encode14(CAB_NAME_PID_LOW),
    ...encode14(CAB_NAME_PID_HIGH),
    ...encode14(0x0012),
    ...encode14(0x0000),
    ...encode14(hdr4),
    ...packed,
    ...extra,
  ];
  return [...body, fractalChecksum(body), 0xf7];
}

function encode14(v: number): number[] {
  return [v & 0x7f, (v >> 7) & 0x7f];
}

export const AM4_CABNAME_CASE_COUNT = 8;

export function runAm4CabNameTests(): void {
  // 1 - the request is the preset-name shape with the cab register pair
  const cab = buildGetCabName(0x15);
  const preset = buildGetPresetName(0x15);
  if (cab.length !== 23) fail(`request length ${cab.length} !== 23`);
  if (preset.length !== cab.length) fail('preset/cab request lengths differ');
  if (HX(cab.slice(0, 6)) !== HX(preset.slice(0, 6))) fail('envelope/func prefix differs');
  if (HX(cab.slice(10, cab.length - 2)) !== HX(preset.slice(10, preset.length - 2))) {
    fail('header/payload after the pid pair must be identical (checksum excluded)');
  }
  if ((cab[6]! | (cab[7]! << 7)) !== CAB_NAME_PID_LOW) fail('pidLow wrong');
  if ((cab[8]! | (cab[9]! << 7)) !== CAB_NAME_PID_HIGH) fail('pidHigh wrong');
  if (cab[cab.length - 1] !== 0xf7) fail('missing F7');

  // 2 - checksum is valid and the payload round-trips to the slot
  const cs = cab[cab.length - 2]!;
  if (cs !== fractalChecksum(cab.slice(0, cab.length - 2))) fail('checksum mismatch');
  const payload = cab.slice(16, 21);
  const back = unpackValue(Uint8Array.from(payload), 4);
  if (back[0] !== 0x15 || back[1] !== 0 || back[2] !== 0 || back[3] !== 0) {
    fail(`payload does not encode slot 0x15: ${HX(Array.from(back))}`);
  }

  // 3 - slot space: user bank 0..255 plus two scratchpads at 0x100/0x101
  if (CAB_NAME_SLOT_MAX !== 0x101) fail(`slot max ${CAB_NAME_SLOT_MAX}`);
  for (const ok of [0, 1, 255, 0x100, 0x101]) {
    if (buildGetCabName(ok).length !== 23) fail(`slot ${ok} rejected`);
  }
  for (const bad of [-1, 0x102, 1.5]) {
    let threw = false;
    try { buildGetCabName(bad); } catch { threw = true; }
    if (!threw) fail(`slot ${bad} accepted`);
  }

  // 4 - reply with a 32-byte name only (hdr4 = 32)
  const name = 'OH 412 MES V30';
  const raw32 = new Array(32).fill(0);
  for (let i = 0; i < name.length; i++) raw32[i] = name.charCodeAt(i);
  const r32 = reply(32, raw32);
  const p32 = parseGetCabNameResponse(r32, 7);
  if (p32.name !== name) fail(`name '${p32.name}' !== '${name}'`);
  if (p32.isEmpty) fail('populated name reported empty');
  if (p32.resolution !== undefined) fail('resolution present without an attribute byte');

  // 5 - reply with name + attribute (hdr4 = 33) carries the resolution class
  for (const [attr, want] of Object.entries(CAB_RESOLUTION_BY_ATTRIBUTE)) {
    const r33 = reply(33, [...raw32, Number(attr)]);
    const p33 = parseGetCabNameResponse(r33, 7);
    if (p33.resolution !== want) fail(`attribute ${attr} -> ${p33.resolution}, expected ${want}`);
    if (p33.attribute !== Number(attr)) fail(`attribute byte ${p33.attribute}`);
  }

  // 6 - empty slot: the device answers "<EMPTY>"
  const rawEmpty = new Array(32).fill(0);
  for (let i = 0; i < CAB_NAME_EMPTY_SENTINEL.length; i++) rawEmpty[i] = CAB_NAME_EMPTY_SENTINEL.charCodeAt(i);
  const pe = parseGetCabNameResponse(reply(33, [...rawEmpty, 255]), 200);
  if (!pe.isEmpty) fail(`'${pe.name}' not reported empty`);
  if (pe.resolution !== 'empty') fail(`empty slot resolution ${pe.resolution}`);

  // 7 - wrong register pair / model / checksum are rejected (no silent misroute)
  const wrongPid = [...r32];
  wrongPid[8] = 0x0b; // pretend pidHigh 0x0b (preset names)
  let threw = false;
  try { parseGetCabNameResponse(wrongPid, 7); } catch { threw = true; }
  if (!threw) fail('preset-name reply accepted as a cab name');

  const badCs = [...r32];
  badCs[badCs.length - 2] = (badCs[badCs.length - 2]! ^ 0x01) & 0x7f;
  threw = false;
  try { parseGetCabNameResponse(badCs, 7); } catch { threw = true; }
  if (!threw) fail('bad checksum accepted');

  // 8 - a payload length that disagrees with hdr4 is rejected
  threw = false;
  try { parseGetCabNameResponse(reply(33, raw32), 7); } catch { threw = true; }
  if (!threw) fail('hdr4/payload length disagreement accepted');
}
