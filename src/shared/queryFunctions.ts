/**
 * Read/query function bytes per device family — the functions (header byte
 * f[5]) whose request only asks the unit for state and never changes it. Meant
 * as the ALLOWLIST for raw SysEx probes: a frame is a query frame only when it
 * is addressed to a known model byte (or the 0x7F broadcast) and its function
 * byte is listed for that model's family. Everything else is not.
 *
 *   gen-3 (Axe-Fx III / FM3 / FM9 / VP4): 0x03 request preset dump,
 *     0x08 firmware version, 0x0D query patch name, 0x0E query scene name,
 *     0x13 status dump, 0x1F block bulk read, 0x43 request edit-buffer dump.
 *   gen-2 (Axe-Fx II / FX8 / AX8): WHO_AM_I plus every GET_* / QUERY_* opcode of
 *     the Axe-Fx II opcode table.
 *   AM4: 0x03 request preset dump, 0x08 firmware version, 0x1F get all params.
 *   gen-1 (Axe-Fx Standard / Ultra): 0x03 get patch.
 *   0x7F broadcast: 0x00 identify only.
 *
 * The lists are literal so this module stays free of device-family imports;
 * tests pin each one against the family's own builders / opcode table, so a
 * regenerated table cannot silently widen them.
 *
 * Deliberately on no list:
 *   - dual-use functions that carry writes as well as reads (gen-3 0x01 and its
 *     SET_GET pairs, which include the store-preset sub-action; AM4 0x01; gen-1
 *     and gen-2 0x02 parameter set/get). Specific gen-3 read/poll frames on 0x01
 *     are recognised byte-for-byte by `isGen3ReadPollFrame` (gen3/axe-fx-iii);
 *   - dump / IR / firmware streams 0x74–0x7F (preset dump 0x77/0x78/0x79, cab
 *     IR 0x7A–0x7C, firmware transfer 0x7D–0x7F — see `firmwareTransfer.ts`).
 *     For 0x79 there is also an external report, not verified in this project,
 *     that gen-3 units treat it as firmware-transfer traffic when it is sent on
 *     its own rather than as the footer of a preset dump;
 *   - the Axe-Fx II update/erase opcodes (FW/FPGA/MICRO update 0x25–0x27,
 *     ERASE_SECTOR 0x34, FW_UPDATE_END 0x60, 0x6A–0x6E, 0x73).
 *
 * Header-level check only: callers validate the SysEx framing (F0 … F7,
 * 7-bit data) themselves. Pure and transport-agnostic.
 */
import { DEVICE_MODELS, FN_IDENTIFY, MODEL_BROADCAST, isFractalHeaderFrame } from './identify.js';
import { FN_FIRMWARE_VERSION } from './firmware.js';

/** Read/query function bytes keyed by device generation (`DEVICE_MODELS[model].gen`). */
export const QUERY_FUNCTIONS_BY_GEN: Readonly<Record<1 | 2 | 3 | 4, readonly number[]>> = Object.freeze({
  1: Object.freeze([0x03]),
  2: Object.freeze([
    0x00, FN_FIRMWARE_VERSION, 0x0e, 0x0f, 0x15, 0x16, 0x17, 0x18, 0x1f, 0x20, 0x28, 0x2a, 0x30, 0x35, 0x36, 0x3a, 0x47,
  ]),
  3: Object.freeze([0x03, FN_FIRMWARE_VERSION, 0x0d, 0x0e, 0x13, 0x1f, 0x43]),
  4: Object.freeze([0x03, FN_FIRMWARE_VERSION, 0x1f]),
});

/** Read/query function bytes allowed for the 0x7F broadcast model byte. */
export const BROADCAST_QUERY_FUNCTIONS: readonly number[] = Object.freeze([FN_IDENTIFY]);

/** The read/query function bytes for a model byte; empty for an unknown model. */
export function queryFunctionsForModel(model: number): readonly number[] {
  if (model === MODEL_BROADCAST) return BROADCAST_QUERY_FUNCTIONS;
  const gen = DEVICE_MODELS[model]?.gen;
  return gen === 1 || gen === 2 || gen === 3 || gen === 4 ? QUERY_FUNCTIONS_BY_GEN[gen] : [];
}

/**
 * True when `frame` carries the Fractal header, a known model byte (or the
 * 0x7F broadcast), and a read/query function byte for that model's family.
 */
export function isQueryFrame(frame: ArrayLike<number>): boolean {
  if (!isFractalHeaderFrame(frame)) return false;
  return queryFunctionsForModel(frame[4]!).includes(frame[5]!);
}
