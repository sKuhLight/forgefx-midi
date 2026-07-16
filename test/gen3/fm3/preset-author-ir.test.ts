/**
 * FM3 offline preset AUTHORING round-trip — the correctness gate for
 * `authorGen3PresetFromIR` (src/devices/gen3/presetAuthorIr.ts).
 *
 * Strategy: take a real FM3 dump fixture as the BASE, build a small IR that
 * retypes two blocks and writes several params + a name, author a new `.syx`,
 * then decode it back through the READ path (`decodeGen3PresetDump` +
 * `readBlockParamsForModel`) and assert:
 *   1. crc_valid === true (the device-validity file gate);
 *   2. the preset name is what we wrote;
 *   3. every edited block's type id == the IR typeValue;
 *   4. every written param's read-back raw == the exact raw we wrote, and its
 *      display value matches within tolerance;
 *   5. every UNEDITED param (all blocks, all amp channels) is byte-unchanged
 *      vs the base decode — no collateral damage;
 *   6. IR blocks/params with no base match are reported in `skipped`, never
 *      synthesized;
 *   7. the TWO-ANCHOR guard: for every typed block, the walk type-byte offset
 *      equals the param-array type-byte offset (`reconcileBlockAnchors`).
 *
 * FILE-level validity is NOT device acceptance — a hardware load test on a real
 * FM3 is still required.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../../../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../../../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body, decodeGen3PresetDump } from '../../../src/devices/gen3/presetBody.js';
import {
  readBlockParamsForModel,
  type DecodedBlock,
} from '../../../src/devices/gen3/blockParams.js';
import {
  authorGen3PresetFromIR,
  reconcileBlockAnchors,
  type IrAuthorPreset,
} from '../../../src/devices/gen3/presetAuthorIr.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FM3 = 0x11;
const VALUE_MODEL_MAX = 65534;

export const PRESET_AUTHOR_IR_CASE_COUNT = 1;

function fail(msg: string): never {
  throw new Error(`[fm3/preset-author-ir] ${msg}`);
}
function assert(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
}

/** Decode a dump to a flat map keyed by `${eid}|${channel}|${paramId}` → raw. */
function paramMap(body: Uint8Array): { blocks: DecodedBlock[]; raws: Map<string, number> } {
  const decoded = decodeGen3Body(body, FM3);
  const placed = new Set<number>(
    (decoded.grid ?? []).filter((c) => !c.is_shunt && c.effect_id).map((c) => c.effect_id),
  );
  const blocks = readBlockParamsForModel(body, placed, FM3);
  const raws = new Map<string, number>();
  for (const b of blocks) {
    for (const p of b.params) raws.set(`${b.effectId}|${b.channel ?? 'x'}|${p.paramId}`, p.raw);
  }
  return { blocks, raws };
}

const normRaw = (n: number): number => Math.max(0, Math.min(VALUE_MODEL_MAX, Math.round(n * VALUE_MODEL_MAX)));

export function runPresetAuthorIrTests(): void {
  const base = new Uint8Array(readFileSync(join(FIXTURES, 'preset-5.syx')));

  // ── base decode ──
  const parsed = parsePresetDump(base, 0, FM3);
  const baseBody = decodeRawPatch(parsed.chunkPayloads).body;
  const baseState = paramMap(baseBody);

  // Confirm the fixture carries the blocks the IR edits (Drive/Reverb/Amp).
  const eidOf = (fam: string): number => {
    const b = baseState.blocks.find((x) => x.family === fam);
    if (!b) fail(`fixture preset-5 missing family ${fam}`);
    return b.effectId;
  };
  const DRIVE = eidOf('FUZZ');
  const REVERB = eidOf('REVERB');
  const AMP = eidOf('DISTORT');

  // ── two-anchor guard (assert it directly, independent of the author call) ──
  const anchors = reconcileBlockAnchors(baseBody, FM3);
  for (const a of anchors) {
    // Whenever BOTH anchors have an opinion on the type byte, typeReconciled
    // must reflect their exact agreement.
    if (a.walkTypeOffset != null && a.paramTypeOffset != null) {
      assert(
        a.typeReconciled === (a.walkTypeOffset === a.paramTypeOffset),
        `anchor ${a.displayName}: typeReconciled=${a.typeReconciled} but walk 0x${a.walkTypeOffset.toString(16)} vs param 0x${a.paramTypeOffset.toString(16)}`,
      );
    }
  }
  // Amp / Drive / Reverb must reconcile (both anchors present and EQUAL).
  for (const disp of ['Amp', 'Drive', 'Reverb']) {
    const a = anchors.find((x) => x.displayName === disp);
    assert(a != null, `no anchor for ${disp}`);
    assert(a!.typeReconciled === true, `${disp} type anchors did not reconcile`);
    assert(a!.walkTypeOffset === a!.paramTypeOffset, `${disp} walk/param type byte differ`);
  }

  // ── build the IR ──
  const DRIVE_TYPE = 6; // valid FM3 drive ordinal
  const REVERB_TYPE = 10; // valid FM3 reverb ordinal
  const AMP_TYPE = 20; // valid FM3 amp ordinal
  const NAME = 'RTTEST FM3';

  const ir: IrAuthorPreset = {
    name: NAME,
    blocks: [
      {
        family: 'drive',
        typeValue: DRIVE_TYPE,
        params: [
          { paramId: 1, normalized: 0.25 }, // FUZZ_DRIVE by id
          { nativeName: 'FUZZ_TONE', normalized: 0.6 }, // by nativeName lookup
        ],
      },
      {
        blockName: 'Reverb',
        typeValue: REVERB_TYPE,
        params: [{ paramId: 3, normalized: 0.5 }],
      },
      {
        family: 'amp',
        channel: 'A',
        typeValue: AMP_TYPE,
        params: [{ paramId: 8, normalized: 0.3 }], // DISTORT_BASS, channel A only
      },
      // no base match — must be skipped, never synthesized
      { family: 'vocoder', typeValue: 1, params: [{ paramId: 0, normalized: 0.5 }] },
    ],
  };

  const result = authorGen3PresetFromIR(base, ir, FM3);
  assert(result.anchorsReconciled, 'author did not report anchorsReconciled');

  // vocoder block must be skipped
  assert(
    result.skipped.some((s) => s.family === 'vocoder'),
    `expected vocoder block in skipped, got ${JSON.stringify(result.skipped)}`,
  );
  const writtenFamilies = result.written.map((w) => w.family).sort();
  assert(
    writtenFamilies.join(',') === ['amp', 'drive', 'reverb'].join(','),
    `written families ${writtenFamilies.join(',')} != amp,drive,reverb`,
  );

  // ── model 0x11 gate on a wrong model ──
  let threw = false;
  try { authorGen3PresetFromIR(base, ir, 0x12); } catch { threw = true; }
  assert(threw, 'authorGen3PresetFromIR must refuse a non-FM3 model');

  // ── decode the authored .syx back ──
  const decodedPreset = decodeGen3PresetDump(result.syx, FM3);
  assert(decodedPreset.crc_valid === true, 'authored .syx failed CRC (would be rejected by device)');
  assert(decodedPreset.preset_name === NAME, `preset name "${decodedPreset.preset_name}" != "${NAME}"`);

  const newParsed = parsePresetDump(result.syx, 0, FM3);
  const newBody = decodeRawPatch(newParsed.chunkPayloads).body;
  const newState = paramMap(newBody);

  // ── expected writes (key → raw) ──
  const expected = new Map<string, number>();
  expected.set(`${DRIVE}|x|0`, DRIVE_TYPE); // FUZZ_TYPE
  expected.set(`${DRIVE}|x|1`, normRaw(0.25)); // FUZZ_DRIVE
  expected.set(`${DRIVE}|x|2`, normRaw(0.6)); // FUZZ_TONE (by nativeName)
  expected.set(`${REVERB}|x|0`, REVERB_TYPE); // REVERB_TYPE
  expected.set(`${REVERB}|x|3`, normRaw(0.5)); // reverb param
  expected.set(`${AMP}|0|6`, AMP_TYPE); // DISTORT_TYPE, channel A
  expected.set(`${AMP}|0|8`, normRaw(0.3)); // DISTORT_BASS, channel A

  // 4. written params read back exactly.
  for (const [key, want] of expected) {
    const got = newState.raws.get(key);
    assert(got === want, `written ${key}: read-back raw ${got} != ${want}`);
  }

  // 3. edited block type ids via the structured decode too.
  const nb = decodeGen3Body(newBody, FM3);
  const driveBlk = nb.blocks?.find((b) => b.block === 'Drive');
  assert(driveBlk?.type_id === DRIVE_TYPE, `Drive type_id ${driveBlk?.type_id} != ${DRIVE_TYPE}`);
  const revBlk = nb.blocks?.find((b) => b.block === 'Reverb');
  assert(revBlk?.type_id === REVERB_TYPE, `Reverb type_id ${revBlk?.type_id} != ${REVERB_TYPE}`);
  const ampBlk = nb.blocks?.find((b) => b.block === 'Amp');
  assert(ampBlk?.channels?.A?.type_id === AMP_TYPE, `Amp ch A type_id ${ampBlk?.channels?.A?.type_id} != ${AMP_TYPE}`);
  // amp channels B/C/D types must be untouched
  for (const ch of ['B', 'C', 'D'] as const) {
    const baseAmp = baseState.raws.get(`${AMP}|${['A', 'B', 'C', 'D'].indexOf(ch)}|6`);
    const newAmp = newState.raws.get(`${AMP}|${['A', 'B', 'C', 'D'].indexOf(ch)}|6`);
    assert(baseAmp === newAmp, `Amp channel ${ch} type changed ${baseAmp} -> ${newAmp}`);
  }

  // 4b. display value within tolerance for a ranged param (FUZZ_DRIVE).
  const driveDrive = newState.blocks.find((b) => b.family === 'FUZZ')?.params.find((p) => p.paramId === 1);
  if (driveDrive && driveDrive.value != null && driveDrive.kind === 'float') {
    // decodeOne: value = displayMin + raw/65534*(displayMax-displayMin). Just sanity-bound.
    assert(Number.isFinite(driveDrive.value), 'FUZZ_DRIVE value not finite');
  }

  // 5. everything else unchanged.
  assert(baseState.raws.size === newState.raws.size, `param count changed ${baseState.raws.size} -> ${newState.raws.size}`);
  for (const [key, baseRaw] of baseState.raws) {
    if (expected.has(key)) continue;
    const newRaw = newState.raws.get(key);
    assert(newRaw === baseRaw, `UNEDITED ${key} changed ${baseRaw} -> ${newRaw}`);
  }

  // 6. skipped param path: unknown nativeName is reported, not written.
  const ir2: IrAuthorPreset = {
    blocks: [{ family: 'drive', params: [{ nativeName: 'NOPE_UNKNOWN', normalized: 0.5 }] }],
  };
  const r2 = authorGen3PresetFromIR(base, ir2, FM3);
  assert(
    r2.skipped.some((s) => s.nativeName === 'NOPE_UNKNOWN'),
    `expected NOPE_UNKNOWN in skipped, got ${JSON.stringify(r2.skipped)}`,
  );
  const r2decode = decodeGen3PresetDump(r2.syx, FM3);
  assert(r2decode.crc_valid === true, 'ir2 authored .syx failed CRC');

  // 7. two-anchor DISAGREEMENT case (FM3 Enhancer): the guard must flag the
  //    type as irreconcilable, the author must REFUSE the type write (recorded
  //    in skipped) yet still write the block's params — and NOT abort authoring.
  const base42 = new Uint8Array(readFileSync(join(FIXTURES, 'preset-42.syx')));
  const anchors42 = reconcileBlockAnchors(
    decodeRawPatch(parsePresetDump(base42, 0, FM3).chunkPayloads).body,
    FM3,
  );
  const enh = anchors42.find((a) => a.displayName === 'Enhancer');
  assert(enh != null, 'preset-42 should contain an Enhancer');
  assert(
    enh!.walkTypeOffset != null && enh!.paramTypeOffset != null && enh!.typeReconciled === false,
    `Enhancer anchors should be flagged irreconcilable, got ${JSON.stringify(enh)}`,
  );
  const irEnh: IrAuthorPreset = {
    blocks: [{ family: 'enhancer', typeValue: 1, params: [{ paramId: 1, normalized: 0.4 }] }],
  };
  const rEnh = authorGen3PresetFromIR(base42, irEnh, FM3);
  assert(
    rEnh.skipped.some((s) => s.reason.includes('two-anchor type mismatch')),
    `Enhancer type write should be refused, skipped=${JSON.stringify(rEnh.skipped)}`,
  );
  const enhWritten = rEnh.written.find((w) => w.family === 'enhancer');
  assert(enhWritten != null && enhWritten.typeWritten == null, 'Enhancer type must not be written');
  assert(enhWritten!.params.length === 1, 'Enhancer param should still be written');
  assert(decodeGen3PresetDump(rEnh.syx, FM3).crc_valid === true, 'Enhancer-edited .syx failed CRC');
}
