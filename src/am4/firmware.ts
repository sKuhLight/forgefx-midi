/**
 * AM4 firmware-update .syx envelope — parse / validate / serialize.
 *
 * A firmware image is distributed as a SysEx stream of three message types:
 *
 *   1×      func 0x7D   FIRMWARE_HEADER   (5-byte payload: version/target tag)
 *   N×      func 0x7E   FIRMWARE_BLOCK    (uniform data blocks; positional order,
 *                                          no per-block sequence number on the wire)
 *   1×      func 0x7F   FIRMWARE_FINALIZE (5-byte payload)
 *
 * Verified against `AM4_firmware_v2p01.syx` (fw 2.01): 1 header + 7144 blocks
 * (490 bytes each) + 1 finalize = 7146 messages, every one passing the standard
 * Fractal XOR checksum, all payload bytes 7-bit clean.
 *
 * ── SCOPE: validation/inspection only, NOT a flasher ────────────────
 * This module parses, integrity-checks, and byte-identically re-serializes a
 * firmware file so a host can verify it before use and read its header. It does
 * NOT send firmware to a device — a bad flash bricks hardware, and Fractal's own
 * Fractal-Bot is the supported updater. Any on-device apply must be a separate,
 * explicit, well-guarded path. The block payload contents are opaque (not decoded);
 * only the envelope + checksums are validated.
 */

import { fractalChecksum } from '../shared/index.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL_ID = 0x15;

export const AM4_FUNC_FIRMWARE_HEADER = 0x7d;
export const AM4_FUNC_FIRMWARE_BLOCK = 0x7e;
export const AM4_FUNC_FIRMWARE_FINALIZE = 0x7f;

/** Data-block length observed in fw 2.01 (envelope + payload). Blocks are uniform. */
export const AM4_FIRMWARE_BLOCK_LEN = 490;

/** Parsed firmware image: the three message groups, payloads only. */
export interface Am4Firmware {
  /** 0x7D header payload (5 bytes: version/target tag). */
  readonly headerPayload: Uint8Array;
  /** Ordered 0x7E data-block payloads (opaque firmware bytes). */
  readonly blockPayloads: readonly Uint8Array[];
  /** 0x7F finalize payload. */
  readonly finalizePayload: Uint8Array;
  /** Total message count (header + blocks + finalize). */
  readonly messageCount: number;
}

function hex(b: number): string {
  return '0x' + b.toString(16).padStart(2, '0');
}

/** Split a buffer into complete F0..F7 SysEx messages. Throws on an unterminated trailer. */
function splitSysex(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== SYSEX_START) {
      throw new Error(`parseAm4Firmware: expected F0 at offset ${i}, got ${hex(bytes[i]!)}`);
    }
    const end = bytes.indexOf(SYSEX_END, i);
    if (end < 0) throw new Error(`parseAm4Firmware: unterminated SysEx at offset ${i}`);
    out.push(bytes.subarray(i, end + 1));
    i = end + 1;
  }
  return out;
}

/** Validate one message's envelope + checksum and return its payload (between func and cs). */
function checkMessage(m: Uint8Array, expectedFunc: number, what: string): Uint8Array {
  if (m.length < 8) throw new Error(`${what}: too short (${m.length} bytes)`);
  if (m[0] !== SYSEX_START) throw new Error(`${what}: missing F0`);
  for (let k = 0; k < FRACTAL_MFR.length; k++) {
    if (m[1 + k] !== FRACTAL_MFR[k]) throw new Error(`${what}: bad Fractal manufacturer ID`);
  }
  if (m[4] !== AM4_MODEL_ID) throw new Error(`${what}: expected AM4 model 0x15, got ${hex(m[4]!)}`);
  if (m[5] !== expectedFunc) {
    throw new Error(`${what}: expected function ${hex(expectedFunc)}, got ${hex(m[5]!)}`);
  }
  if (m[m.length - 1] !== SYSEX_END) throw new Error(`${what}: missing F7`);
  const want = m[m.length - 2]!;
  const got = fractalChecksum(Array.from(m.subarray(0, m.length - 2)));
  if (want !== got) {
    throw new Error(`${what}: checksum mismatch (expected ${hex(got)}, got ${hex(want)})`);
  }
  const payload = m.subarray(6, m.length - 2);
  for (let k = 0; k < payload.length; k++) {
    if (payload[k]! > 0x7f) throw new Error(`${what}: non-7-bit payload byte at +${k}`);
  }
  return payload;
}

/**
 * Parse and fully validate an AM4 firmware .syx image.
 *
 * Requires exactly one 0x7D header first, one or more 0x7E blocks, and exactly
 * one 0x7F finalize last (nothing after it). Every message's envelope, model
 * byte, checksum, and 7-bit payload are checked. Throws on any deviation.
 */
export function parseAm4Firmware(bytes: Uint8Array): Am4Firmware {
  const msgs = splitSysex(bytes);
  if (msgs.length < 3) {
    throw new Error(`parseAm4Firmware: need header + >=1 block + finalize, got ${msgs.length} messages`);
  }

  const first = msgs[0]!;
  if (first[5] !== AM4_FUNC_FIRMWARE_HEADER) {
    throw new Error(`parseAm4Firmware: first message must be 0x7D header, got ${hex(first[5]!)}`);
  }
  const last = msgs[msgs.length - 1]!;
  if (last[5] !== AM4_FUNC_FIRMWARE_FINALIZE) {
    throw new Error(`parseAm4Firmware: last message must be 0x7F finalize, got ${hex(last[5]!)}`);
  }

  const headerPayload = checkMessage(first, AM4_FUNC_FIRMWARE_HEADER, 'FIRMWARE_HEADER (0x7D)');
  const finalizePayload = checkMessage(last, AM4_FUNC_FIRMWARE_FINALIZE, 'FIRMWARE_FINALIZE (0x7F)');

  const blockPayloads: Uint8Array[] = [];
  for (let i = 1; i < msgs.length - 1; i++) {
    const m = msgs[i]!;
    if (m[5] !== AM4_FUNC_FIRMWARE_BLOCK) {
      throw new Error(
        `parseAm4Firmware: message ${i} must be 0x7E block, got ${hex(m[5]!)} ` +
          `(only header→blocks→finalize allowed)`,
      );
    }
    blockPayloads.push(Uint8Array.from(checkMessage(m, AM4_FUNC_FIRMWARE_BLOCK, `FIRMWARE_BLOCK #${i}`)));
  }

  return {
    headerPayload: Uint8Array.from(headerPayload),
    blockPayloads,
    finalizePayload: Uint8Array.from(finalizePayload),
    messageCount: msgs.length,
  };
}

function buildMessage(func: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + payload.length + 2);
  out[0] = SYSEX_START;
  out[1] = FRACTAL_MFR[0];
  out[2] = FRACTAL_MFR[1];
  out[3] = FRACTAL_MFR[2];
  out[4] = AM4_MODEL_ID;
  out[5] = func;
  out.set(payload, 6);
  const csIndex = 6 + payload.length;
  out[csIndex] = fractalChecksum(Array.from(out.subarray(0, csIndex)));
  out[csIndex + 1] = SYSEX_END;
  return out;
}

/**
 * Re-serialize a parsed firmware image to its wire bytes. For any input that came
 * from `parseAm4Firmware`, the output is byte-identical — the integrity round-trip.
 */
export function serializeAm4Firmware(fw: Am4Firmware): Uint8Array {
  const parts: Uint8Array[] = [buildMessage(AM4_FUNC_FIRMWARE_HEADER, fw.headerPayload)];
  for (const b of fw.blockPayloads) parts.push(buildMessage(AM4_FUNC_FIRMWARE_BLOCK, b));
  parts.push(buildMessage(AM4_FUNC_FIRMWARE_FINALIZE, fw.finalizePayload));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
