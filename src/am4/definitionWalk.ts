/**
 * AM4 / VP4 READ-ONLY definition walk.
 *
 * The AM4/VP4 definition path builds its `effectDefinitions_*.cache` from three plain `func 0x01 /
 * action 0x0D` reads whose `pidHigh` selects a pseudo-register:
 *
 *   | purpose                    | pidHigh | payload                  | reply payload |
 *   |----------------------------|---------|--------------------------|---------------|
 *   | block descriptor (count)   | `0x07DD`| none                     | 54 bytes      |
 *   | parameter definition       | `0x07DC`| `u32 paramIndex`         | 40 bytes      |
 *   | one enum label             | `0x07EB`| `u32 paramIndex, u32 str`| 40 bytes      |
 *
 * There is NO paging and no sentinel: a block holds exactly the parameter count its descriptor
 * reports (0 = the block has none), and the label pass runs `stringIndex = min..max` of the
 * definition it belongs to. One request is outstanding at a time. The whole path is read-only:
 * this module builds through `buildAm4ReadFrame` (./readFrame.ts), which refuses every action
 * outside `{0x0D, 0x12}` and has no write twin. `selfDescribe` / `fullCapture` write paths are
 * never enabled from here.
 *
 * Definition payload (40 bytes, little-endian):
 *
 *   `+0x00` echo (not read by the definition path; informational here)
 *   `+0x04` u16 typecode hi, `+0x06` u16 typecode lo → `tc = (hi << 4) | lo`
 *   `+0x08` unused on this path
 *   `+0x0C` f32 min, `+0x10` f32 max, `+0x18` f32 def, `+0x1C` f32 step
 *   `+0x14` live state (byte 22 is the block's bypass flag; not a definition field)
 *   `+0x20` u32 hasStrings (0 = no label list), `+0x24` u16 flags (bit 0x04 = label list present)
 *
 * The record flags are composed as `(u16@+0x24) | (u32@+0x20 != 0 ? 0x04 : 0)`.
 *
 * Unlike gen-3 there is NO separate scale word: `def` (wire `+0x18`) is the value the cache stores
 * under `def`, and `buildDeviceCache` reads it as the display multiplier, exactly as on the gen-3
 * path. The record id is the parameter index that was requested — it is not in the payload.
 *
 * Label gate: typecode class `(tc >> 4) & 0xF` in `{1,2,10,11,12}` AND `flags & 0x04` of the
 * composed flags. Labels are positional by arrival order (the label handler appends to a vector),
 * and the label text is the 32-character `char[32]` field at payload `+0x08` — NOT the whole
 * 40-byte payload; the first eight bytes are echo/value words and would corrupt a label.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import type { CacheRecord } from '../cache/types.js';
import {
  AM4_READ_ACTION_LONG,
  AM4_READ_MODEL_AM4,
  buildAm4ReadFrame,
  isAm4ReadModel,
  requestAm4Read,
} from './readFrame.js';
import type { Am4ReadOptions, Am4ReadStats, Am4ReadTransport } from './readFrame.js';

/** `pidHigh` of the block descriptor that supplies the parameter count. */
export const AM4_PARAM_COUNT_PID_HIGH = 0x07dd;
/** `pidHigh` of one parameter definition record. */
export const AM4_PARAM_DEFINITION_PID_HIGH = 0x07dc;
/** `pidHigh` of one enum label string. */
export const AM4_PARAM_LABEL_PID_HIGH = 0x07eb;

/** Typecode classes whose parameters can carry a label list (the AM4 label gate). */
export const AM4_LABEL_TYPECODE_CLASSES: ReadonlySet<number> = new Set([1, 2, 10, 11, 12]);
/** Definition `flags` bit that marks a label list. */
export const AM4_LABEL_FLAG = 0x0004;

const BLOCK_DESCRIPTOR_PAYLOAD_BYTES = 54;
const DEFINITION_PAYLOAD_BYTES = 40;
const LABEL_TEXT_OFFSET = 8;
const LABEL_TEXT_BYTES = 32;

/** Encode a `u32` as 4 little-endian bytes (an AM4 read payload). */
function u32Payload(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`AM4/VP4 read: ${value} is not a u32 payload`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function checkModel(model: number): void {
  if (!isAm4ReadModel(model)) throw new Error(`AM4/VP4 definition walk: model 0x${model.toString(16)} is not AM4 (0x15) or VP4 (0x14)`);
}

/**
 * Build the block-descriptor READ: `action 0x0D`, `pidHigh 0x07DD`, no payload. The reply carries
 * the block's parameter count (`parseBlockDescriptor`).
 */
export function buildReadBlockDescriptor(blockPidLow: number, model = AM4_READ_MODEL_AM4): number[] {
  checkModel(model);
  return buildAm4ReadFrame(model, blockPidLow, AM4_PARAM_COUNT_PID_HIGH, AM4_READ_ACTION_LONG);
}

/**
 * Build one parameter-definition READ: `action 0x0D`, `pidHigh 0x07DC`, payload = the parameter's
 * index inside the block. The reply is the 40-byte definition record (`parseParamDefinition`).
 */
export function buildReadParamDefinition(blockPidLow: number, paramIndex: number, model = AM4_READ_MODEL_AM4): number[] {
  checkModel(model);
  return buildAm4ReadFrame(model, blockPidLow, AM4_PARAM_DEFINITION_PID_HIGH, AM4_READ_ACTION_LONG, u32Payload(paramIndex));
}

/**
 * Build one enum-label READ: `action 0x0D`, `pidHigh 0x07EB`, payload = `{u32 paramIndex,
 * u32 stringIndex}`. `stringIndex` is the parameter's RAW VALUE (`min..max`), not a list index.
 */
export function buildReadParamLabel(blockPidLow: number, paramIndex: number, stringIndex: number, model = AM4_READ_MODEL_AM4): number[] {
  checkModel(model);
  const payload = new Uint8Array(8);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, paramIndex, true);
  dv.setUint32(4, stringIndex, true);
  return buildAm4ReadFrame(model, blockPidLow, AM4_PARAM_LABEL_PID_HIGH, AM4_READ_ACTION_LONG, payload);
}

/** A decoded `pidHigh 0x07DD` block descriptor payload. */
export interface Am4BlockDescriptor {
  /** Number of parameters the block holds (0 = the block has none). */
  paramCount: number;
}

/**
 * Parse a block-descriptor payload: exactly 54 bytes, parameter count = `u16` at `+0x02`. Returns
 * `null` for any other length (the 54-byte form is the only one the AM4 definition path accepts).
 */
export function parseBlockDescriptor(payload: Uint8Array): Am4BlockDescriptor | null {
  if (payload.length !== BLOCK_DESCRIPTOR_PAYLOAD_BYTES) return null;
  const paramCount = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(2, true);
  return { paramCount };
}

/** A decoded `pidHigh 0x07DC` parameter-definition payload. */
export interface Am4ParamDefinition {
  /** `(typecodeHi << 4) | typecodeLo`. */
  tc: number;
  min: number;
  max: number;
  /** The value the cache stores under `def` (display multiplier), from wire `+0x18`. */
  def: number;
  step: number;
  /** Wire `+0x20 != 0`: the "has a string list" word. */
  hasStrings: boolean;
  /**
   * The composed flags word: wire `+0x24` with bit `0x04` added when `+0x20` is non-zero — the
   * record flags the label gate reads.
   */
  flags: number;
  /** The AM4 label gate: typecode class in {1,2,10,11,12} AND `flags & 0x04`. */
  hasLabelList: boolean;
}

/**
 * Parse a parameter-definition payload: exactly 40 bytes. Returns `null` on a wrong length, an
 * impossible typecode split (hi > 0xFFF or lo > 0xF), a non-finite numeric field, `min > max`, or
 * an empty typecode whose numeric body is not the unused-slot default (`tc 0` with a 0..1 range is
 * what an unused parameter index answers — kept as an ordinary record).
 */
export function parseParamDefinition(payload: Uint8Array): Am4ParamDefinition | null {
  if (payload.length !== DEFINITION_PAYLOAD_BYTES) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const tcHi = dv.getUint16(4, true);
  const tcLo = dv.getUint16(6, true);
  if (tcHi > 0xfff || tcLo > 0x0f) return null;
  const tc = (tcHi << 4) | tcLo;
  const min = dv.getFloat32(0x0c, true);
  const max = dv.getFloat32(0x10, true);
  const def = dv.getFloat32(0x18, true);
  const step = dv.getFloat32(0x1c, true);
  if (![min, max, def, step].every((x) => Number.isFinite(x))) return null;
  if (min > max) return null;
  const hasStrings = dv.getUint32(0x20, true) !== 0;
  // The record flags are the wire +0x24 word plus bit 0x04 when the +0x20 "has a string list"
  // word is non-zero. The label gate reads the COMPOSED flags, not +0x24 alone.
  const flags = dv.getUint16(0x24, true) | (hasStrings ? AM4_LABEL_FLAG : 0);
  const hasLabelList = AM4_LABEL_TYPECODE_CLASSES.has((tc >> 4) & 0x0f) && (flags & AM4_LABEL_FLAG) !== 0;
  return { tc, min, max, def, step, hasStrings, flags, hasLabelList };
}

/** A decoded `pidHigh 0x07EB` label payload. */
export interface Am4ParamLabel {
  /** The 32-character text field at payload `+0x08`, NUL-terminated, non-printables as spaces. */
  text: string;
}

/**
 * Parse a label payload: exactly 40 bytes; the label is the `char[32]` field at `+0x08` only.
 * Bytes with bit 7 set or below 0x20 are read as spaces, and a NUL ends the string. Returns
 * `null` on a wrong length.
 */
export function parseParamLabel(payload: Uint8Array): Am4ParamLabel | null {
  if (payload.length !== DEFINITION_PAYLOAD_BYTES) return null;
  let text = '';
  for (let i = 0; i < LABEL_TEXT_BYTES; i++) {
    const c = payload[LABEL_TEXT_OFFSET + i]!;
    if (c === 0x00) break;
    text += String.fromCharCode(c >= 0x20 && c < 0x7f ? c : 0x20);
  }
  return { text };
}

/** Options of `am4DefinitionWalk`. */
export interface Am4DefinitionWalkOptions extends Am4ReadOptions {
  /** Block `pidLow` addresses to read, in walk order (the walk uses one base per block window). */
  blocks: readonly number[];
  /** AM4 `0x15` (default) or VP4 `0x14`. */
  model?: number;
  /** `pidLow` → cache section tag, when the caller knows the block's section (default: `pidLow`). */
  sections?: Readonly<Record<number, number>>;
  /** Walk label lists (default true). */
  readLabels?: boolean;
  /** Hard cap on labels collected for one parameter (default 1024, like the gen-3 walk). */
  enumCountCap?: number;
  /** Optional host sanity cap on a block's device-supplied count (default: none — the device is trusted). */
  maxParamsPerBlock?: number;
}

/** Outcome of `am4DefinitionWalk`. */
export interface Am4DefinitionWalkResult extends Am4ReadStats {
  /** One record per read parameter, ascending parameter index within each block, blocks in walk order. */
  records: CacheRecord[];
  /** Blocks whose descriptor was read and parsed (count 0 included). */
  blocksRead: number;
  /** Definition records produced. */
  paramsRead: number;
  /** Parameters whose label pass ran (a label list the definition gate selected). */
  labelLists: number;
  /** Labels collected. */
  labelsRead: number;
}

/** The record a decoded definition becomes (an enum when labels were collected, else a float). */
function definitionRecord(section: number, paramIndex: number, d: Am4ParamDefinition, labels: readonly string[]): CacheRecord {
  if (labels.length > 0) {
    const declared = Math.round(d.max - d.min + 1);
    return {
      kind: 'enum',
      section,
      offset: 0,
      id: paramIndex,
      tc: d.tc,
      min: d.min,
      max: d.max,
      def: d.def,
      step: d.step,
      count: declared >= 1 ? declared : labels.length,
      values: [...labels],
      x: 0,
    };
  }
  return {
    kind: 'float',
    section,
    offset: 0,
    id: paramIndex,
    tc: d.tc,
    min: d.min,
    max: d.max,
    def: d.def,
    step: d.step,
    t1: 0,
    t2: 0,
  };
}

/**
 * Walk every parameter definition of `opts.blocks` over a READ-ONLY transport. For each block:
 * read the descriptor (count), then each parameter's definition (`0..count-1`), then — for a
 * definition the label gate selects — one label read per raw value `min..max`. A lost reply is
 * counted and skipped; a malformed reply is counted and skipped. No frame outside `action 0x0D`
 * is ever sent.
 *
 * Records use the caller's `sections` mapping (default `pidLow`) so the result can feed
 * `buildDeviceCache`/`buildCache` with cache section tags. There is no `scale` word on this path:
 * `def` is copied verbatim from the wire, exactly as the cache stores it.
 */
export async function am4DefinitionWalk(transport: Am4ReadTransport, opts: Am4DefinitionWalkOptions): Promise<Am4DefinitionWalkResult> {
  const model = opts.model ?? AM4_READ_MODEL_AM4;
  checkModel(model);
  const sectionOf = (block: number): number => opts.sections?.[block] ?? block;
  const readLabels = opts.readLabels ?? true;
  const enumCap = opts.enumCountCap ?? 1024;
  const maxParams = opts.maxParamsPerBlock;
  const stats: Am4ReadStats = { queries: 0, lostReplies: 0, malformedReplies: 0 };
  const records: CacheRecord[] = [];
  let blocksRead = 0;
  let paramsRead = 0;
  let labelLists = 0;
  let labelsRead = 0;

  for (const block of opts.blocks) {
    const descriptorPayload = await requestAm4Read(
      transport,
      buildReadBlockDescriptor(block, model),
      { model, pidLow: block, pidHigh: AM4_PARAM_COUNT_PID_HIGH, action: AM4_READ_ACTION_LONG },
      opts,
      stats,
    );
    if (!descriptorPayload) continue;
    const descriptor = parseBlockDescriptor(descriptorPayload);
    if (!descriptor) {
      stats.malformedReplies += 1;
      continue;
    }
    blocksRead += 1;
    let count = descriptor.paramCount;
    if (typeof maxParams === 'number' && Number.isInteger(maxParams) && maxParams >= 0) count = Math.min(count, maxParams);
    const section = sectionOf(block);

    for (let paramIndex = 0; paramIndex < count; paramIndex++) {
      const definitionPayload = await requestAm4Read(
        transport,
        buildReadParamDefinition(block, paramIndex, model),
        { model, pidLow: block, pidHigh: AM4_PARAM_DEFINITION_PID_HIGH, action: AM4_READ_ACTION_LONG },
        opts,
        stats,
      );
      if (!definitionPayload) continue;
      const def = parseParamDefinition(definitionPayload);
      if (!def) {
        stats.malformedReplies += 1;
        continue;
      }
      paramsRead += 1;

      const labels: string[] = [];
      if (readLabels && def.hasLabelList) {
        const firstOrdinal = Math.floor(def.min);
        // The string count is the inclusive min..max range (`int(max - min + 0.5) + 1`): a
        // fractional bound must round, not truncate, so a real label is not dropped.
        const labelCount = Math.round(def.max - def.min + 1);
        if (firstOrdinal >= 0 && labelCount >= 1 && labelCount <= enumCap) {
          labelLists += 1;
          for (let i = 0; i < labelCount; i++) {
            const ordinal = firstOrdinal + i;
            const labelPayload = await requestAm4Read(
              transport,
              buildReadParamLabel(block, paramIndex, ordinal, model),
              { model, pidLow: block, pidHigh: AM4_PARAM_LABEL_PID_HIGH, action: AM4_READ_ACTION_LONG },
              opts,
              stats,
            );
            if (!labelPayload) break; // a short list stays short; later labels would be misaligned
            const label = parseParamLabel(labelPayload);
            if (!label) {
              stats.malformedReplies += 1;
              break;
            }
            labels.push(label.text);
          }
          labelsRead += labels.length;
        }
      }

      records.push(definitionRecord(section, paramIndex, def, labels));
    }
  }

  return { records, queries: stats.queries, lostReplies: stats.lostReplies, malformedReplies: stats.malformedReplies, blocksRead, paramsRead, labelLists, labelsRead };
}
