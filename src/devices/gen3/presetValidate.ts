/**
 * gen-3 preset coherence validator.
 *
 * A FILE-level sanity gate for gen-3 (`FM3` / `FM9` / `Axe-Fx III`) preset
 * dumps, using ONLY our own decoders — no hardware required. It exists to catch
 * the "corrupt device backup" failure mode: an edit-in-place export authored
 * onto a garbage BASE template faithfully preserves the garbage, and the result
 * decodes to nonsense blocks (repeated `Vol/Pan`, a phantom `Multiplexer`, …)
 * with a control-byte scene name. Rather than silently ship such a file, callers
 * validate the base BEFORE authoring and the output AFTER, and refuse with a
 * clear reason.
 *
 * What it proves: the bytes frame + decompress + CRC-check as a gen-3 dump, the
 * block chain decodes to a sane block count, every block that carries a type
 * selector resolves that ordinal to a KNOWN type name (an unresolved id is the
 * misread symptom), the scene names are decodable strings, and the generic
 * per-block param extraction (the second decoder the converter relies on) runs
 * without throwing. What it does NOT prove: that a real device would accept the
 * preset — a hardware load test is still the final word.
 *
 * Pure: no fs / no node imports, safe for browser-facing consumers.
 */
import {
  decodeGen3PresetDump,
  getProfile,
  type Gen3DecodedPreset,
} from './presetBody.js';
import { readBlockParamsForModel } from './blockParams.js';

export interface Gen3ValidationResult {
  /** True only when `issues` is empty. */
  ok: boolean;
  /** Human-readable coherence problems; empty ⇔ ok. */
  issues: string[];
  /** Decoded block count (0 when the dump does not decode at all). */
  blockCount: number;
  /** Resolved block/type names, in chain order (best-effort labels). */
  blockNames: string[];
}

/** Printable-ASCII gate for scene names (asciiName stops at NUL, so any
 *  surviving control byte 0x00–0x1f or high byte >0x7e is decode garbage). */
function isDecodableName(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/**
 * Validate that `bytes` is a coherent gen-3 preset dump for `modelId`
 * (0x10 Axe-Fx III / 0x11 FM3 / 0x12 FM9), decoding entirely with our own
 * codec. Never throws; a decode failure is reported as an issue.
 */
export function validateGen3Preset(bytes: Uint8Array, modelId: number): Gen3ValidationResult {
  const issues: string[] = [];

  let decoded: Gen3DecodedPreset;
  try {
    decoded = decodeGen3PresetDump(bytes, modelId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, issues: [`does not decode: ${msg}`], blockCount: 0, blockNames: [] };
  }

  const blocks = decoded.blocks ?? [];
  const blockCount = blocks.length;
  const blockNames = blocks.map((b) => b.type ?? b.block);

  // Device-validity gate: a mismatched CRC means the stored bytes are not a
  // faithful patch (the body is still decoded best-effort for the labels above).
  if (!decoded.crc_valid) issues.push('invalid CRC');

  // Block-count sanity: a coherent preset has at least one block and never more
  // than the model grid can physically hold.
  const profile = getProfile(modelId);
  const gridCapacity = profile.gridRows * profile.gridCols;
  if (blockCount <= 0) {
    issues.push('no blocks decoded (empty or unparseable body)');
  } else if (blockCount > gridCapacity) {
    issues.push(`absurd block count ${blockCount} (exceeds ${profile.name} grid capacity ${gridCapacity})`);
  }

  // Scene names must decode to printable strings, not control-byte garbage.
  const sceneNames = decoded.scene_names ?? [];
  for (let i = 0; i < sceneNames.length; i++) {
    if (!isDecodableName(sceneNames[i]!)) {
      issues.push(`scene ${i + 1} name is not a decodable string`);
    }
  }

  // The generic per-block param extraction is the SECOND decoder the converter
  // relies on. If it throws over these bytes, the body is not a coherent gen-3
  // preset for this model. And every block that carries a type selector must
  // resolve that ordinal to a KNOWN name in the model's type catalog — an
  // unresolved ordinal surfaces as the `#<n>` fallback (the garbage-misread
  // symptom, e.g. the phantom "Multiplexer"). A `null` typeName is normal for
  // families that have no type selector (Cab, Output, Rotary), NOT a problem.
  try {
    const placed = new Set((decoded.grid ?? []).map((c) => c.effect_id));
    const paramBlocks = readBlockParamsForModel(decoded.decompressed_body, placed, modelId);
    for (const b of paramBlocks) {
      if (b.typeName != null && /^#\d+$/.test(b.typeName)) {
        issues.push(`block "${b.family}" has unresolved type ${b.typeName}`);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    issues.push(`block params do not decode: ${msg}`);
  }

  return { ok: issues.length === 0, issues, blockCount, blockNames };
}
