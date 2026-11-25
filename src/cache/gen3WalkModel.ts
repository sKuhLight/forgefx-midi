/**
 * Per-model constants of the gen-3 self-describe definition walk, plus the read-only request
 * builders that depend on them.
 *
 * The definition walk itself is model-generic: the definition path has ONE implementation whose
 * every builder is gated on `model ∈ {0x10, 0x11, 0x12}` (Axe-Fx III / FM3 / FM9) with no
 * per-model branch. The wire grammar is identical on all three:
 *
 *   query  `F0 00 01 74 <model> 01 <15-byte header> <cksum> F7`
 *   header `u16 sub | u16 a | u16 b | u32 c (4 septets + a high-nibble byte) | u16 | u16 n`,
 *          each u16 little-endian in two 7-bit septets (15 header bytes).
 *   reply  `inner = frame[6:-2]` with the same 15-byte header, `inner[13:15]` = u16-LE raw
 *          payload count, `inner[15:]` = a continuous MSB-first septet stream.
 *
 * What DOES differ per model are five data constants, and they are kept here in one small table
 * rather than at each call site:
 *
 *   - `messageObjectSize` — the device-message heap allocation in bytes. It is NOT a wire frame
 *     limit: the 0x2E reply alone is larger than it. Informational data; the walk never reads it.
 *   - `gridBlobSize` — raw payload bytes of the func 0x01 sub 0x2E grid / preset-layout blob,
 *     i.e. the buffer cleared before the request (III 640, FM9 640, FM3 496). Informational data;
 *     the walk never reads it.
 *   - `cabRecordSize` — the cab/IR bank array stride in bytes (III/FM9 0x2B0, FM3 0x220). The
 *     reply layout is undecoded on every model, so a reader returns the raw bytes and never
 *     assumes this is the payload size.
 *   - `blockSweepBound` — the block-type ordinal bound (exclusive): the definition sweep covers
 *     ordinals 1..bound-1 (III 0x3D, FM9/FM3 0x3B). Ordinals are NOT effect ids; the ordinal →
 *     block-id pair map is not part of this codec.
 *   - `cabBankSub` — the func 0x01 sub-op of the cab/IR bank record read (III 0x68, FM3 0x9F,
 *     FM9 0xA4).
 *
 * Parameter counts are NOT in this table. A block's parameter count is device-supplied by the
 * func 0x01 sub 0x01 block descriptor (a 56-byte payload carries it at `+0x04`; an 80-byte
 * payload at `+0x1C`) — never a fixed in-memory constant. `decodeBlockDescriptor` in
 * ./gen3WalkReplies.ts reads it; `LiveWalkOptions.paramCountByBlock` feeds it into the walk,
 * where it can only TIGHTEN a block's query bound.
 *
 * Label lists are positional: the label reply carries block + param but NO ordinal (the label
 * handler receives a constant 0), so labels are consumed in request order. The label-table
 * condition is typecode class `{1, 10, 11, 12}` (class 2 is deliberately excluded) together with
 * a non-zero wire `+0x1C` label-table word. `GEN3_LABEL_TYPECODE_CLASSES` carries that set.
 *
 * Pure and browser-safe — no `node:*`, no `Buffer`.
 */
import { fractalChecksum } from '../shared/checksum.js';
import { AXE3_EFFECT_ID_TABLE } from '../gen3/axe-fx-iii/effectIds.js';
import { FM3_EFFECT_ID_TABLE } from '../gen3/fm3/effectIds.js';
import { FM9_EFFECT_ID_TABLE } from '../gen3/fm9/effectIds.js';

/** A model's effect-id roster row (the fields this module and `liveWalk` read). */
export interface Gen3EffectIdRow {
  readonly family: string;
  readonly firstId: number | null;
  readonly instances: number;
  readonly addressing: string;
  readonly confidence?: string;
}

/** The branched constants and the roster of one gen-3 model (see the module comment). */
export interface Gen3WalkProfile {
  /** Device model byte (`0x10` Axe-Fx III, `0x11` FM3, `0x12` FM9). */
  readonly model: number;
  /** Display name, for reports. */
  readonly name: string;
  /** Message-object allocation in bytes (informational; not a wire frame limit; the walk never reads it). */
  readonly messageObjectSize: number;
  /** Raw payload bytes of the func 0x01 sub 0x2E grid / preset-layout blob (informational; the walk never reads it). */
  readonly gridBlobSize: number;
  /** Cab/IR bank array stride in bytes (the reply layout is undecoded; see the module comment). */
  readonly cabRecordSize: number;
  /** Block-type ordinal bound, exclusive (the definition sweep covers 1..bound-1). */
  readonly blockSweepBound: number;
  /** func 0x01 sub-op of the cab/IR bank record read. */
  readonly cabBankSub: number;
  /** The model's family / effect-id roster. */
  readonly effectIds: readonly Gen3EffectIdRow[];
}

/** The gen-3 definition-walk profiles, one per model. */
export const GEN3_WALK_PROFILES: readonly Gen3WalkProfile[] = Object.freeze([
  Object.freeze({
    model: 0x10,
    name: 'Axe-Fx III',
    messageObjectSize: 0x268,
    gridBlobSize: 640,
    cabRecordSize: 0x2b0,
    blockSweepBound: 0x3d,
    cabBankSub: 0x68,
    effectIds: AXE3_EFFECT_ID_TABLE,
  }),
  Object.freeze({
    model: 0x11,
    name: 'FM3',
    messageObjectSize: 0x1c0,
    gridBlobSize: 496,
    cabRecordSize: 0x220,
    blockSweepBound: 0x3b,
    cabBankSub: 0x9f,
    effectIds: FM3_EFFECT_ID_TABLE,
  }),
  Object.freeze({
    model: 0x12,
    name: 'FM9',
    messageObjectSize: 0x1c0,
    gridBlobSize: 640,
    cabRecordSize: 0x2b0,
    blockSweepBound: 0x3b,
    cabBankSub: 0xa4,
    effectIds: FM9_EFFECT_ID_TABLE,
  }),
] as const);

const PROFILE_BY_MODEL: ReadonlyMap<number, Gen3WalkProfile> = new Map(GEN3_WALK_PROFILES.map((p) => [p.model, p]));

/** The profile of a gen-3 model byte, or `undefined` for any other model. */
export function gen3WalkProfile(model: number | undefined | null): Gen3WalkProfile | undefined {
  return typeof model === 'number' ? PROFILE_BY_MODEL.get(model) : undefined;
}

/**
 * Typecode classes whose parameters can carry a value-label list, according to the label-table
 * condition. The gate is the class set AND a non-zero wire `+0x1C` label-table word: the class
 * alone is not enough (11-13 % of label-capable-class params have no list), and class 2 is
 * excluded although the value de-normalise set `{1,2,10,11,12}` includes it.
 */
export const GEN3_LABEL_TYPECODE_CLASSES: ReadonlySet<number> = new Set([1, 10, 11, 12]);

/** `(typecode >> 4) & 0xF` — the wire typecode class. */
export function gen3TypecodeClass(tc: number): number {
  return (tc >> 4) & 0x0f;
}

/** func 0x01 sub-op of the block descriptor that supplies a block's parameter count. */
export const GEN3_BLOCK_DESCRIPTOR_SUB = 0x01;
/** func 0x01 sub-op of the per-slot preset-name read. */
export const GEN3_PRESET_NAME_SUB = 0x4b;

/** The block-type ordinals the definition sweep covers, ascending (1..bound-1). */
export function gen3BlockSweepOrdinals(model: number): readonly number[] {
  const profile = gen3WalkProfile(model);
  if (!profile) return [];
  const out: number[] = [];
  for (let ordinal = 1; ordinal < profile.blockSweepBound; ordinal++) out.push(ordinal);
  return out;
}

/** Largest value the four `c` septets can carry (`0x0FFFFFFF`); the fifth byte holds bits 28..31. */
const MAX_C_WORD = 0xfffffff;

/**
 * Build one func 0x01 self-describe request of a gen-3 model: the 15-byte header
 * `u16 sub | u16 a | u16 b | u32 c | u16 | u16 n`. The packer writes each u16 as two
 * little-endian septets, and `c` as four septets of its low 28 bits plus one byte with the high
 * nibble — 2 + 2 + 2 + 5 + 2 + 2 = 15 bytes. No payload is attached (`n` = 0).
 *
 * The `sub` field is a 14-bit word, NOT a single byte: a captured `sub 0x4B` request carries
 * `4B 00`, and a cab-bank sub (`0x9F` / `0xA4`) therefore travels as `1F 01` / `24 01`. A literal
 * `0x9F` byte has bit 7 set and cannot appear in a SysEx data stream.
 */
function buildSubQuery(model: number, sub: number, a: number, b: number, c: number): Uint8Array {
  if (!gen3WalkProfile(model)) throw new Error(`gen3 self-describe: model 0x${model.toString(16)} is not a gen-3 definition-walk model`);
  if (!Number.isInteger(sub) || sub < 0 || sub > 0x3fff) throw new Error(`gen3 self-describe: sub ${sub} is not a 14-bit field`);
  if (!Number.isInteger(a) || a < 0 || a > 0x3fff) throw new Error(`gen3 self-describe: a ${a} is not a 14-bit field`);
  if (!Number.isInteger(b) || b < 0 || b > 0x3fff) throw new Error(`gen3 self-describe: b ${b} is not a 14-bit field`);
  if (!Number.isInteger(c) || c < 0 || c > MAX_C_WORD) throw new Error(`gen3 self-describe: c ${c} is not a 28-bit word`);
  const body = [
    sub & 0x7f,
    (sub >> 7) & 0x7f,
    a & 0x7f,
    (a >> 7) & 0x7f,
    b & 0x7f,
    (b >> 7) & 0x7f,
    c & 0x7f,
    (c >> 7) & 0x7f,
    (c >> 14) & 0x7f,
    (c >> 21) & 0x7f,
    0, // c bits 28..31 (0 for every 28-bit c; the packer sends them as one raw byte)
    0,
    0, // the header's +0x10 word
    0,
    0, // n: no payload
  ];
  const core = [0xf0, 0x00, 0x01, 0x74, model & 0x7f, 0x01, ...body];
  return Uint8Array.from([...core, fractalChecksum(core), 0xf7]);
}

/**
 * Build the block-descriptor query of a gen-3 model: func 0x01 sub 0x01, `a` = block id, `b` =
 * 0, no payload. The reply carries the block's parameter count (see
 * `decodeBlockDescriptor`).
 */
export function buildBlockDescriptorQuery(model: number, block: number): Uint8Array {
  return buildSubQuery(model, GEN3_BLOCK_DESCRIPTOR_SUB, block, 0, 0);
}

/**
 * Build the preset-name read of a gen-3 model: func 0x01 sub 0x4B, `c` = the slot word the
 * device uses for the preset location. The device answers with a 32-byte name payload whose
 * leading NUL-terminated run is the name; replies are matched by request order (the reply's `c`
 * word is not the requested slot).
 *
 * The slot word's own encoding is only MED: a captured batch used `c = 0x1000..0x100F` (slot 0-15
 * under a `bank * 1024 + slot` reading, bank 4), but the bank convention is not established. Pass
 * the word the host's device layer uses; this builder does not derive a bank.
 */
export function buildPresetNameQuery(model: number, slotWord: number): Uint8Array {
  return buildSubQuery(model, GEN3_PRESET_NAME_SUB, 0, 0, slotWord);
}

/**
 * Build the cab/IR bank record read of a gen-3 model: func 0x01 with the model's `cabBankSub`,
 * `c` = the 0-based record index, no payload. The request shape is confirmed on all three
 * models; the reply layout is NOT decoded, so callers treat the payload as raw bytes (see
 * `decodeCabBankRecordReply`). The bank itself is not on the wire: tag the reply with the bank
 * that was asked for.
 */
export function buildCabBankQuery(model: number, index: number): Uint8Array {
  const profile = gen3WalkProfile(model);
  if (!profile) throw new Error(`gen3 self-describe: model 0x${model.toString(16)} has no cab/IR bank read`);
  return buildSubQuery(model, profile.cabBankSub, 0, 0, index);
}
