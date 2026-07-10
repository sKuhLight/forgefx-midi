/**
 * AM4 preset CONTAINER + body decode goldens.
 *
 * There is NO real AM4 preset `.syx` in `test/fixtures/`, so these cases run
 * against a SYNTHETIC raw_patch built here with the same shared gen-3
 * primitives the decoder reuses (`encode16to3` + `huffmanCompress` +
 * `computeRawPatchCrc` + `computeRawPatchXor`). The synthetic patch is
 * documented inline; it is NOT a device capture and encodes only the fields
 * these assertions exercise (fw/magic words, preset name, four scene names,
 * one amp block at the "most presets" base 0x0934 with a known gain).
 *
 * What it proves (all reproducible without hardware):
 *   - 3-to-16 chunk round-trip: decoded.rawPatch == the packed-then-unpacked
 *     raw_patch.
 *   - CRC validation passes for a correct stored CRC and fails for a wrong one.
 *   - Footer-XOR validation passes for the correct septet-packed footer.
 *   - Preset name + 4 scene names decode from the documented offsets.
 *   - The bodyChain amp-param formula resolves amp.gain chA at the documented
 *     anchor 0x0958 to 5.1 (0x828E = round(5.1/10*65534)).
 *   - The AMP_TYPES ordinal bound is OUR roster length (250), so a preset
 *     whose amp type is ordinal 249 still validates (a hardcoded 248 rejects).
 *
 * What it does NOT prove: byte-identity against a genuine device dump (no
 * capture on disk) — that stays a hardware-verification follow-up.
 */

import {
  encode16to3,
  huffmanCompress,
  computeRawPatchCrc,
  computeRawPatchXor,
  RAW_PATCH_CRC_OFFSET,
  RAW_PATCH_DECOMP_SIZE_OFFSET,
  RAW_PATCH_COMP_SIZE_OFFSET,
  RAW_PATCH_BODY_OFFSET,
} from '../../src/devices/gen3/presetHuffman.js';
import {
  parsePresetDump,
  serializePresetDump,
  decodeAm4PresetDump,
  decodeAm4PresetDumpBytes,
  type ParsedPresetDump,
} from '../../src/devices/am4/presetDump.js';
import {
  AM4_RAW_PATCH_SIZE,
  AM4_RAW_PATCH_NAME_OFFSET,
  AM4_RAW_PATCH_MAGIC,
  AM4_FW_WORD_1P01,
  AM4_CHUNK_DISCRIMINATOR,
  AM4_BODY_SCENE_NAME_OFFSET,
  AM4_BODY_SCENE_RECORD_STRIDE,
  AM4_BODY_AMP_GAIN_CHA_OFFSET,
} from '../../src/devices/am4/presetContainer.js';
import {
  locateAm4AmpBlock,
  AM4_BODY_CHANNEL_STRIDE,
  AM4_BODY_BLOCK_HEADER_BYTES,
} from '../../src/devices/am4/presetBody.js';
import { BLOCK_TYPE_VALUES } from '../../src/am4/blockTypes.js';

const AMP_MARKER = BLOCK_TYPE_VALUES.amp; // 0x003a
const AMP_TYPE_PID_HIGH = 0x0a;
const AMP_GAIN_PID_HIGH = 0x0b;
const AMP_BASE = 0x0934; // "most presets" config base
const DECOMP_SIZE = 0x1500; // covers the amp block + the volatile-word region
const GAIN_WIRE = 0x828e; // round(5.1 / 10 * 65534)

const PRESET_NAME = 'TEST PRESET';
const SCENE_NAMES = ['SCENE ONE', 'SCENE TWO', 'SCENE THREE', 'SCENE FOUR'];

function writeAscii(buf: Uint8Array, off: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[off + i] = text.charCodeAt(i);
  buf[off + text.length] = 0; // NUL terminator
}

function writeU16le(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}

/** Build a synthetic decompressed body with scene names + one amp block. */
function buildBody(chATypeOrdinal: number): Uint8Array {
  const body = new Uint8Array(DECOMP_SIZE);
  // Scene names.
  for (let n = 0; n < SCENE_NAMES.length; n++) {
    writeAscii(body, AM4_BODY_SCENE_NAME_OFFSET + n * AM4_BODY_SCENE_RECORD_STRIDE, SCENE_NAMES[n]);
  }
  // Amp block: marker at AMP_BASE, zero header, per-channel type ordinals.
  writeU16le(body, AMP_BASE, AMP_MARKER);
  const typeRel = AM4_BODY_BLOCK_HEADER_BYTES + AMP_TYPE_PID_HIGH * 2; // 0x22
  const gainRel = AM4_BODY_BLOCK_HEADER_BYTES + AMP_GAIN_PID_HIGH * 2; // 0x24
  const types = [chATypeOrdinal, 10, 0, 0];
  for (let ch = 0; ch < 4; ch++) {
    const chBase = AMP_BASE + ch * AM4_BODY_CHANNEL_STRIDE;
    writeU16le(body, chBase + typeRel, types[ch]);
  }
  // amp.gain chA at the documented anchor.
  writeU16le(body, AMP_BASE + gainRel, GAIN_WIRE);
  return body;
}

/** Build an 8,192-byte raw_patch around a body; optionally corrupt the CRC. */
function buildRawPatch(body: Uint8Array, corruptCrc = false): Uint8Array {
  const raw = new Uint8Array(AM4_RAW_PATCH_SIZE);
  writeU16le(raw, 0x00, AM4_FW_WORD_1P01);
  writeU16le(raw, 0x02, AM4_RAW_PATCH_MAGIC);
  writeAscii(raw, AM4_RAW_PATCH_NAME_OFFSET, PRESET_NAME);
  const comp = huffmanCompress(body);
  writeU16le(raw, RAW_PATCH_DECOMP_SIZE_OFFSET, body.length);
  writeU16le(raw, RAW_PATCH_COMP_SIZE_OFFSET, comp.length);
  raw.set(comp, RAW_PATCH_BODY_OFFSET);
  const crc = computeRawPatchCrc(raw); // computed with [0x04:0x06] zeroed
  writeU16le(raw, RAW_PATCH_CRC_OFFSET, corruptCrc ? (crc ^ 0x1234) & 0xffff : crc);
  return raw;
}

/** Pack a raw_patch into a ParsedPresetDump (4 chunks + septet-packed footer). */
function buildParsedDump(raw: Uint8Array): ParsedPresetDump {
  const packed = encode16to3(raw); // 4096 words -> 12288 bytes
  const chunkPayloads: Uint8Array[] = [];
  const CHUNK_PACKED = 3072;
  for (let i = 0; i < 4; i++) {
    const payload = new Uint8Array(2 + CHUNK_PACKED);
    payload[0] = AM4_CHUNK_DISCRIMINATOR[0];
    payload[1] = AM4_CHUNK_DISCRIMINATOR[1];
    payload.set(packed.subarray(i * CHUNK_PACKED, (i + 1) * CHUNK_PACKED), 2);
    chunkPayloads.push(payload);
  }
  const xor = computeRawPatchXor(raw);
  const footerPayload = Uint8Array.from([xor & 0x7f, (xor >> 7) & 0x7f, (xor >> 14) & 0x7f]);
  const headerPayload = Uint8Array.from([0x7f, 0x00, 0x00, 0x00, 0x00]);
  const parsed: ParsedPresetDump = {
    raw: new Uint8Array(0),
    headerPayload,
    chunkPayloads,
    footerPayload,
  };
  // Round-trip through the real framing so `raw` is a valid 12,352-byte dump
  // and the envelope/checksum path is exercised too.
  const wire = serializePresetDump(parsed);
  return parsePresetDump(wire);
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Check {
  label: string;
  pass: () => boolean;
}

const checks: Check[] = [];

// ── Good dump (chA amp type ordinal 5) ────────────────────────────────
const goodRaw = buildRawPatch(buildBody(5));
const goodDump = buildParsedDump(goodRaw);
const decoded = decodeAm4PresetDump(goodDump);

checks.push({
  label: '3-to-16 chunk round-trip recovers the raw_patch byte-for-byte',
  pass: () => decoded.rawPatch.length === AM4_RAW_PATCH_SIZE && eq([...decoded.rawPatch], [...goodRaw]),
});
checks.push({ label: 'CRC valid on a correct stored CRC', pass: () => decoded.crcValid === true });
checks.push({ label: 'footer XOR valid on the correct septet-packed footer', pass: () => decoded.footerXorValid === true });
checks.push({ label: 'magic word 0xAA55 validates', pass: () => decoded.magicValid === true });
checks.push({ label: 'fw word decodes to 0x0107 (fw 1.01)', pass: () => decoded.fwWord === AM4_FW_WORD_1P01 });
checks.push({ label: 'huffman decompression is complete', pass: () => decoded.huffmanComplete === true && decoded.decompSize === DECOMP_SIZE });
checks.push({ label: 'preset name decodes', pass: () => decoded.presetName === PRESET_NAME && decoded.name === PRESET_NAME });
checks.push({ label: 'four scene names decode', pass: () => eq([...decoded.sceneNames], SCENE_NAMES) });
checks.push({
  label: 'amp block located at the "most presets" base 0x0934',
  pass: () => decoded.ampParams !== undefined && decoded.ampParams.base === AMP_BASE,
});
checks.push({
  label: 'amp.gain chA resolves to 5.1 at the documented anchor 0x0958',
  pass: () => {
    // Anchor arithmetic: base + header + gainPidHigh*2 == 0x0958.
    const anchor = AMP_BASE + AM4_BODY_BLOCK_HEADER_BYTES + AMP_GAIN_PID_HIGH * 2;
    return anchor === AM4_BODY_AMP_GAIN_CHA_OFFSET && decoded.ampParams?.channels.A.gain === 5.1;
  },
});
checks.push({
  label: 'amp chA type_id is the raw ordinal (5)',
  pass: () => decoded.ampParams?.channels.A.type_id === 5,
});
checks.push({
  label: 'decodeAm4PresetDumpBytes convenience path matches the parsed path',
  pass: () => eq([...decodeAm4PresetDumpBytes(goodDump.raw).rawPatch], [...decoded.rawPatch]),
});

// ── Corrupt CRC ───────────────────────────────────────────────────────
const badRaw = buildRawPatch(buildBody(5), true);
const badDecoded = decodeAm4PresetDump(buildParsedDump(badRaw));
checks.push({ label: 'CRC invalid when the stored CRC is wrong', pass: () => badDecoded.crcValid === false });

// ── AMP_TYPES bound = OUR roster (250), not the upstream hardcoded 248 ──
const ord249Raw = buildRawPatch(buildBody(249));
const ord249Body = decodeAm4PresetDump(buildParsedDump(ord249Raw));
checks.push({
  label: 'amp block with chA type ordinal 249 still validates (our 250 bound, not 248)',
  pass: () => {
    const base = locateAm4AmpBlock(ord249Body.decompressedBody, ord249Body.decompSize);
    return base === AMP_BASE && ord249Body.ampParams?.channels.A.type_id === 249;
  },
});

export function runAm4PresetContainerTests(): void {
  const failed: string[] = [];
  for (const c of checks) {
    let ok = false;
    try {
      ok = c.pass();
    } catch (e) {
      failed.push(`${c.label}\n  threw: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!ok) failed.push(c.label);
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${checks.length} AM4 preset-container case(s) failed:\n` + failed.join('\n'),
    );
  }
}

export const AM4_PRESET_CONTAINER_CASE_COUNT = checks.length;
