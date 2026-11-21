/**
 * Firmware-transfer function bytes (0x7D/0x7E/0x7F) — predicate, frame helpers
 * and buffer scan, plus a sweep over the codec's shared + gen-3 telemetry
 * builders (none may emit one). The gen-3 bound-codec builder surface is swept
 * in `gen3/modern-family/boundcodec.test.ts`.
 */
import {
  FIRMWARE_TRANSFER_FUNCTIONS,
  isFirmwareTransferFunction,
  isFirmwareTransferFrame,
  findFirmwareTransferFrame,
} from '../../src/shared/firmwareTransfer.js';
import { buildIdentifyBroadcast, sysexFunctionByte } from '../../src/shared/identify.js';
import { buildFirmwareVersionQuery } from '../../src/shared/firmware.js';
import { fractalChecksum } from '../../src/shared/checksum.js';
import {
  AM4_FUNC_FIRMWARE_HEADER,
  AM4_FUNC_FIRMWARE_BLOCK,
  AM4_FUNC_FIRMWARE_FINALIZE,
  AM4_FUNC_PRESET_FOOTER,
} from '../../src/am4/index.js';
import { AXE_FX_II_OPCODES } from '../../src/gen2/axe-fx-ii/opcodes.js';
import {
  buildTunerPageOpen,
  buildTunerPageClose,
  buildTunerPoll,
  GEN3_OUTPUT_METERS,
  buildOutputMeterPoll,
  buildCpuPoll,
} from '../../src/gen3/axe-fx-iii/telemetry.js';

function fail(msg: string): never {
  throw new Error(`[shared/firmwareTransfer] ${msg}`);
}

const hx = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

/** A checksummed Fractal frame `F0 00 01 74 <model> <fn> <payload…> cs F7`. */
function frame(model: number, fn: number, payload: number[] = []): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

const GEN3_MODELS = [0x10, 0x11, 0x12, 0x14] as const;
const FW = [0x7d, 0x7e, 0x7f];

export const FIRMWARE_TRANSFER_CASE_COUNT = 9;

export function runFirmwareTransferTests(): void {
  // 1 ── exactly the firmware .syx envelope, immutable; matches the AM4 envelope + the gen-2 table names
  if (FIRMWARE_TRANSFER_FUNCTIONS.join(',') !== FW.join(',')) fail(`list ${FIRMWARE_TRANSFER_FUNCTIONS.map(hx)}`);
  if (!Object.isFrozen(FIRMWARE_TRANSFER_FUNCTIONS)) fail('FIRMWARE_TRANSFER_FUNCTIONS is not frozen');
  const am4 = [AM4_FUNC_FIRMWARE_HEADER, AM4_FUNC_FIRMWARE_BLOCK, AM4_FUNC_FIRMWARE_FINALIZE];
  if (am4.join(',') !== FW.join(',')) fail(`AM4 firmware envelope ${am4.map(hx)} differs`);
  if (!isFirmwareTransferFunction(AXE_FX_II_OPCODES.FW_UPDATE_START)) fail('gen-2 FW_UPDATE_START not covered');
  if (!isFirmwareTransferFunction(AXE_FX_II_OPCODES.FW_UPDATE_DATA)) fail('gen-2 FW_UPDATE_DATA not covered');

  // 2 ── 0x79 is the preset-dump footer in the codec, not a firmware-transfer function
  if (isFirmwareTransferFunction(AM4_FUNC_PRESET_FOOTER)) fail('0x79 (preset-dump footer) listed as firmware transfer');
  if (isFirmwareTransferFunction(AXE_FX_II_OPCODES.PATCH_END)) fail('gen-2 PATCH_END listed as firmware transfer');
  for (const fn of [0x00, 0x01, 0x08, 0x1f, 0x77, 0x78, 0x7a, 0x7b, 0x7c]) {
    if (isFirmwareTransferFunction(fn)) fail(`isFirmwareTransferFunction(${hx(fn)}) true`);
  }

  // 3 ── sysexFunctionByte: f[5] of a Fractal frame (array or typed array), null otherwise
  if (sysexFunctionByte(frame(0x11, 0x08)) !== 0x08) fail('sysexFunctionByte did not return f[5]');
  if (sysexFunctionByte(Uint8Array.from(frame(0x11, 0x1f))) !== 0x1f) fail('sysexFunctionByte(Uint8Array) wrong');
  if (sysexFunctionByte([0xf0, 0x43, 0x00, 0x08, 0x11, 0x7d, 0x00, 0xf7]) !== null) fail('non-Fractal frame not null');
  if (sysexFunctionByte([0xf0, 0x00, 0x01, 0x74, 0x11]) !== null) fail('header without fn byte not null');

  // 4 ── isFirmwareTransferFrame on every gen-3 model byte and AM4; benign fns not
  for (const model of [...GEN3_MODELS, 0x15]) {
    for (const fn of FW) {
      if (!isFirmwareTransferFrame(frame(model, fn))) fail(`frame model ${hx(model)} fn ${hx(fn)} not flagged`);
    }
    if (isFirmwareTransferFrame(frame(model, 0x79, [0, 0, 0]))) fail(`0x79 footer flagged on model ${hx(model)}`);
  }

  // 5 ── scan: single frame at offset 0 (typed array input)
  const single = findFirmwareTransferFrame(Uint8Array.from(frame(0x11, 0x7e))) ?? fail('single 0x7e frame not found');
  if (single.offset !== 0 || single.model !== 0x11 || single.fn !== 0x7e) fail(`single hit ${JSON.stringify(single)}`);

  // 6 ── scan: a firmware frame after a benign one is found at its own offset
  const benign = frame(0x11, 0x08);
  const tail = findFirmwareTransferFrame([...benign, ...frame(0x11, 0x7d, [0x01])]) ?? fail('trailing 0x7d not found');
  if (tail.offset !== benign.length || tail.fn !== 0x7d) fail(`trailing hit ${JSON.stringify(tail)}`);

  // 7 ── scan: leading junk does not hide a header
  const junk = findFirmwareTransferFrame([0x00, 0x7f, 0xf7, ...frame(0x10, 0x7f)]) ?? fail('0x7f after junk not found');
  if (junk.offset !== 3 || junk.model !== 0x10 || junk.fn !== 0x7f) fail(`junk hit ${JSON.stringify(junk)}`);

  // 8 ── scan: benign buffers, a preset-dump footer and a truncated header are clean
  if (findFirmwareTransferFrame([...benign, ...frame(0x12, 0x79, [1, 2, 3])]) !== null) fail('benign/footer buffer flagged');
  if (findFirmwareTransferFrame([0xf0, 0x00, 0x01, 0x74, 0x11]) !== null) fail('truncated header flagged');

  // 9 ── the codec's shared + gen-3 telemetry builders never emit a firmware-transfer function
  const built: Array<[string, number[]]> = [['buildIdentifyBroadcast', buildIdentifyBroadcast()]];
  for (const m of GEN3_MODELS) {
    built.push([`buildFirmwareVersionQuery(${hx(m)})`, buildFirmwareVersionQuery(m)]);
    built.push([`buildTunerPageOpen(${hx(m)})`, buildTunerPageOpen(m)]);
    built.push([`buildTunerPageClose(${hx(m)})`, buildTunerPageClose(m)]);
    built.push([`buildTunerPoll(${hx(m)})`, buildTunerPoll(m)]);
    built.push([`buildCpuPoll(${hx(m)})`, buildCpuPoll(m)]);
    for (const meter of GEN3_OUTPUT_METERS) built.push([`buildOutputMeterPoll(${hx(m)})`, buildOutputMeterPoll(meter, m)]);
  }
  for (const [name, bytes] of built) {
    const hit = findFirmwareTransferFrame(bytes);
    if (hit) fail(`${name} emits firmware-transfer function ${hx(hit.fn)}`);
  }
}
