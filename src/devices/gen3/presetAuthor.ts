/**
 * Gen-3 offline preset AUTHORING: take an exported `.syx` (or a stored-preset
 * dump), edit it, and emit a new device-valid `.syx`. This is the write-back /
 * authoring leg that complements the read path (presetDump → presetHuffman →
 * presetBody). Everything here is FILE-level: it produces bytes a device would
 * accept (CRC + footer recomputed), but host→device restore is still
 * hardware-unverified, so callers treat the output as a backup/authoring file.
 *
 * The re-framing is built on three already-validated primitives:
 *   - `reencodeRawPatch` (presetHuffman) recompresses an edited body + rewrites
 *     the CRC-16/CCITT the device validates.
 *   - `computeRawPatchXor` (presetHuffman) gives the `fn=0x79` footer value;
 *     confirmed byte-exact against the III factory banks + an FM9 export.
 *   - `typeFieldByteOffset` (presetBody) gives the exact body offset of a
 *     block's effect-type id, per device — the inverse of the decoder, so an
 *     edit re-decodes consistently.
 *
 * STRUCTURE SOURCE: the `.syx` re-frame (preserve 0x77 greeting, regenerate the
 * 0x78 chunk run, recompute the 0x79 XOR footer) and the block-type-swap
 * semantics mirror the BoodieTraps Apache-2.0 `fractal-syx-codec` reference
 * (fm3_syx_encoder.py `encode_preset_to_syx` / fm3_preset_writer.py
 * `swap_block_type`). Reimplemented onto OUR per-device type-location table
 * (presetBody DEVICE_PROFILES), which is device-true for III/FM3/FM9 rather than
 * FM3-only. See the repo NOTICE + README Credits.
 */

import { TYPE_BINARY_IDS } from './gen3BodyTables.js';
import {
  decodeRawPatch,
  reencodeRawPatch,
  computeRawPatchXor,
  computeRawPatchCrc,
  encode16to3,
  RAW_PATCH_CRC_OFFSET,
} from './presetHuffman.js';
import { decodeGen3Body, getProfile, typeFieldByteOffset, type Gen3Block } from './presetBody.js';
import {
  parsePresetDump,
  serializePresetDump,
  CHUNK_PAYLOAD_LEN,
  type ParsedPresetDump,
} from './presetDump.js';

/** Body bytes per 0x78 chunk: the 3074-byte payload minus its 2-byte discriminator. */
const CHUNK_BODY_LEN = CHUNK_PAYLOAD_LEN - 2; // 3072

/** Septet-pack the 16-bit footer XOR into the 3-byte `fn=0x79` payload. */
export function encodeFooterXor(xor: number): Uint8Array {
  return Uint8Array.from([xor & 0x7f, (xor >> 7) & 0x7f, (xor >> 14) & 0x7f]);
}

/**
 * Rebuild a parsed dump around a new (edited) raw_patch image, ready for
 * `serializePresetDump`. The 0x77 header is preserved verbatim; each 0x78
 * chunk re-uses its original 2-byte discriminator (`00 08` on every gen-3
 * device observed) and carries the re-packed body; the 0x79 footer is
 * recomputed from the new patch's uint16 XOR. The new raw_patch must pack to
 * exactly the original chunk count (same length as the source patch).
 */
export function reframeRawPatch(parsed: ParsedPresetDump, newRawPatch: Uint8Array): ParsedPresetDump {
  const packed = encode16to3(newRawPatch);
  const expectChunks = parsed.chunkPayloads.length;
  if (packed.length !== expectChunks * CHUNK_BODY_LEN) {
    throw new Error(
      `reframeRawPatch: re-packed body is ${packed.length} bytes but the source dump has ` +
        `${expectChunks} chunks (${expectChunks * CHUNK_BODY_LEN} bytes). raw_patch length mismatch.`,
    );
  }
  const chunkPayloads: Uint8Array[] = [];
  for (let i = 0; i < expectChunks; i++) {
    const payload = new Uint8Array(CHUNK_PAYLOAD_LEN);
    payload.set(parsed.chunkPayloads[i].subarray(0, 2), 0); // original discriminator
    payload.set(packed.subarray(i * CHUNK_BODY_LEN, (i + 1) * CHUNK_BODY_LEN), 2);
    chunkPayloads.push(payload);
  }
  return {
    ...parsed,
    chunkPayloads,
    footerPayload: encodeFooterXor(computeRawPatchXor(newRawPatch)),
  };
}

/** Parse a dump, re-frame it around `newRawPatch`, and serialize to `.syx`. */
export function reencodeDumpFromRawPatch(dumpBytes: Uint8Array, newRawPatch: Uint8Array): Uint8Array {
  const parsed = parsePresetDump(dumpBytes);
  return serializePresetDump(reframeRawPatch(parsed, newRawPatch));
}

function writeCrc(rawPatch: Uint8Array): Uint8Array {
  const out = rawPatch.slice();
  out[RAW_PATCH_CRC_OFFSET] = 0;
  out[RAW_PATCH_CRC_OFFSET + 1] = 0;
  const crc = computeRawPatchCrc(out);
  out[RAW_PATCH_CRC_OFFSET] = crc & 0xff;
  out[RAW_PATCH_CRC_OFFSET + 1] = (crc >> 8) & 0xff;
  return out;
}

/**
 * Rename a preset: write up to 31 ASCII chars into the raw_patch header name
 * field (0x08..0x28), recompute the CRC, and re-frame. The compressed body is
 * untouched (the name lives in the uncompressed header).
 */
export function renamePreset(dumpBytes: Uint8Array, newName: string): Uint8Array {
  const parsed = parsePresetDump(dumpBytes);
  const { rawPatch } = decodeRawPatch(parsed.chunkPayloads);
  const out = rawPatch.slice();
  const bytes = new TextEncoder().encode(newName).subarray(0, 31);
  out.fill(0, 0x08, 0x28);
  out.set(bytes, 0x08);
  return serializePresetDump(reframeRawPatch(parsed, writeCrc(out)));
}

// ── block-type swap ─────────────────────────────────────────────────────

export interface BlockTypeOption {
  id: number;
  name: string;
}

/** All named effect-types for a block family (e.g. "Amp", "Reverb", "Drive"). */
export function listBlockTypes(blockName: string): BlockTypeOption[] {
  const map = TYPE_BINARY_IDS[blockName] ?? {};
  return Object.entries(map)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.id - b.id);
}

/** Resolve a type query (exact name, else unique substring) to its ordinal. */
function resolveTypeId(blockName: string, query: string): BlockTypeOption {
  const options = listBlockTypes(blockName);
  if (options.length === 0) {
    throw new Error(`No type roster for block "${blockName}"`);
  }
  const q = query.trim().toLowerCase();
  const exact = options.find((o) => o.name.toLowerCase() === q);
  if (exact) return exact;
  const subs = options.filter((o) => o.name.toLowerCase().includes(q));
  if (subs.length === 1) return subs[0];
  if (subs.length === 0) {
    throw new Error(`No ${blockName} type matching "${query}" (${options.length} available)`);
  }
  const list = subs.slice(0, 12).map((o) => `  ${o.id}: ${o.name}`).join('\n');
  throw new Error(`Ambiguous ${blockName} type "${query}". Matches:\n${list}`);
}

export interface SwapResult {
  /** The re-encoded device-valid `.syx` bytes. */
  syx: Uint8Array;
  /** Canonical name of the type that was set. */
  resolvedType: string;
  /** Ordinal written to the body (== the live-wire SET ordinal). */
  typeId: number;
  channel: string;
  modelId: number;
}

/**
 * Swap one block's effect type in an exported `.syx` and return a new
 * device-valid `.syx`. `blockName` is a decoded block family ("Amp", "Reverb",
 * "Drive", "Delay", "Chorus", "Comp", "Filter", "Flanger", "Phaser", "Wah",
 * "Tremolo"). `typeQuery` is an exact type name or a unique substring. For
 * per-channel blocks pass `channel` (A/B/C/D); for shared-type blocks it is
 * ignored. The first matching block in the chain is edited.
 *
 * Because the new type id is poked at the exact offset our decoder reads, the
 * returned `.syx` re-decodes to the requested type with a valid CRC.
 */
export function swapBlockType(
  dumpBytes: Uint8Array,
  blockName: string,
  typeQuery: string,
  channel = 'A',
): SwapResult {
  const parsed = parsePresetDump(dumpBytes);
  const { rawPatch, body } = decodeRawPatch(parsed.chunkPayloads);
  const profile = getProfile(parsed.modelId);
  const decoded = decodeGen3Body(body, parsed.modelId);

  const target = (decoded.blocks ?? []).find((b: Gen3Block) => b.block === blockName);
  if (!target) {
    const present = (decoded.blocks ?? []).map((b) => b.block).join(', ') || '(none)';
    throw new Error(`No "${blockName}" block in this preset. Present blocks: ${present}`);
  }

  const option = resolveTypeId(blockName, typeQuery);
  const offset = typeFieldByteOffset(target, channel, profile);

  const newBody = body.slice();
  newBody[offset] = option.id & 0xff;
  newBody[offset + 1] = (option.id >> 8) & 0xff;

  const newRaw = reencodeRawPatch(rawPatch, newBody);
  const syx = serializePresetDump(reframeRawPatch(parsed, newRaw));
  return { syx, resolvedType: option.name, typeId: option.id, channel, modelId: parsed.modelId };
}
