/**
 * AM4 0x77/0x78/0x79 PRESET_DUMP frame codec — parse, validate, serialize.
 *
 * A single AM4 preset travels as a 6-message SysEx stream totaling 12,352
 * bytes (`AM4_PRESET_FRAME_SIZE`):
 *
 *   Msg 1   13B    func 0x77   PRESET_DUMP_HEADER  (5-byte payload)
 *   Msg 2  3082B   func 0x78   PRESET_DUMP_CHUNK 1 (3074-byte payload)
 *   Msg 3  3082B   func 0x78   PRESET_DUMP_CHUNK 2
 *   Msg 4  3082B   func 0x78   PRESET_DUMP_CHUNK 3
 *   Msg 5  3082B   func 0x78   PRESET_DUMP_CHUNK 4
 *   Msg 6   11B    func 0x79   PRESET_DUMP_FOOTER  (3-byte payload)
 *
 * Per the Fractal Presets Update Guide, the same byte stream the editor
 * exports to a `.syx` file uploads back to the device unchanged. The factory
 * bank file is exactly 104 back-to-back frames (26 banks A..Z × 4), so a bank
 * `.syx` slices into presets with no message scanning. Same-location replay of
 * a captured frame is hardware-verified as the backup/restore primitive.
 *
 * Addressing rides the 0x77 header payload: byte 0 = bank ordinal
 * (0x00..0x19 = A..Z), byte 1 = preset-in-bank (0..3). An ACTIVE-buffer
 * export carries the 0x7F sentinel bank instead of a stored location.
 *
 * This codec treats the chunk payloads as opaque blobs: the inner structure
 * (block types, param values, per-scene state, routing) is not yet decoded,
 * and the payload bytes are masked per-export — only the name field
 * (see `presetBinary.ts`) and the framing itself are mapped. Byte-identical
 * round-trip + per-message checksum validation is all backup/restore needs.
 */

import { AM4_PRESET_FRAME_SIZE } from './presetBinary.js';
import { formatLocationCode } from './locations.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const AM4_MODEL_ID = 0x15;

export const AM4_FUNC_PRESET_HEADER = 0x77;
export const AM4_FUNC_PRESET_CHUNK = 0x78;
export const AM4_FUNC_PRESET_FOOTER = 0x79;

export const AM4_PRESET_DUMP_HEADER_LEN = 13;
export const AM4_PRESET_DUMP_CHUNK_LEN = 3082;
export const AM4_PRESET_DUMP_FOOTER_LEN = 11;
export const AM4_PRESET_DUMP_CHUNKS = 4;

/** Bytes wrapping a payload: F0 + 3 mfr + model + func + cs + F7 = 8. */
const ENVELOPE_OVERHEAD = 8;

export const AM4_PRESET_DUMP_HEADER_PAYLOAD_LEN =
  AM4_PRESET_DUMP_HEADER_LEN - ENVELOPE_OVERHEAD; // 5
export const AM4_PRESET_DUMP_CHUNK_PAYLOAD_LEN =
  AM4_PRESET_DUMP_CHUNK_LEN - ENVELOPE_OVERHEAD; // 3074
export const AM4_PRESET_DUMP_FOOTER_PAYLOAD_LEN =
  AM4_PRESET_DUMP_FOOTER_LEN - ENVELOPE_OVERHEAD; // 3

/** Frames in the factory bank file (26 banks × 4). */
export const AM4_FACTORY_BANK_PRESET_COUNT = 104;

/** Bank byte carried by an active-buffer export instead of a stored location. */
export const AM4_DUMP_ACTIVE_BANK_SENTINEL = 0x7f;

/** A parsed preset dump. Payload buffers are copies of the source bytes. */
export interface Am4PresetDump {
  /** The original 12,352 bytes this dump was parsed from. */
  readonly raw: Uint8Array;
  /** 5 bytes between 0x77 and its checksum. Bytes 0..1 = bank / preset-in-bank. */
  readonly headerPayload: Uint8Array;
  /** 4 × 3074-byte chunk payloads. Inner structure is opaque (masked per-export). */
  readonly chunkPayloads: readonly Uint8Array[];
  /** 3 bytes between 0x79 and its checksum. Believed to be a content hash. */
  readonly footerPayload: Uint8Array;
}

/** Where a dump addresses itself, from the 0x77 header payload. */
export interface Am4DumpLocation {
  /** Raw bank byte (0x00..0x19 = A..Z, or 0x7F for the active buffer). */
  readonly bank: number;
  /** Raw preset-in-bank byte (0..3). */
  readonly sub: number;
  /** true = active-buffer export (bank is the 0x7F sentinel, no stored location). */
  readonly active: boolean;
  /** Wire location index 0..103 — absent for an active-buffer export. */
  readonly index?: number;
  /** Location code "A01".."Z04" — absent for an active-buffer export. */
  readonly code?: string;
}

function hex(b: number): string {
  return '0x' + b.toString(16).padStart(2, '0');
}

function checkEnvelope(
  bytes: Uint8Array,
  offset: number,
  length: number,
  expectedFunc: number,
  what: string,
): void {
  if (bytes[offset] !== SYSEX_START) {
    throw new Error(`${what}: expected F0 at offset ${offset}, got ${hex(bytes[offset]!)}`);
  }
  for (let i = 0; i < FRACTAL_MFR.length; i++) {
    if (bytes[offset + 1 + i] !== FRACTAL_MFR[i]) {
      throw new Error(
        `${what}: expected Fractal manufacturer ID 00 01 74 at offset ${offset + 1}, ` +
          `got ${hex(bytes[offset + 1]!)} ${hex(bytes[offset + 2]!)} ${hex(bytes[offset + 3]!)}`,
      );
    }
  }
  if (bytes[offset + 4] !== AM4_MODEL_ID) {
    throw new Error(
      `${what}: expected AM4 model ID 0x15 at offset ${offset + 4}, got ${hex(bytes[offset + 4]!)}`,
    );
  }
  if (bytes[offset + 5] !== expectedFunc) {
    throw new Error(
      `${what}: expected function ${hex(expectedFunc)} at offset ${offset + 5}, ` +
        `got ${hex(bytes[offset + 5]!)}`,
    );
  }
  if (bytes[offset + length - 1] !== SYSEX_END) {
    throw new Error(
      `${what}: expected F7 at offset ${offset + length - 1}, got ${hex(bytes[offset + length - 1]!)}`,
    );
  }

  // Checksum: XOR of every byte from F0 through the last payload byte, & 0x7F.
  // The cs byte sits at offset + length - 2, F7 at offset + length - 1.
  let acc = 0;
  const csInputEnd = offset + length - 2;
  for (let i = offset; i < csInputEnd; i++) acc ^= bytes[i]!;
  const expected = acc & 0x7f;
  const got = bytes[offset + length - 2];
  if (got !== expected) {
    throw new Error(
      `${what}: checksum mismatch at offset ${offset + length - 2}: ` +
        `expected ${hex(expected)}, got ${hex(got!)}`,
    );
  }
}

/**
 * Parse one preset dump (12,352 bytes) from a buffer.
 *
 * Validates every message envelope (F0, manufacturer ID, model byte 0x15,
 * function byte, F7) and checksum. Throws on any malformed byte.
 */
export function parseAm4PresetDump(bytes: Uint8Array, offset = 0): Am4PresetDump {
  if (offset + AM4_PRESET_FRAME_SIZE > bytes.length) {
    throw new Error(
      `parseAm4PresetDump: insufficient bytes — need ${AM4_PRESET_FRAME_SIZE} starting at ` +
        `offset ${offset}, got ${bytes.length - offset} remaining`,
    );
  }

  const headerStart = offset;
  checkEnvelope(
    bytes,
    headerStart,
    AM4_PRESET_DUMP_HEADER_LEN,
    AM4_FUNC_PRESET_HEADER,
    'PRESET_DUMP_HEADER (0x77)',
  );
  const headerPayload = bytes.slice(headerStart + 6, headerStart + AM4_PRESET_DUMP_HEADER_LEN - 2);

  const chunkPayloads: Uint8Array[] = [];
  let cursor = headerStart + AM4_PRESET_DUMP_HEADER_LEN;
  for (let i = 0; i < AM4_PRESET_DUMP_CHUNKS; i++) {
    checkEnvelope(
      bytes,
      cursor,
      AM4_PRESET_DUMP_CHUNK_LEN,
      AM4_FUNC_PRESET_CHUNK,
      `PRESET_DUMP_CHUNK ${i + 1}/${AM4_PRESET_DUMP_CHUNKS} (0x78)`,
    );
    chunkPayloads.push(bytes.slice(cursor + 6, cursor + AM4_PRESET_DUMP_CHUNK_LEN - 2));
    cursor += AM4_PRESET_DUMP_CHUNK_LEN;
  }

  checkEnvelope(
    bytes,
    cursor,
    AM4_PRESET_DUMP_FOOTER_LEN,
    AM4_FUNC_PRESET_FOOTER,
    'PRESET_DUMP_FOOTER (0x79)',
  );
  const footerPayload = bytes.slice(cursor + 6, cursor + AM4_PRESET_DUMP_FOOTER_LEN - 2);

  return {
    raw: bytes.slice(offset, offset + AM4_PRESET_FRAME_SIZE),
    headerPayload,
    chunkPayloads,
    footerPayload,
  };
}

/**
 * Parse a buffer holding N back-to-back preset dumps (the factory bank file
 * is 104 of them, no separator). Throws unless the length is a non-zero
 * multiple of one frame; every frame is fully validated.
 */
export function parseAm4PresetBank(bytes: Uint8Array): Am4PresetDump[] {
  if (bytes.length === 0 || bytes.length % AM4_PRESET_FRAME_SIZE !== 0) {
    throw new Error(
      `parseAm4PresetBank: expected length to be a non-zero multiple of ` +
        `${AM4_PRESET_FRAME_SIZE} (one preset frame), got ${bytes.length}`,
    );
  }
  const count = bytes.length / AM4_PRESET_FRAME_SIZE;
  const out: Am4PresetDump[] = [];
  for (let i = 0; i < count; i++) {
    out.push(parseAm4PresetDump(bytes, i * AM4_PRESET_FRAME_SIZE));
  }
  return out;
}

/**
 * The stored location a dump addresses, from its 0x77 header payload.
 * An active-buffer export (bank 0x7F) has no stored location — `active`
 * is true and `index`/`code` are absent.
 */
export function am4DumpLocation(dump: Am4PresetDump): Am4DumpLocation {
  const bank = dump.headerPayload[0]!;
  const sub = dump.headerPayload[1]!;
  if (bank === AM4_DUMP_ACTIVE_BANK_SENTINEL) {
    return { bank, sub, active: true };
  }
  const index = bank * 4 + sub;
  return { bank, sub, active: false, index, code: formatLocationCode(index) };
}

function buildMessage(func: number, payload: Uint8Array, totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  out[0] = SYSEX_START;
  out[1] = FRACTAL_MFR[0];
  out[2] = FRACTAL_MFR[1];
  out[3] = FRACTAL_MFR[2];
  out[4] = AM4_MODEL_ID;
  out[5] = func;
  out.set(payload, 6);
  const csIndex = 6 + payload.length;
  let acc = 0;
  for (let i = 0; i < csIndex; i++) acc ^= out[i]!;
  out[csIndex] = acc & 0x7f;
  out[csIndex + 1] = SYSEX_END;
  return out;
}

/**
 * Serialize a parsed dump back to its 12,352-byte wire form. For any input
 * that came from `parseAm4PresetDump`, the output is byte-identical to the
 * input — the backup-and-replay round-trip property.
 */
export function serializeAm4PresetDump(parsed: Am4PresetDump): Uint8Array {
  if (parsed.headerPayload.length !== AM4_PRESET_DUMP_HEADER_PAYLOAD_LEN) {
    throw new Error(
      `serializeAm4PresetDump: header payload must be ${AM4_PRESET_DUMP_HEADER_PAYLOAD_LEN} bytes, ` +
        `got ${parsed.headerPayload.length}`,
    );
  }
  if (parsed.chunkPayloads.length !== AM4_PRESET_DUMP_CHUNKS) {
    throw new Error(
      `serializeAm4PresetDump: expected ${AM4_PRESET_DUMP_CHUNKS} chunk payloads, ` +
        `got ${parsed.chunkPayloads.length}`,
    );
  }
  for (let i = 0; i < parsed.chunkPayloads.length; i++) {
    if (parsed.chunkPayloads[i]!.length !== AM4_PRESET_DUMP_CHUNK_PAYLOAD_LEN) {
      throw new Error(
        `serializeAm4PresetDump: chunk ${i + 1} payload must be ` +
          `${AM4_PRESET_DUMP_CHUNK_PAYLOAD_LEN} bytes, got ${parsed.chunkPayloads[i]!.length}`,
      );
    }
  }
  if (parsed.footerPayload.length !== AM4_PRESET_DUMP_FOOTER_PAYLOAD_LEN) {
    throw new Error(
      `serializeAm4PresetDump: footer payload must be ${AM4_PRESET_DUMP_FOOTER_PAYLOAD_LEN} bytes, ` +
        `got ${parsed.footerPayload.length}`,
    );
  }

  const out = new Uint8Array(AM4_PRESET_FRAME_SIZE);
  let cursor = 0;
  out.set(
    buildMessage(AM4_FUNC_PRESET_HEADER, parsed.headerPayload, AM4_PRESET_DUMP_HEADER_LEN),
    cursor,
  );
  cursor += AM4_PRESET_DUMP_HEADER_LEN;
  for (const chunk of parsed.chunkPayloads) {
    out.set(buildMessage(AM4_FUNC_PRESET_CHUNK, chunk, AM4_PRESET_DUMP_CHUNK_LEN), cursor);
    cursor += AM4_PRESET_DUMP_CHUNK_LEN;
  }
  out.set(
    buildMessage(AM4_FUNC_PRESET_FOOTER, parsed.footerPayload, AM4_PRESET_DUMP_FOOTER_LEN),
    cursor,
  );
  return out;
}
