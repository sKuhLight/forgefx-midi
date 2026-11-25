/**
 * AM4 special-table reads: the two cache tables a parameter walk cannot see, read live.
 *
 *   - `0xFFFF` — preset names: `func 0x01 / action 0x12`, `pidLow 0x00CE`, `pidHigh 0x000B`,
 *     payload = `u32` preset location, reply = a 32-byte name field. This is the read the shipped
 *     codec already implemented (`buildGetPresetName` / `parseGetPresetNameResponse`, hardware
 *     verified); the 104-slot table of the AM4 cache is exactly this read, slot by slot.
 *   - `0xFFF0` — the User cab/IR bank: `func 0x01 / action 0x12`, `pidLow 0x003E`,
 *     `pidHigh 0x000C`, payload = `u32` slot. Reply = a 32-byte name field plus one attribute byte
 *     at payload `+32` (`0` standard / `1` ultra-res / `2` full-res, anything else `255`). The same
 *     op serves the two scratchpads at indices `0x100` / `0x101`; they are NOT part of the cache's
 *     `0xFFF0` table.
 *
 * The `0xFFF0` table is the USER bank only — AM4 factory cabinets are a device parameter enum, not
 * a name table. The two scratchpads never reach the table. Both reads are one request per slot,
 * synchronous, ascending: 256 round trips for the user bank. Both are read-only (`action 0x12`);
 * no frame in this module can write.
 *
 * OPEN, and deliberately not papered over: the cab-name reply's `hdr4` is either 32 or 33 raw
 * bytes (the parser reads `payload[32]`, so ≥ 33 is implied but never captured). A 32-byte reply
 * yields an entry WITHOUT an attribute; `am4CabBankTable` refuses such a bank (the cache table
 * needs one attribute word per name) rather than inventing `255`.
 *
 * PRIVACY. Both tables hold the unit owner's names. Keep the result local; a cache file that
 * leaves the machine must be redacted (`redactCacheUserNames`), and a profile document must use
 * `mergeSpecialTables` (which drops them) — never `mergeSpecialTablesLocal`.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import type { CabBankTable } from '../cache/specialTables.js';
import { buildGetPresetName, parseGetPresetNameResponse } from './setParam.js';
import { TOTAL_LOCATIONS } from './locations.js';
import {
  AM4_READ_ACTION_NAME,
  AM4_READ_MODEL_AM4,
  buildAm4ReadFrame,
  requestAm4Read,
} from './readFrame.js';
import type { Am4ReadOptions, Am4ReadStats, Am4ReadTransport } from './readFrame.js';

/** `pidLow` of the cab block's name register. */
export const AM4_CAB_NAME_PID_LOW = 0x003e;
/** `pidHigh` of the cab/IR name register. */
export const AM4_CAB_NAME_PID_HIGH = 0x000c;
/** Slots of the User cab/IR bank (indices `0x00..0xFF`). */
export const AM4_CAB_USER_SLOTS = 256;
/** Indices of the two scratchpad slots in the same name space (never part of `0xFFF0`). */
export const AM4_CAB_SCRATCHPAD_INDICES: readonly number[] = Object.freeze([0x100, 0x101]);

/** Name field of a cab/preset name reply. */
const CAB_NAME_BYTES = 32;
/** Payload offset of the cab/IR slot attribute byte. */
const CAB_ATTRIBUTE_OFFSET = 32;

/** Highest slot index the cab-name register addresses (`0x101` = scratchpad 2). */
const AM4_CAB_NAME_MAX_SLOT = 0x101;

/**
 * Build the cab/IR name READ: `func 0x01 / action 0x12`, `pidLow 0x003E`, `pidHigh 0x000C`,
 * payload = the `u32` slot index (`0..255` User, `0x100`/`0x101` scratchpads).
 */
export function buildReadAm4CabName(slot: number, model = AM4_READ_MODEL_AM4): number[] {
  if (!Number.isInteger(slot) || slot < 0 || slot > AM4_CAB_NAME_MAX_SLOT) {
    throw new Error(`AM4 cab name: slot ${slot} is outside the register's 0..0x101 index space`);
  }
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, slot, true);
  return buildAm4ReadFrame(model, AM4_CAB_NAME_PID_LOW, AM4_CAB_NAME_PID_HIGH, AM4_READ_ACTION_NAME, payload);
}

/** One decoded cab/IR name reply. */
export interface Am4CabNameReply {
  /** The 32-byte name field, NUL-terminated, high bytes as spaces. `<EMPTY>` for an empty slot. */
  name: string;
  /**
   * The slot's attribute byte (`0` standard / `1` ultra-res / `2` full-res / `255` anything else),
   * or `undefined` when the reply carried no byte at payload `+32` (the open 32-vs-33-byte form).
   */
  attribute?: number;
}

/** A NUL-terminated text field with every non-printable byte read as a space. */
function textField(payload: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) {
    const c = payload[offset + i]!;
    if (c === 0x00) break;
    text += String.fromCharCode(c >= 0x20 && c < 0x7f ? c : 0x20);
  }
  return text;
}

/**
 * Parse a cab/IR name payload. Requires at least the 32-byte name field; the attribute byte is
 * read only when the payload is long enough (`>= 33`). Returns `null` for a payload shorter than
 * 32 bytes.
 */
export function parseAm4CabNameReply(payload: Uint8Array): Am4CabNameReply | null {
  if (payload.length < CAB_NAME_BYTES) return null;
  const name = textField(payload, 0, CAB_NAME_BYTES);
  if (payload.length <= CAB_ATTRIBUTE_OFFSET) return { name };
  const raw = payload[CAB_ATTRIBUTE_OFFSET]!;
  const attribute = raw === 0 || raw === 1 || raw === 2 ? raw : 255;
  return { name, attribute };
}

/** One cab/IR name read result. */
export interface Am4CabNameEntry extends Am4CabNameReply {
  /** The slot index that was requested. */
  slot: number;
}

/** Outcome of `readAm4CabNames`. */
export interface Am4CabNameRead extends Am4ReadStats {
  /** Entries in request order (only slots that answered a valid name reply). */
  entries: Am4CabNameEntry[];
}

/**
 * Read cab/IR names one slot at a time. Default slots are the 256 User-bank slots; pass
 * `AM4_CAB_SCRATCHPAD_INDICES` for the two scratchpads. Read-only.
 */
export async function readAm4CabNames(
  transport: Am4ReadTransport,
  slots: readonly number[] = Array.from({ length: AM4_CAB_USER_SLOTS }, (_, i) => i),
  opts: Am4ReadOptions = {},
  model = AM4_READ_MODEL_AM4,
): Promise<Am4CabNameRead> {
  const stats: Am4ReadStats = { queries: 0, lostReplies: 0, malformedReplies: 0 };
  const entries: Am4CabNameEntry[] = [];
  for (const slot of slots) {
    const payload = await requestAm4Read(
      transport,
      buildReadAm4CabName(slot, model),
      { model, pidLow: AM4_CAB_NAME_PID_LOW, pidHigh: AM4_CAB_NAME_PID_HIGH, action: AM4_READ_ACTION_NAME },
      opts,
      stats,
    );
    if (!payload) continue;
    const reply = parseAm4CabNameReply(payload);
    if (!reply) {
      stats.malformedReplies += 1;
      continue;
    }
    entries.push({ slot, ...reply });
  }
  return { entries, ...stats };
}

/**
 * Build the cache's `0xFFF0` User-bank table from name reads. Returns `null` when any entry lacks
 * its attribute byte (a 32-byte reply): the cache table needs exactly one attribute word per name,
 * and the missing byte is never invented. Entries are expected in slot order.
 */
export function am4CabBankTable(entries: readonly Am4CabNameEntry[], section: number, id = 0xfff0): CabBankTable | null {
  if (entries.length === 0) return null;
  const names: string[] = [];
  const wireIds: number[] = [];
  for (const entry of entries) {
    if (entry.attribute === undefined) return null;
    names.push(entry.name);
    wireIds.push(entry.attribute);
  }
  return { section, id, names, wireIds };
}

/** One preset-name read result. */
export interface Am4PresetNameEntry {
  /** Preset location `0..103`. */
  location: number;
  /** The decoded name with trailing padding stripped; `<EMPTY>` for an empty location. */
  name: string;
}

/** Outcome of `readAm4PresetNames`. */
export interface Am4PresetNameRead extends Am4ReadStats {
  /** Entries in request order (only locations that answered a valid name reply). */
  entries: Am4PresetNameEntry[];
}

/**
 * Read the AM4 preset-name table, one location at a time (`action 0x12`, `pidLow 0x00CE`,
 * `pidHigh 0x000B`). Default locations are all `0..103`. This is the hardware-verified AM4 read;
 * a VP4 preset-name read has not been confirmed and is not built here.
 *
 * The existing AM4 name parser strips trailing space padding, which is how the cache stores the
 * name it read; the device's `<EMPTY>` sentinel is kept.
 */
export async function readAm4PresetNames(
  transport: Am4ReadTransport,
  locations: readonly number[] = Array.from({ length: TOTAL_LOCATIONS }, (_, i) => i),
  opts: Am4ReadOptions = {},
): Promise<Am4PresetNameRead> {
  const stats: Am4ReadStats = { queries: 0, lostReplies: 0, malformedReplies: 0 };
  const entries: Am4PresetNameEntry[] = [];
  for (const location of locations) {
    const attempts = Math.max(0, opts.retries ?? 1) + 1;
    let parsed: Am4PresetNameEntry | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (opts.signal?.aborted) throw new Error('AM4/VP4 read aborted');
      if (attempt > 0 && (opts.interQueryMs ?? 0) > 0) {
        if (opts.sleep) await opts.sleep(opts.interQueryMs!);
        else await new Promise<void>((resolve) => setTimeout(resolve, opts.interQueryMs!));
      }
      const frame = await transport.request(Uint8Array.from(buildGetPresetName(location)));
      stats.queries += 1;
      if (!frame) {
        stats.lostReplies += 1;
        continue;
      }
      try {
        const reply = parseGetPresetNameResponse(frame, location);
        parsed = { location, name: reply.name };
      } catch {
        stats.malformedReplies += 1;
      }
      break;
    }
    if (parsed) entries.push(parsed);
  }
  return { entries, ...stats };
}
