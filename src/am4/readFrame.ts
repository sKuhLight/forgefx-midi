/**
 * The AM4 / VP4 func 0x01 READ envelope — and nothing else.
 *
 * `buildAm4ReadFrame` is the only frame builder in this module and it REFUSES every action outside
 * `AM4_READ_ACTIONS` (`0x0D` long read, `0x12` read-name). A write frame therefore cannot be built
 * through this path: there is no shared builder that a caller could aim at `action 0x01 / 0x02`
 * (SET / SET_NORM), `0x0C` (rename), `0x1A`, `0x1B` (save), `0x03..0x06` (nudge) or `0x7A..0x7C`
 * (transfer). The AM4/VP4 definition walk and the cab-name read are built on it; the preset-name
 * read reuses the pre-existing hardware-verified name builder in ./setParam.ts (itself a read).
 *
 * Wire shape (both models; only the model byte differs — AM4 `0x15`, VP4 `0x14`):
 *
 *   `F0 00 01 74 <model> 01 | pidLow(14) | pidHigh(14) | action(14) | hdr3(14) | hdr4(14) |
 *    <chunked 8→7 packed payload> | cksum F7`
 *
 * Every 14-bit header field is a little-endian septet pair; `hdr4` is the RAW payload byte count,
 * and payloads longer than seven bytes use the chunked 8→7 packer the whole AM4 codec uses. The
 * reply echoes the five header fields and carries the same packed payload.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import { fractalChecksum } from '../shared/checksum.js';
import { encode14 } from '../shared/septet16.js';
import { packValueChunked, unpackValueChunked } from '../shared/packValue.js';

/** AM4 model byte. */
export const AM4_READ_MODEL_AM4 = 0x15;
/** VP4 model byte. */
export const VP4_READ_MODEL_VP4 = 0x14;
/** Long parameter read (`action 0x0D`) — the definition / descriptor / label pseudo-registers. */
export const AM4_READ_ACTION_LONG = 0x0d;
/** Name read (`action 0x12`) — preset and cab/IR name strings. */
export const AM4_READ_ACTION_NAME = 0x12;
/** Every action this module can build: long read and name read. */
export const AM4_READ_ACTIONS: readonly number[] = Object.freeze([AM4_READ_ACTION_LONG, AM4_READ_ACTION_NAME]);

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const FUNC_PARAM_RW = 0x01;

/** True for the two model bytes the AM4/VP4 read path serves. */
export function isAm4ReadModel(model: number): boolean {
  return model === AM4_READ_MODEL_AM4 || model === VP4_READ_MODEL_VP4;
}

/** Wire length of a chunked 8→7 packed payload of `rawLen` bytes. */
function chunkedWireLength(rawLen: number): number {
  const full = Math.floor(rawLen / 7);
  const rem = rawLen % 7;
  return full * 8 + (rem > 0 ? rem + 1 : 0);
}

/**
 * Build one AM4/VP4 func 0x01 READ frame. Throws for any action outside `AM4_READ_ACTIONS`, so the
 * builder is structurally a read-only path.
 *
 * @param model   AM4 `0x15` or VP4 `0x14`.
 * @param pidLow  the block / register id (14-bit).
 * @param pidHigh the parameter id or pseudo-register id (14-bit).
 * @param action  `AM4_READ_ACTION_LONG` (`0x0D`) or `AM4_READ_ACTION_NAME` (`0x12`).
 * @param payload raw payload bytes (0..16383); packed with the AM4 chunked 8→7 packer.
 */
export function buildAm4ReadFrame(
  model: number,
  pidLow: number,
  pidHigh: number,
  action: number,
  payload: Uint8Array = new Uint8Array(0),
): number[] {
  if (!isAm4ReadModel(model)) throw new Error(`AM4/VP4 read: model 0x${model.toString(16)} is not AM4 (0x15) or VP4 (0x14)`);
  if (!AM4_READ_ACTIONS.includes(action)) throw new Error(`AM4/VP4 read: action 0x${action.toString(16)} is not a read action`);
  if (!Number.isInteger(pidLow) || pidLow < 0 || pidLow > 0x3fff) throw new Error(`AM4/VP4 read: pidLow ${pidLow} is not a 14-bit field`);
  if (!Number.isInteger(pidHigh) || pidHigh < 0 || pidHigh > 0x3fff) throw new Error(`AM4/VP4 read: pidHigh ${pidHigh} is not a 14-bit field`);
  if (payload.length > 0x3fff) throw new Error(`AM4/VP4 read: payload length ${payload.length} exceeds the 14-bit hdr4 field`);
  const body: number[] = [
    model,
    FUNC_PARAM_RW,
    ...encode14(pidLow),
    ...encode14(pidHigh),
    ...encode14(action),
    ...encode14(0x0000), // hdr3 reserved
    ...encode14(payload.length), // hdr4 = raw payload byte count
    ...Array.from(packValueChunked(payload)),
  ];
  const head = [SYSEX_START, ...FRACTAL_MFR, ...body];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/** A decoded AM4/VP4 func 0x01 READ reply. */
export interface Am4ReadFrame {
  model: number;
  pidLow: number;
  pidHigh: number;
  action: number;
  /** Raw payload bytes (hdr4 long). */
  payload: Uint8Array;
}

/**
 * Decode an AM4/VP4 func 0x01 READ reply, or return `null` when the frame is not one. Validates
 * the envelope, manufacturer id, model (AM4/VP4 only), function byte, the read action, `hdr3` 0,
 * the exact wire length for `hdr4` and the checksum. Never throws — safe to feed interleaved or
 * truncated input.
 */
export function parseAm4ReadFrame(bytes: number[] | Uint8Array): Am4ReadFrame | null {
  const b = Array.isArray(bytes) ? bytes : Array.from(bytes);
  if (b.length < 18) return null;
  if (b[0] !== SYSEX_START || b[b.length - 1] !== SYSEX_END) return null;
  for (let i = 0; i < FRACTAL_MFR.length; i++) if (b[1 + i] !== FRACTAL_MFR[i]) return null;
  const model = b[4]!;
  if (!isAm4ReadModel(model)) return null;
  if (b[5] !== FUNC_PARAM_RW) return null;
  const pidLow = b[6]! | (b[7]! << 7);
  const pidHigh = b[8]! | (b[9]! << 7);
  const action = b[10]! | (b[11]! << 7);
  if (!AM4_READ_ACTIONS.includes(action)) return null;
  if (b[12] !== 0 || b[13] !== 0) return null; // hdr3 reserved
  const rawLen = b[14]! | (b[15]! << 7);
  if (b.length !== 16 + chunkedWireLength(rawLen) + 2) return null;
  const csIdx = b.length - 2;
  if (b[csIdx] !== fractalChecksum(b.slice(0, csIdx))) return null;
  const wire = new Uint8Array(b.slice(16, csIdx));
  const payload = unpackValueChunked(wire, rawLen);
  if (payload.length !== rawLen) return null;
  return { model, pidLow, pidHigh, action, payload };
}

/** Minimal transport the read helpers drive (a `LiveTransport` is structurally assignable). */
export interface Am4ReadTransport {
  request(query: Uint8Array): Promise<Uint8Array | null>;
  drain?(): Promise<void> | void;
}

/** Pacing / abort options shared by the AM4 read helpers. */
export interface Am4ReadOptions {
  /** Extra attempts for a read that got no reply at all (default 1; 0 = one attempt). */
  retries?: number;
  /** Pause before every retry, ms (default 0). A host that needs pacing between queries paces its transport. */
  interQueryMs?: number;
  /** Abort between queries (rejects with `Error('AM4/VP4 read aborted')`). */
  signal?: AbortSignal;
  /** Scheduler seam for `interQueryMs` (default the ambient `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

/** Query / loss accounting of the AM4 read helpers. */
export interface Am4ReadStats {
  /** Frames sent (retries included). */
  queries: number;
  /** Attempts that got no reply. */
  lostReplies: number;
  /** Replies that arrived but did not decode as the expected read (wrong fields included). */
  malformedReplies: number;
}

/** Extra attempts for a read that got no reply at all (default 1). */
const DEFAULT_READ_RETRIES = 1;

async function pause(ms: number, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (ms <= 0) return;
  if (sleep) await sleep(ms);
  else await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Send one read frame and return its decoded payload when it answers the expected register, or
 * `null`. A reply that decodes but belongs to another register/action is a straggler: it counts in
 * `malformedReplies` and is not retried (the transport matches by request). Only a no-reply is
 * retried.
 */
export async function requestAm4Read(
  transport: Am4ReadTransport,
  query: number[],
  expected: { model: number; pidLow: number; pidHigh: number; action: number },
  opts: Am4ReadOptions,
  stats: Am4ReadStats,
): Promise<Uint8Array | null> {
  const attempts = Math.max(0, opts.retries ?? DEFAULT_READ_RETRIES) + 1;
  const bytes = Uint8Array.from(query);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('AM4/VP4 read aborted');
    if (attempt > 0) await pause(opts.interQueryMs ?? 0, opts.sleep);
    const frame = await transport.request(bytes);
    stats.queries += 1;
    if (!frame) {
      stats.lostReplies += 1;
      continue;
    }
    const reply = parseAm4ReadFrame(frame);
    if (
      !reply ||
      reply.model !== expected.model ||
      reply.pidLow !== expected.pidLow ||
      reply.pidHigh !== expected.pidHigh ||
      reply.action !== expected.action
    ) {
      stats.malformedReplies += 1;
      return null;
    }
    return reply.payload;
  }
  return null;
}
