/**
 * Firmware-transfer function bytes — the SysEx functions (header byte f[5])
 * that carry a firmware image:
 *
 *   0x7D  firmware image header
 *   0x7E  firmware image data block
 *   0x7F  firmware image finalize
 *
 * Evidence: the AM4 firmware .syx envelope that `am4/firmware.ts` parses and
 * validates (one 0x7D header, N 0x7E blocks, one 0x7F finalize), and the Axe-Fx
 * II opcode names FW_UPDATE_START / FW_UPDATE_DATA for 0x7D / 0x7E. There is no
 * evidence of our own for the gen-3 family (Axe-Fx III / FM3 / FM9 / VP4); the
 * list is applied to it as a precaution. No builder in this codec emits these
 * functions for a device; `serializeAm4Firmware` re-serializes a file for
 * integrity checks only and is not a flasher.
 *
 * Other families name further update functions of their own (e.g. the Axe-Fx II
 * FPGA / micro-controller update opcodes in `gen2/axe-fx-ii/opcodes.ts`), so this
 * list is not a complete denylist for raw sends. A raw-probe path should allow
 * only known read/query frames instead — see `queryFunctions.ts`.
 *
 * Pure and transport-agnostic: predicates only.
 */
import { sysexFunctionByte } from './identify.js';

/** Function bytes that carry a firmware image (header / data block / finalize). */
export const FIRMWARE_TRANSFER_FUNCTIONS: readonly number[] = Object.freeze([0x7d, 0x7e, 0x7f]);

/** True when `fn` is one of FIRMWARE_TRANSFER_FUNCTIONS. */
export function isFirmwareTransferFunction(fn: number): boolean {
  return FIRMWARE_TRANSFER_FUNCTIONS.includes(fn);
}

/** True when `frame` is a Fractal-headed frame whose function byte is a firmware-transfer function. */
export function isFirmwareTransferFrame(frame: ArrayLike<number>): boolean {
  const fn = sysexFunctionByte(frame);
  return fn !== null && isFirmwareTransferFunction(fn);
}

/** Where a firmware-transfer frame was found inside a byte buffer. */
export interface FirmwareTransferFrameHit {
  /** Byte offset of the frame's F0. */
  offset: number;
  /** Model byte (f[4]) the frame is addressed to. */
  model: number;
  /** The firmware-transfer function byte (f[5]). */
  fn: number;
}

/**
 * Scan a byte buffer — one frame, several concatenated frames, or arbitrary
 * bytes — for the first Fractal-headed frame whose function byte is a
 * firmware-transfer function. Every `F0 00 01 74` header in the buffer is
 * checked, whatever precedes it, for any model byte. Null when there is none.
 */
export function findFirmwareTransferFrame(bytes: ArrayLike<number>): FirmwareTransferFrameHit | null {
  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] !== 0xf0 || bytes[i + 1] !== 0x00 || bytes[i + 2] !== 0x01 || bytes[i + 3] !== 0x74) continue;
    const fn = bytes[i + 5]!;
    if (isFirmwareTransferFunction(fn)) return { offset: i, model: bytes[i + 4]!, fn };
  }
  return null;
}
