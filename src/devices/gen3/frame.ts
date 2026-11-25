/**
 * Fractal SysEx frame envelope for the gen-3 file/transfer groups.
 *
 *   F0 00 01 74 <model> <func> <payload …> <XOR7> F7
 *
 * The XOR checksum covers every byte from `F0` through the last payload byte
 * and is stored as a 7-bit value. Payload bytes must all be 7-bit; a high byte
 * inside a frame is rejected rather than silently re-framed.
 *
 * Pure code, browser-safe.
 */

export const SYSEX_START = 0xf0;
export const SYSEX_END = 0xf7;
export const FRACTAL_MANUFACTURER_ID = [0x00, 0x01, 0x74] as const;

/** Frame bytes before the payload: F0, 3-byte mfr, model, func. */
const FRAME_HEAD = 6;
/** Bytes after the payload: checksum, F7. */
const FRAME_TAIL = 2;

export interface FractalFrame {
  readonly modelId: number;
  readonly func: number;
  readonly payload: Uint8Array;
  /** Total frame length including `F0` and `F7`. */
  readonly length: number;
}

function hex(n: number): string {
  return '0x' + (n & 0xff).toString(16).padStart(2, '0');
}

function assertModelId(modelId: number, what: string): void {
  if (!Number.isInteger(modelId) || modelId < 0 || modelId > 0x7f) {
    throw new Error(`${what}: model id ${modelId} is not a 7-bit value`);
  }
}

function assertFunc(func: number, what: string): void {
  if (!Number.isInteger(func) || func < 0 || func > 0x7f) {
    throw new Error(`${what}: function ${func} is not a 7-bit value`);
  }
}

/** Build one complete, checksummed frame. */
export function buildFractalFrame(modelId: number, func: number, payload: Uint8Array): Uint8Array {
  assertModelId(modelId, 'buildFractalFrame');
  assertFunc(func, 'buildFractalFrame');
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] > 0x7f) {
      throw new Error(`buildFractalFrame: payload byte ${i} (${hex(payload[i])}) is not 7-bit`);
    }
  }
  const out = new Uint8Array(FRAME_HEAD + payload.length + FRAME_TAIL);
  out[0] = SYSEX_START;
  out[1] = FRACTAL_MANUFACTURER_ID[0];
  out[2] = FRACTAL_MANUFACTURER_ID[1];
  out[3] = FRACTAL_MANUFACTURER_ID[2];
  out[4] = modelId;
  out[5] = func;
  out.set(payload, FRAME_HEAD);
  const csIndex = FRAME_HEAD + payload.length;
  let acc = 0;
  for (let i = 0; i < csIndex; i++) acc ^= out[i];
  out[csIndex] = acc & 0x7f;
  out[csIndex + 1] = SYSEX_END;
  return out;
}

/**
 * Read and validate one frame at `offset`. `expectedModelId` is optional; when
 * omitted the model byte is taken from the frame. The returned payload is a
 * copy.
 */
export function readFractalFrame(
  bytes: Uint8Array,
  offset: number,
  what: string,
  expectedModelId?: number,
): FractalFrame {
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`${what}: invalid offset ${offset}`);
  if (offset + FRAME_HEAD + FRAME_TAIL > bytes.length) {
    throw new Error(`${what}: insufficient bytes for a frame at ${offset}`);
  }
  if (bytes[offset] !== SYSEX_START) {
    throw new Error(`${what}: expected F0 at offset ${offset}, got ${hex(bytes[offset])}`);
  }
  for (let i = 0; i < FRACTAL_MANUFACTURER_ID.length; i++) {
    const actual = bytes[offset + 1 + i];
    if (actual !== FRACTAL_MANUFACTURER_ID[i]) {
      throw new Error(
        `${what}: expected manufacturer id 00 01 74 at ${offset + 1}, ` +
          `got ${hex(bytes[offset + 1])} ${hex(bytes[offset + 2])} ${hex(bytes[offset + 3])}`,
      );
    }
  }
  const modelId = bytes[offset + 4];
  assertModelId(modelId, what);
  if (expectedModelId !== undefined && modelId !== expectedModelId) {
    throw new Error(`${what}: model id ${hex(modelId)} does not match expected ${hex(expectedModelId)}`);
  }
  const func = bytes[offset + 5];
  assertFunc(func, what);

  let end = offset + FRAME_HEAD;
  while (end < bytes.length && bytes[end] !== SYSEX_END) {
    if (bytes[end] > 0x7f) {
      throw new Error(`${what}: payload byte ${hex(bytes[end])} at ${end} is not 7-bit`);
    }
    end += 1;
  }
  if (end >= bytes.length) throw new Error(`${what}: no F7 terminator after offset ${offset}`);
  if (end === offset + FRAME_HEAD) throw new Error(`${what}: frame has no checksum byte`);
  const csIndex = end - 1;
  let acc = 0;
  for (let i = offset; i < csIndex; i++) acc ^= bytes[i];
  const expected = acc & 0x7f;
  if (bytes[csIndex] !== expected) {
    throw new Error(`${what}: checksum mismatch at ${csIndex} (expected ${hex(expected)}, got ${hex(bytes[csIndex])})`);
  }
  const length = end - offset + 1;
  return {
    modelId,
    func,
    payload: bytes.slice(offset + FRAME_HEAD, csIndex),
    length,
  };
}

/**
 * Split a buffer of back-to-back frames. Every byte must belong to a frame;
 * all frames must share one model byte. `expectedModelId` additionally pins
 * that model.
 */
export function splitFractalFrames(
  bytes: Uint8Array,
  what: string,
  expectedModelId?: number,
): FractalFrame[] {
  const frames: FractalFrame[] = [];
  let offset = 0;
  let modelId: number | undefined;
  while (offset < bytes.length) {
    if (bytes[offset] !== SYSEX_START) {
      throw new Error(`${what}: expected F0 at offset ${offset}, got ${hex(bytes[offset])}`);
    }
    const frame = readFractalFrame(bytes, offset, what, expectedModelId);
    if (modelId === undefined) modelId = frame.modelId;
    else if (frame.modelId !== modelId) {
      throw new Error(`${what}: frame at ${offset} has model ${hex(frame.modelId)}, expected ${hex(modelId)}`);
    }
    frames.push(frame);
    offset += frame.length;
  }
  return frames;
}
