/**
 * AM4 DeviceDescriptor — `DeviceReader` implementation.
 *
 * 4 read operations:
 *   - `getParam` — single-value read via `sendReadAndParse` with optional
 *     pre-read channel switch (so callers can target A/B/C/D without a
 *     separate switch call).
 *   - `getParams` — batch wrapper around `getParam`; collects errors per
 *     entry instead of throwing.
 *   - `scanLocations` — readPresetName loop across a contiguous range,
 *     returning name + is_empty per slot.
 *   - `lookupLineage` — Fractal-authored lineage lookup against the
 *     shared corpus (amps / drives / reverbs / delays).
 *
 * All wire-side I/O is delegated to `sendReadAndParse` / `readPresetName`
 * from `@/server/shared/readOps.js`; the runLineageLookup pipeline is
 * file-only.
 */

import type {
  BlockLayoutSnapshot,
  DeviceReader,
  DispatchCtx,
  LocationRef,
  OverwriteTargetInfo,
  PresetBinaryDump,
  PresetSnapshot,
  PresetSnapshotSlot,
  PresetSlotSpec,
  ReadResult,
  SavedSnapshot,
  ScannedLocation,
} from '../../../core/protocol-generic/types.js';
import { DispatchError } from '../../../core/protocol-generic/types.js';
import { receivePresetDumpStream } from '../presetDump.js';

import {
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  BLOCK_TYPE_VALUES,
  resolveBlockTypeValue,
  KNOWN_PARAMS,
  buildBlockLayoutSnapshot,
  buildReadParam,
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  formatLocationCode,
  decode as am4Decode,
  roundDisplayValue,
  isReadResponseLong,
  parseLongReadBypassFlag,
  READ_TYPE_LONG,
  type BlockTypeName,
  type Param,
  type ParamKey,
} from '../../../am4/index.js';
import { formatLocationDisplay } from '../../../am4/index.js';
import { readAllParams, READ_RESPONSE_TIMEOUT_MS, readPresetName, sendReadAndParse, sendReadAndParseRaw } from '../shared/readOps.js';
import {
  CHANNEL_BLOCKS,
  channelLetter,
  switchBlockChannel,
} from '../shared/channels.js';
import {
  LINEAGE_BLOCKS,
  formatLineageRecord,
  loadLineage,
  runLineageLookup,
} from '../../../shared/index.js';
import { formatLoudnessAppendix } from '../../../core/fractal-shared/loudness.js';
import { TYPE_APPLICABILITY } from '../../../am4/index.js';
import { checkApplicability } from '../../../am4/index.js';
import {
  AMP_TYPES,
  COMPRESSOR_TYPES,
  DELAY_TYPES,
  DRIVE_TYPES,
  REVERB_TYPES,
} from '../../../am4/index.js';

import { parseAm4Location } from './schema.js';

// Active-location state register (mirrors safeEdit.ts) — read by
// checkOverwriteTarget to tell a refresh-of-current from a clobber-of-other.
const LOCATION_STATE_PID_LOW = 0x00ce;
const LOCATION_STATE_PID_HIGH = 0x000a;

/**
 * Per-block pidLow list, derived once from KNOWN_PARAMS. Most blocks
 * have a single pidLow (e.g. drive = 0x76); amp spans two (0x3a tone
 * stack + 0x3e cab section). Used by `getPreset` to know which chunks
 * to read for each placed slot.
 */
const PID_LOWS_BY_BLOCK: ReadonlyMap<string, readonly number[]> = (() => {
  const acc = new Map<string, Set<number>>();
  for (const param of Object.values(KNOWN_PARAMS)) {
    const p = param as Param;
    if (!acc.has(p.block)) acc.set(p.block, new Set());
    acc.get(p.block)!.add(p.pidLow);
  }
  const out = new Map<string, readonly number[]>();
  for (const [block, set] of acc) out.set(block, [...set].sort((a, b) => a - b));
  return out;
})();

function pidLowsForBlock(blockType: string): readonly number[] {
  return PID_LOWS_BY_BLOCK.get(blockType) ?? [];
}

const SCENE_STATE_PID_LOW = 0x00ce;
const SCENE_STATE_PID_HIGH = 0x000d;
const BYPASS_STATE_PID_HIGH = 0x0003;

/**
 * Decode a `<block>.channel` selector read into an A/B/C/D letter.
 *
 * reverb / delay / drive read the channel index back as a clean raw u32
 * (0..3), so the direct `enumValues[asUInt32LE]` lookup succeeds. The AMP
 * channel selector at (0x003A, 0x07D2) is different: it reads back derived
 * /cached firmware state, not the index (HW archive: 11244 / 19968 observed
 * with no clean enum fit). The SYSEX-MAP records the SET side as "enum int
 * 0..3 packed as float32", so we try a float32 interpretation as a
 * best-effort fallback. This is NOT a guaranteed-correct decode of the
 * active amp channel; on hardware it must be confirmed against the front
 * panel for non-A channels. `get_preset(include_channel_state:true)` does
 * not rely on it; it reads all four channels from the channel-blocked dump
 * in FIXED A/B/C/D order.
 */
function decodeChannelSelector(
  parsed: { asUInt32LE(): number; rawValue: Uint8Array },
  enumValues: Record<number, string> | undefined,
): { letter?: string; failureReason?: string } {
  const wire = parsed.asUInt32LE();
  const direct = enumValues?.[Math.round(wire)];
  if (typeof direct === 'string') return { letter: direct };
  const floatView = new DataView(parsed.rawValue.buffer, parsed.rawValue.byteOffset, 4);
  const asFloat = floatView.getFloat32(0, true);
  const rounded = Math.round(asFloat);
  if (Number.isFinite(asFloat) && rounded >= 0 && rounded <= 3) {
    const floatName = enumValues?.[rounded];
    if (typeof floatName === 'string') return { letter: floatName };
    return {
      failureReason:
        `channel float read ${asFloat} (rounded ${rounded}) not in enumValues ` +
        `(have ${Object.keys(enumValues ?? {}).join(',')})`,
    };
  }
  return {
    failureReason:
      `channel wire ${wire} (0x${wire.toString(16)}) not in enumValues ` +
      `(have ${Object.keys(enumValues ?? {}).join(',')}); float32 interpretation = ${asFloat}`,
  };
}

/**
 * Read a channel-bearing block's ACTIVE channel as an A/B/C/D letter.
 * Best-effort: returns `{ failureReason }` (never throws) when the selector
 * register can't be resolved (notably amp; see `decodeChannelSelector`).
 */
async function readActiveChannelLetter(
  conn: import('../../../core/midi/transport.js').MidiConnection,
  blockType: string,
  instance = 0, // pidLow shift for instance blocks (slot code = base + instance)
): Promise<{ letter?: string; failureReason?: string }> {
  const channelKey = `${blockType}.channel` as ParamKey;
  const channelParam = KNOWN_PARAMS[channelKey] as Param | undefined;
  if (channelParam === undefined) {
    return { failureReason: `no '${blockType}.channel' param registered in the codec` };
  }
  try {
    const parsed = await sendReadAndParse(conn, channelParam.pidLow + instance, channelParam.pidHigh);
    return decodeChannelSelector(parsed, channelParam.enumValues as Record<number, string> | undefined);
  } catch (err) {
    return { failureReason: err instanceof Error ? err.message : String(err) };
  }
}

async function readBypassState(
  conn: import('../../../core/midi/transport.js').MidiConnection,
  blockType: string,
  instance = 0, // pidLow shift for instance blocks (slot code = base + instance)
): Promise<boolean | undefined> {
  const base = BLOCK_TYPE_VALUES[blockType as BlockTypeName];
  if (base === undefined || base === BLOCK_TYPE_VALUES.none) return undefined;
  const pidLow = base + instance;
  try {
    const readBytes = buildReadParam(
      { pidLow, pidHigh: BYPASS_STATE_PID_HIGH },
      READ_TYPE_LONG,
    );
    const respPromise = conn.receiveSysExMatching(
      (resp) => isReadResponseLong(readBytes, resp),
      READ_RESPONSE_TIMEOUT_MS,
    );
    conn.send(readBytes);
    const resp = await respPromise;
    return parseLongReadBypassFlag(resp);
  } catch {
    return undefined;
  }
}

/**
 * Decode one chunk u16 to its display value. Mirrors the per-paramId
 * `get_param` decode path:
 *   - enum: look up `enumValues[wire]`, fall back to raw int
 *   - non-enum: internal = u16 / 65534 (Q16 → [0..1]), then `am4Decode`
 *     applies the per-unit scale (knob_0_10 / percent / log10-ratio / etc.)
 *
 * Wire-encoding rule cited in `[[am4-fn1f-atomic-read]]` cookbook entry.
 */
function decodeChunkValue(param: Param, wire: number): number | string {
  if (param.unit === 'enum') {
    const enumValues = param.enumValues as Record<number, string> | undefined;
    return enumValues?.[wire] ?? wire;
  }
  const internal = wire / 65534;
  return roundDisplayValue(param, am4Decode(param, internal));
}

/**
 * Decode every registered param of `blockType` for one channel directly
 * from the fn 0x1F chunk dump already in hand.
 *
 * The AM4 `0x75` body is CHANNEL-BLOCKED: it packs four contiguous copies
 * of every paramId slot, one per channel, in FIXED order A/B/C/D (quarter 0
 * = channel A), so `value index = channel * stride + pidHigh` with
 * `stride = itemCount / 4`. Confirmed on live AM4 hardware 2026-06-04
 * (`probe-am4-channel-{blocked,orientation,switch-test}.ts`): channel-bearing
 * blocks all have `itemCount % 4 === 0` with DISTINCT quarters, and a
 * reversible A->B->A switch left the quarters invariant (FIXED, not sliding).
 * See `readOps.ts` and cookbook `am4-fn1f-atomic-read`.
 *
 * Non-channel-blocked chunks (`itemCount % 4 !== 0`, every non-channel
 * register) degrade safely: only channel index 0 reads a value (at `pidHigh`),
 * other channel indices return nothing for that chunk.
 */
function decodeChannelParams(
  blockType: string,
  chunks: ReadonlyMap<number, { itemCount: number; values: readonly number[] }>,
  channelIndex: number,
): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [, param] of Object.entries(KNOWN_PARAMS)) {
    const p = param as Param;
    if (p.block !== blockType) continue;
    const chunk = chunks.get(p.pidLow);
    if (chunk === undefined) continue;
    const { itemCount, values } = chunk;
    let idx: number;
    if (itemCount > 0 && itemCount % 4 === 0) {
      const stride = itemCount / 4;
      idx = channelIndex * stride + p.pidHigh;
    } else {
      // Not channel-blocked: a single copy at pidHigh; only channel A is real.
      if (channelIndex !== 0) continue;
      idx = p.pidHigh;
    }
    if (idx >= values.length) continue;
    out[p.name] = decodeChunkValue(p, values[idx]);
  }
  return out;
}

/**
 * Map a lineage block type → its wire-index enum array. Used by the
 * lineage applicability annotation to look up the wire index from the
 * `am4Name` field on the record.
 *
 * Returns undefined for block types that don't have a type enum (most
 * filter / modulation blocks — those records exist but applicability
 * filtering wouldn't add value).
 */
function typeEnumFor(blockType: string): readonly string[] | undefined {
  switch (blockType) {
    case 'amp':        return AMP_TYPES;
    case 'drive':      return DRIVE_TYPES;
    case 'reverb':     return REVERB_TYPES;
    case 'delay':      return DELAY_TYPES;
    case 'compressor': return COMPRESSOR_TYPES;
    default:           return undefined;
  }
}

/**
 * Tone-building knobs typically displayed on each block's front-panel
 * "main page" — the ones a tone-builder reaches for first. We surface
 * applicability for these in the lookup_lineage annotation to keep the
 * output focused on what the agent needs to decide whether to write a
 * param. The full applicability matrix for every internal param is
 * available via list_params.
 */
const FRONT_PANEL_PARAMS: Record<string, readonly string[]> = {
  amp:        ['type', 'gain', 'bass', 'mid', 'treble', 'presence', 'master', 'level', 'depth'],
  drive:      ['type', 'drive', 'tone', 'level', 'mix'],
  reverb:     ['type', 'mix', 'time', 'predelay', 'size', 'low_cut', 'high_cut'],
  delay:      ['type', 'time', 'tempo', 'feedback', 'mix', 'low_cut', 'high_cut'],
  compressor: ['type', 'amount', 'attack_time', 'release_time', 'level'],
};

/**
 * For a single lineage record, return a human-readable summary of which
 * front-panel knobs apply on this specific block-type wire index. Lets
 * the agent reason about "does this amp have a master?" without a
 * separate list_params call — the answer is right next to the
 * basedOn / lineage data the lookup already returns.
 *
 * Returns `undefined` when applicability annotation isn't meaningful
 * (block type without a type enum, or am4Name not found in the enum).
 */
function formatApplicableKnobs(blockType: string, am4Name: string): string | undefined {
  const enumValues = typeEnumFor(blockType);
  if (enumValues === undefined) return undefined;
  const wireIndex = enumValues.indexOf(am4Name);
  if (wireIndex < 0) return undefined;
  const knobs = FRONT_PANEL_PARAMS[blockType];
  if (knobs === undefined) return undefined;

  const applies: string[] = [];
  const doesNotApply: string[] = [];
  for (const knob of knobs) {
    const key = `${blockType}.${knob}`;
    if (!(key in TYPE_APPLICABILITY)) continue;
    const result = checkApplicability(key, {
      currentTypes: { [blockType]: wireIndex },
    });
    if (result.applicable === true) applies.push(knob);
    else if (result.applicable === false) doesNotApply.push(knob);
    // 'unknown' → omit; we can't make a strong claim either way.
  }
  if (applies.length === 0 && doesNotApply.length === 0) return undefined;

  const lines: string[] = [];
  if (applies.length > 0) {
    lines.push(`frontPanelKnobs: ${applies.join(', ')}`);
  }
  if (doesNotApply.length > 0) {
    lines.push(
      `notExposed: ${doesNotApply.join(', ')}  ` +
      `(real-amp parity — these knobs do NOT exist on this model; the AM4 silently no-ops writes to them; ` +
      `do not include in apply_preset / set_params calls when this type is active)`,
    );
  }
  return lines.join('\n');
}

/**
 * Save receipt. After a save persists, read back the working buffer with
 * TARGETED deterministic reads only — the same primitives get_param /
 * get_block_layout use, never the non-deterministic fn-0x1F bulk dump (whose
 * chunk-to-paramId map is undecoded). Returns the 4-slot block chain plus the
 * amp/drive MODEL NAMES (the bytes that distinguish one preset from another),
 * and the persisted preset name at the just-saved location.
 *
 * Reads (worst case 7, ~350 ms): 4 block-slot reads + amp.type + drive.type
 * + readPresetName(target). Each model read is gated on its block being placed
 * (no wasted read when there's no drive). Every field but block_chain is
 * best-effort: a thrown read omits the field, never throws. The caller
 * (savePreset) treats the whole call as best-effort too — a failure here must
 * not fail a save that already landed.
 *
 * `missing` collects field names whose read failed so the caller can surface
 * an honest "could not confirm X" line instead of silently dropping it.
 */
export async function readSaveSnapshot(
  ctx: DispatchCtx,
  locationIndex: number,
): Promise<{ snapshot: SavedSnapshot; missing: string[] }> {
  const missing: string[] = [];

  // 1. Block chain — 4 deterministic slot-register reads (same wire shape as
  //    getBlockLayoutSnapshot). A failed slot read records 'none' for that
  //    slot rather than aborting the chain.
  const block_chain: string[] = [];
  for (const position of [1, 2, 3, 4] as const) {
    try {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      block_chain.push(resolveBlockTypeValue(u32)?.name ?? 'none');
    } catch {
      block_chain.push('none');
      missing.push(`block_chain[slot ${position}]`);
    }
  }

  // 2/3. Amp + drive MODEL NAME via targeted single-param enum reads (the
  //      get_param path: deterministic fn 0x02 GET, NOT the opaque fn-0x1F
  //      chunk dump). Only read the type when the block is actually placed.
  const readModel = async (
    key: ParamKey,
    blockName: string,
    enumTable: readonly string[],
    fieldLabel: string,
  ): Promise<string | undefined> => {
    if (!block_chain.includes(blockName)) return undefined; // block not placed
    try {
      const param = KNOWN_PARAMS[key] as Param;
      const parsed = await sendReadAndParse(ctx.conn, param.pidLow, param.pidHigh);
      const wire = parsed.asUInt32LE();
      const name = enumTable[wire];
      if (typeof name === 'string') return name;
      missing.push(fieldLabel);
      return undefined;
    } catch {
      missing.push(fieldLabel);
      return undefined;
    }
  };
  const amp_model = await readModel('amp.type' as ParamKey, 'amp', AMP_TYPES, 'amp_model');
  const drive_model = await readModel('drive.type' as ParamKey, 'drive', DRIVE_TYPES, 'drive_model');

  // 4. Persisted preset name at the target (non-destructive, action 0x0012).
  let preset_name: string | undefined;
  try {
    const parsed = await readPresetName(ctx.conn, locationIndex);
    preset_name = parsed.isEmpty ? undefined : (parsed.name?.trim() || undefined);
  } catch {
    missing.push('preset_name');
  }

  return {
    snapshot: {
      block_chain,
      ...(amp_model !== undefined ? { amp_model } : {}),
      ...(drive_model !== undefined ? { drive_model } : {}),
      ...(preset_name !== undefined ? { preset_name } : {}),
    },
    missing,
  };
}

// ── Reader adapter ──────────────────────────────────────────────────
//
// `getParam` wraps the existing `sendReadAndParse` + `decode` pipeline
// from the legacy `am4_get_param` handler. The dispatcher pre-resolves
// the canonical (block, name); this method does the wire round-trip
// and returns the display value. Optional channel switch happens
// before the read so callers can target A/B/C/D explicitly without
// a separate switch tool call.

export const reader: DeviceReader = {
  async getParam(
    ctx: DispatchCtx,
    block: string,
    name: string,
    channel?: string | number,
  ): Promise<ReadResult> {
    const key = `${block}.${name}` as ParamKey;
    const param: Param = KNOWN_PARAMS[key];
    if (channel !== undefined && CHANNEL_BLOCKS.has(block)) {
      await switchBlockChannel(ctx.conn, block, channel);
    }
    const { parsed, raw_response } = await sendReadAndParseRaw(ctx.conn, param.pidLow, param.pidHigh);
    const wire = param.unit === 'enum'
      ? parsed.asUInt32LE()
      : parsed.asInternalFloat();
    let display: number | string;
    if (param.unit === 'enum') {
      const enumValues = param.enumValues as Record<number, string> | undefined;
      const direct = enumValues?.[Math.round(wire)];
      if (direct !== undefined) {
        display = direct;
      } else if (name === 'channel' && CHANNEL_BLOCKS.has(block)) {
        // amp's channel selector reads back derived/cached firmware state
        // (raw u32 like 19968, not 0..3); fall back to the float32-packed-enum
        // interpretation so it resolves to a letter. See decodeChannelSelector.
        display = decodeChannelSelector(parsed, enumValues).letter ?? Math.round(wire);
      } else {
        display = Math.round(wire);
      }
    } else {
      display = roundDisplayValue(param, am4Decode(param, wire));
    }
    return {
      block,
      name,
      wire_value: wire,
      display_value: display,
      unit: param.unit,
      raw_response,
    };
  },

  async getParams(ctx: DispatchCtx, queries) {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        reads.push(await reader.getParam(ctx, q.block, q.name, q.channel));
      } catch (err) {
        failed_indices.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices,
      errors: failed_indices.length > 0 ? errors : undefined,
    };
  },

  async dumpActivePresetBinary(ctx: DispatchCtx): Promise<PresetBinaryDump> {
    // Byte-exact backup of the active working buffer via the fn 0x03
    // request → 6-message PRESET_DUMP stream (0x77 header + 4× 0x78 chunks
    // + 0x79 footer, 12,352 bytes). The concatenated frames are a valid
    // `.syx`. The AM4 encoder is non-deterministic between identical dumps
    // (its inner bytes are not byte-stable), so we can't decode the blob,
    // but a verbatim backup still round-trips to the same location. Restore
    // is a separate (not-yet-shipped) path; export is read-only and safe.
    // The listener must be registered before the request is sent.
    const streamPromise = receivePresetDumpStream(ctx.conn, { timeoutMs: 2000 });
    ctx.conn.send(buildRequestActiveBufferDump());
    let stream;
    try {
      stream = await streamPromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        'Fractal AM4',
        `export_preset: ${err instanceof Error ? err.message : String(err)}. Check the AM4 is connected (try reconnect_midi).`,
      );
    }
    // Concatenate header + chunks + footer in wire order.
    const flat: number[] = [...stream.headerBytes];
    for (const chunk of stream.chunkBytes) for (const b of chunk) flat.push(b);
    for (const b of stream.footerBytes) flat.push(b);
    const bytes = Uint8Array.from(flat);
    return {
      bytes,
      byte_length: bytes.length,
      frame_count: stream.messageCount,
      format: 'am4-preset-dump',
      // AM4's working-buffer name read needs a stored-location index the
      // active buffer doesn't have, so the name is omitted here; the
      // backup filename falls back to device + timestamp.
      source: 'active working buffer',
    };
  },

  async dumpStoredPresetBinary(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> {
    // Byte-exact backup of a STORED preset location via the fn 0x03
    // [bank, sub, 0x00] request (H1 encoding, hardware-confirmed
    // 2026-06-10: A01/A02/Z04 each answered the canonical 6-frame /
    // 12,352-byte stream with the [bank, sub] echoed in the 0x77
    // header, and NO working-buffer side effect). `location` is the
    // 0-based index 0..103 (A01..Z04).
    if (!Number.isInteger(location) || location < 0 || location > 103) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `export_preset: location index ${location} out of range — the AM4 has 104 stored locations, index 0..103 (A01..Z04).`,
      );
    }
    const code = formatLocationCode(location);
    const streamPromise = receivePresetDumpStream(ctx.conn, { timeoutMs: 2000 });
    ctx.conn.send(buildRequestStoredPresetDump(location));
    let stream;
    try {
      stream = await streamPromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        'Fractal AM4',
        `export_preset: stored-location dump of ${code} got no response — ${err instanceof Error ? err.message : String(err)}. Check the AM4 is connected (try reconnect_midi).`,
      );
    }
    const flat: number[] = [...stream.headerBytes];
    for (const chunk of stream.chunkBytes) for (const b of chunk) flat.push(b);
    for (const b of stream.footerBytes) flat.push(b);
    const bytes = Uint8Array.from(flat);
    // Best-effort stored-name read for the backup filename (same
    // helper scanLocations uses).
    let name: string | undefined;
    try {
      const parsed = await readPresetName(ctx.conn, location);
      name = parsed.name?.trimEnd() || undefined;
    } catch {
      name = undefined;
    }
    return {
      bytes,
      byte_length: bytes.length,
      frame_count: stream.messageCount,
      format: 'am4-preset-dump',
      name,
      source: `stored preset at location ${code} (fn 0x03 flash dump; working buffer untouched)`,
    };
  },

  async getBlockLayoutSnapshot(ctx: DispatchCtx): Promise<BlockLayoutSnapshot> {
    // 4 slot-register reads → block-type names per slot. Identical wire
    // shape to the `am4_get_block_layout` tool (HW-044); kept duplicated
    // rather than refactored to delegate because the tool surface returns
    // formatted text while this method returns structured data.
    const slots: BlockTypeName[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      slots.push(resolveBlockTypeValue(u32)?.name ?? ('none' as BlockTypeName));
    }
    return buildBlockLayoutSnapshot([slots[0], slots[1], slots[2], slots[3]]);
  },

  // Overwrite pre-check capability — backs the dispatcher's confirmable
  // overwrite gate. Reads the active location + the target's name, both
  // non-destructively. Returns undefined when occupancy can't be determined
  // (a read failed) so the dispatcher degrades rather than guessing.
  async checkOverwriteTarget(ctx: DispatchCtx, location: LocationRef): Promise<OverwriteTargetInfo | undefined> {
    const locationIndex = parseAm4Location(location);
    const target_display = formatLocationDisplay(locationIndex);
    let activeIndex: number | undefined;
    try {
      const parsed = await sendReadAndParse(ctx.conn, LOCATION_STATE_PID_LOW, LOCATION_STATE_PID_HIGH);
      const idx = parsed.asUInt32LE();
      if (idx >= 0 && idx <= 103) activeIndex = idx;
    } catch {
      activeIndex = undefined;
    }
    if (activeIndex !== undefined && activeIndex === locationIndex) {
      // Saving over the location we're editing is a refresh, not a clobber.
      return { target_display, is_active_location: true };
    }
    try {
      const resp = await readPresetName(ctx.conn, locationIndex);
      const occupant = resp.isEmpty ? undefined : (resp.name?.trim() || undefined);
      return { target_display, is_active_location: false, ...(occupant ? { occupant_name: occupant } : {}) };
    } catch {
      return undefined; // name read failed → let the dispatcher degrade
    }
  },

  // Read-after-save receipt capability — delegates to the module-scope
  // readSaveSnapshot() above (object-method names don't shadow module bindings).
  async readSaveSnapshot(ctx: DispatchCtx, location: LocationRef): Promise<{ snapshot: SavedSnapshot; missing: readonly string[] }> {
    return readSaveSnapshot(ctx, parseAm4Location(location));
  },

  async getPreset(ctx: DispatchCtx, options?: { include_channel_state?: boolean }): Promise<PresetSnapshot> {
    // Default OFF, matching II, but the cost asymmetry the old default was
    // built around is gone. The fn 0x1F `0x75` body is CHANNEL-BLOCKED: it
    // already carries all four channels (A/B/C/D, FIXED order, quarter 0 = A)
    // at `channel * stride + pidHigh` (stride = itemCount / 4). So
    // include_channel_state:true now reads B/C/D straight from the SAME dump
    // already read for the active channel: no per-param fn 0x02 loop, no
    // channel-state mutation (the old path did ~1182 serial GETs, ~6-60 s, and
    // mutated device channel state). Default OFF still returns only the active
    // channel to keep the response small and avoid the (amp-unreliable)
    // channel-selector read implying more than it can. Channel-blocked layout
    // confirmed on live AM4 hardware 2026-06-04 (cookbook am4-fn1f-atomic-read).
    const includeChannelState = options?.include_channel_state ?? false;
    // Server-side timer around the SysEx read loop — surfaced as
    // _meta.read_duration_ms (client-independent; alpha.17 finding).
    const readStartedMs = Date.now();

    // 1. Block layout (4 slot reads). Instance-aware: a second instance of a
    //    block type occupies base+1 in the slot register (observed on the wire
    //    — see resolveBlockTypeValue), so the resolver keeps it from reading
    //    back as 'none' and vanishing from the snapshot.
    const layoutSlots: { name: BlockTypeName; instance: number }[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      const info = resolveBlockTypeValue(u32);
      layoutSlots.push(info === undefined ? { name: 'none' as BlockTypeName, instance: 0 } : { name: info.name, instance: info.instance });
    }

    // 2. Per placed slot: chunk-based read via fn 0x1F + bypass read.
    //    Performance: ~50 ms per pidLow chunk, ~50 ms per bypass read. All
    //    channels come from the chunk(s) already read (channel-blocked), so
    //    include_channel_state adds no extra wire round-trips.
    const slots: PresetSnapshotSlot[] = [];
    const errors: string[] = [];
    let totalPlaced = 0;
    for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
      const { name: blockType, instance } = layoutSlots[slotIdx];
      if (blockType === 'none') continue;
      totalPlaced++;

      try {
        const pidLows = pidLowsForBlock(blockType);
        if (pidLows.length === 0) {
          errors.push(`slot ${slotIdx + 1} (${blockType}): no documented params`);
          continue;
        }
        // Instance blocks (slot code base+N): best-effort read at the shifted
        // pidLow (the slot code IS the block's pidLow for the base instance,
        // so instance N is assumed to answer at base+N — capture-pending).
        // Chunks stay keyed by the BASE pidLow so the KNOWN_PARAMS join in
        // decodeChannelParams is untouched; a wrong assumption lands in the
        // per-slot catch below and degrades to an errors[] entry.
        const chunks = new Map<number, { itemCount: number; values: number[] }>();
        for (const pidLow of pidLows) {
          const triple = await readAllParams(ctx.conn, pidLow + instance);
          chunks.set(pidLow, { itemCount: triple.itemCount, values: triple.values });
        }

        const bypassed = await readBypassState(ctx.conn, blockType, instance);

        // Shape decision: must match II reader so the response is consistent
        // across every channel-bearing block on every device. Non-channel
        // blocks use flat `params`; channel blocks surface params under
        // `params_by_channel`.
        let params: PresetSlotSpec['params'];
        let paramsByChannel: PresetSlotSpec['params_by_channel'];
        let channelStatus: PresetSnapshotSlot['channel_status'];
        if (!CHANNEL_BLOCKS.has(blockType)) {
          params = decodeChannelParams(blockType, chunks, 0);
        } else if (includeChannelState) {
          // All four channels from the SAME fn 0x1F dump via channel-stride
          // indexing (FIXED order A/B/C/D, quarter 0 = A). This replaces the
          // old ~1182 serial per-param fn 0x02 GETs across B/C/D (~6-60 s) AND
          // the channel-state mutation (switchBlockChannel + switch back): the
          // dump already holds all four channels at `channel * stride + pidHigh`
          // (stride = itemCount / 4). Live-hardware-confirmed 2026-06-04. No
          // active-channel resolution is needed for attribution.
          const allChannelParams: Record<string, Record<string, number | string>> = {};
          for (let c = 0; c < 4; c++) {
            const chParams = decodeChannelParams(blockType, chunks, c);
            if (Object.keys(chParams).length > 0) allChannelParams[channelLetter(c)] = chParams;
          }
          paramsByChannel = allChannelParams;
          channelStatus = Object.keys(allChannelParams).length === 4 ? 'all_channels' : 'active';
        } else {
          // Default path: return only the ACTIVE channel's quarter. The
          // selector read is reliable for reverb/delay/drive; amp's register
          // returns derived/cached firmware state (see decodeChannelSelector),
          // so amp degrades to channel A with channel_status='unknown'.
          const { letter: activeChannel, failureReason } =
            await readActiveChannelLetter(ctx.conn, blockType, instance);
          if (activeChannel !== undefined) {
            const idx = ['A', 'B', 'C', 'D'].indexOf(activeChannel);
            paramsByChannel = {
              [activeChannel]: decodeChannelParams(blockType, chunks, idx < 0 ? 0 : idx),
            };
            channelStatus = 'active';
          } else {
            // Selector unresolved: show channel A (quarter 0) as a best-effort
            // key. channel_status='unknown' signals the attribution is a
            // fallback, not a hardware-confirmed active-channel read.
            paramsByChannel = { A: decodeChannelParams(blockType, chunks, 0) };
            channelStatus = 'unknown';
            if (failureReason !== undefined) {
              errors.push(
                `slot ${slotIdx + 1} (${blockType}): channel-selector read failed -> ${failureReason}. ` +
                `channel_status='unknown' is a fallback; showing channel A (quarter 0 of the dump). ` +
                `Pass include_channel_state:true to read all four channels A/B/C/D directly.`,
              );
            }
          }
        }

        slots.push({
          slot: (slotIdx + 1) as 1 | 2 | 3 | 4,
          block_type: blockType,
          id: blockType,
          ...(bypassed !== undefined ? { bypassed } : {}),
          ...(params !== undefined ? { params } : {}),
          ...(paramsByChannel !== undefined ? { params_by_channel: paramsByChannel } : {}),
          channel_status: channelStatus,
        });
      } catch (err) {
        errors.push(`slot ${slotIdx + 1} (${blockType}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length === totalPlaced && totalPlaced > 0) {
      throw new DispatchError(
        'no_ack',
        'Fractal AM4',
        `get_preset: read failed on every placed block (${totalPlaced} blocks). First error: ${errors[0]}`,
      );
    }

    // Active scene read (best-effort, non-blocking on failure).
    let activeScene: number | undefined;
    try {
      const parsed = await sendReadAndParse(ctx.conn, SCENE_STATE_PID_LOW, SCENE_STATE_PID_HIGH);
      const sceneIndex = parsed.asUInt32LE();
      if (sceneIndex >= 0 && sceneIndex <= 3) activeScene = sceneIndex + 1;
    } catch {
      activeScene = undefined;
    }

    const hasChannelBearing = layoutSlots.some((b) => CHANNEL_BLOCKS.has(b.name));
    const channelStateHint = (!includeChannelState && hasChannelBearing)
      ? 'Only the active channel is included. Pass include_channel_state:true to get_preset for the full per-channel read (A/B/C/D, decoded from the same fn 0x1F dump; fast, no channel-state mutation).'
      : undefined;
    return {
      slots,
      active_scene: activeScene,
      ...(errors.length > 0 ? { read_warnings: errors } : {}),
      _meta: {
        device: 'Fractal AM4',
        read_at_ms: Date.now(),
        active_scene_only: true,
        routing_omitted: true,
        channel_state_omitted: !includeChannelState && hasChannelBearing,
        both_channels_read: includeChannelState,
        read_duration_ms: Date.now() - readStartedMs,
        ...(channelStateHint !== undefined ? { channel_state_hint: channelStateHint } : {}),
      },
    };
  },

  async scanLocations(ctx, from, to) {
    const fromIdx = parseAm4Location(from);
    const toIdx = parseAm4Location(to);
    if (fromIdx > toIdx) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `Scan range invalid: ${from} (idx ${fromIdx}) is after ${to} (idx ${toIdx}). Pass from <= to.`,
      );
    }
    const scanned: ScannedLocation[] = [];
    let failed_at: string | undefined;
    let failed_reason: string | undefined;
    for (let i = fromIdx; i <= toIdx; i++) {
      try {
        const parsed = await readPresetName(ctx.conn, i);
        scanned.push({
          location: formatLocationDisplay(i),
          name: parsed.name,
          is_empty: parsed.isEmpty,
        });
      } catch (err) {
        failed_at = formatLocationDisplay(i);
        failed_reason = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    return { scanned, failed_at, failed_reason };
  },

  lookupLineage(query) {
    const blockType = query.block_type;
    if (!LINEAGE_BLOCKS.includes(blockType as typeof LINEAGE_BLOCKS[number])) {
      return {
        ok: false,
        text: `Block type '${blockType}' has no Fractal-authored lineage corpus. Valid: ${LINEAGE_BLOCKS.join(', ')}.`,
      };
    }
    const result = runLineageLookup({
      block_type: blockType as typeof LINEAGE_BLOCKS[number],
      name: query.name,
      real_gear: query.real_gear,
      manufacturer: query.manufacturer,
      model: query.model,
    });
    if (!result.found) {
      const detail = result.shape === 'structured'
        ? [
            query.manufacturer && `manufacturer="${query.manufacturer}"`,
            query.model && `model="${query.model}"`,
          ].filter(Boolean).join(', ')
        : (query.name ?? query.real_gear ?? '(unknown query)');
      return {
        ok: false,
        text: `No ${blockType} lineage records match ${detail}. ${result.totalScanned} records scanned.`,
      };
    }
    const withQuotes = query.include_quotes ?? true;
    if (result.shape === 'forward') {
      const rec = result.hits[0].record;
      const baseText = formatLineageRecord(rec, withQuotes);
      const knobs = formatApplicableKnobs(blockType, rec.am4Name);
      const loudness = formatLoudnessAppendix(rec.am4Name);
      const parts = [baseText, knobs, loudness].filter((s): s is string => Boolean(s));
      return { ok: true, text: parts.join('\n') };
    }
    const blocks = result.hits.map((h) => {
      const am4Name = 'am4Name' in h ? h.am4Name : '?';
      const recordText = formatLineageRecord(h.record, withQuotes, 3);
      const knobs = formatApplicableKnobs(blockType, am4Name);
      const loudness = formatLoudnessAppendix(am4Name);
      const parts = [recordText, knobs, loudness].filter((s): s is string => Boolean(s));
      return `── ${am4Name} ──\n${parts.join('\n')}`;
    });
    return {
      ok: true,
      text: `${result.hits.length} ${blockType} match(es)${result.hits.length > 10 ? ' (showing top 10)' : ''}:\n\n${blocks.join('\n\n')}`,
    };
  },

  lineageCorpus() {
    // One text blob per block type containing every record in the
    // corpus, each formatted with `formatLineageRecord`. Includes the
    // applicable-knobs footer so the agent reading this resource gets
    // the same context-rich view as a `lookup_lineage` reverse hit.
    // include_quotes defaults to true (matching `lookupLineage`'s
    // default), with a tight per-record cap of 3 quotes so the corpus
    // blob stays under MCP resource size limits.
    const out: Record<string, string> = {};
    for (const blockType of LINEAGE_BLOCKS) {
      const records = loadLineage(blockType);
      if (records.length === 0) continue;
      const blocks = records.map((rec) => {
        const recordText = formatLineageRecord(rec, true, 3);
        const knobs = formatApplicableKnobs(blockType, rec.am4Name);
        const loudness = formatLoudnessAppendix(rec.am4Name);
        const parts = [recordText, knobs, loudness].filter((s): s is string => Boolean(s));
        return `── ${rec.am4Name} ──\n${parts.join('\n')}`;
      });
      out[blockType] = `${records.length} ${blockType} records:\n\n${blocks.join('\n\n')}`;
    }
    return out;
  },
};
