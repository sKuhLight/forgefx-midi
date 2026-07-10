/**
 * Axe-Fx Standard / Ultra (gen-1) whole-patch DUMP (get_preset) codec goldens.
 *
 * Source: the gen-1 wiki "Axe-Fx System Exclusive Message Spec", sections
 * ===MIDI_GET_PATCH=== (fn 0x03 request) and ===MIDI_PATCH_DUMP=== (fn 0x04
 * dump). These lock the spec-pinned subset: the request frames, the dump's
 * source flag, its nibble-pair name, and its 4x12 effect grid.
 *
 * The transport round-trip (does the hardware answer a get_patch) is
 * community-beta and unverified — the project owns no gen-1 unit.
 */
import {
  buildGetPatchDump,
  parsePatchDump,
  isPatchDumpResponse,
  nibbleSplit,
  GEN1_GRID_ROWS,
  GEN1_GRID_COLS,
  GEN1_PATCH_DUMP_MIN_LENGTH,
} from '../../src/gen1/index.js';

function eqBytes(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function hex(bs: readonly number[]): string {
  return Array.from(bs, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Dump byte-layout constants (mirror patchDump.ts; kept local so the test pins
// the wire offsets independently of the implementation).
const NAME_OFFSET = 13;
const GRID_OFFSET = 77;
const GRID_CELL_BYTES = 4;

/**
 * Build a synthetic, spec-shaped gen-1 MIDI_PATCH_DUMP frame for the parser.
 *   - Fractal envelope, model 0x01, fn 0x04.
 *   - source flag at byte 6.
 *   - `name` written at offset 13 as ls/ms nibble pairs, NUL-terminated.
 *   - `cells` (index -> effectId) written into the 4x12 grid; each cell also
 *     gets 2 raw state bytes = [0x11, 0x22] so stateRaw is exercised.
 *   - total length `total` (>= min); the tail after the grid is the param
 *     region (zero-filled) so paramBlockBytes = total - 1 - 269.
 */
function buildSyntheticDump(opts: {
  sourceFlag: number;
  name: string;
  cells: ReadonlyArray<{ index: number; effectId: number }>;
  total: number;
}): number[] {
  const { sourceFlag, name, cells, total } = opts;
  const bytes = new Array<number>(total).fill(0x00);
  bytes[0] = 0xf0;
  bytes[1] = 0x00;
  bytes[2] = 0x01;
  bytes[3] = 0x74;
  bytes[4] = 0x01; // model
  bytes[5] = 0x04; // fn = MIDI_PATCH_DUMP
  bytes[6] = sourceFlag;
  // Name as ls/ms nibble pairs, then a NUL pair (already zero-filled).
  for (let i = 0; i < name.length; i++) {
    const [lo, hi] = nibbleSplit(name.charCodeAt(i));
    bytes[NAME_OFFSET + 2 * i] = lo;
    bytes[NAME_OFFSET + 2 * i + 1] = hi;
  }
  // Grid cells.
  for (const { index, effectId } of cells) {
    const at = GRID_OFFSET + index * GRID_CELL_BYTES;
    const [lo, hi] = nibbleSplit(effectId);
    bytes[at] = lo;
    bytes[at + 1] = hi;
    bytes[at + 2] = 0x11;
    bytes[at + 3] = 0x22;
  }
  bytes[total - 1] = 0xf7;
  return bytes;
}

export const GEN1_PATCHDUMP_CASE_COUNT = 4;

export function runAxeFxGen1PatchDumpTests(): void {
  // (a) Edit-buffer GET request is byte-exact to the spec's example frame.
  {
    const req = buildGetPatchDump();
    const expected = [0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x01, 0x00, 0x00, 0xf7];
    if (!eqBytes(req, expected)) {
      throw new Error(`gen-1 edit-buffer GET request:\n  built    ${hex(req)}\n  expected ${hex(expected)}`);
    }
  }

  // (b) Stored request encodes ls = preset & 0x0f, ms = preset >> 4; bank-C
  //     (>= 256) throws.
  {
    const req = buildGetPatchDump(200); // 200 -> ls = 8, ms = 12 (0x0c)
    const expected = [0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x00, 0x08, 0x0c, 0xf7];
    if (!eqBytes(req, expected)) {
      throw new Error(`gen-1 stored GET request (preset 200):\n  built    ${hex(req)}\n  expected ${hex(expected)}`);
    }
    // Worked spec examples: A000 -> 00 00, A127 -> 0F 07, B128 -> 00 08, B255 -> 0F 0F.
    assert(eqBytes(buildGetPatchDump(0).slice(7, 9), [0x00, 0x00]), 'preset 0 must encode 00 00');
    assert(eqBytes(buildGetPatchDump(127).slice(7, 9), [0x0f, 0x07]), 'preset 127 must encode 0F 07');
    assert(eqBytes(buildGetPatchDump(128).slice(7, 9), [0x00, 0x08]), 'preset 128 must encode 00 08');
    assert(eqBytes(buildGetPatchDump(255).slice(7, 9), [0x0f, 0x0f]), 'preset 255 must encode 0F 0F');

    let threw = false;
    try { buildGetPatchDump(256); } catch { threw = true; }
    assert(threw, 'buildGetPatchDump must refuse bank-C preset 256 (OR-value undetermined in the spec)');
    let threwNeg = false;
    try { buildGetPatchDump(-1); } catch { threwNeg = true; }
    assert(threwNeg, 'buildGetPatchDump must reject a negative preset');
  }

  // (c) Parse a synthetic dump: correct fn 0x04, edit-buffer source flag, a name
  //     in ls/ms nibble pairs at offset 13, two grid cells with known effect ids
  //     (Amp 1 = 106, Delay 1 = 112), length > 270.
  {
    const total = 300;
    const dump = buildSyntheticDump({
      sourceFlag: 0x01,
      name: 'TEST',
      cells: [
        { index: 0, effectId: 106 }, // Amp 1
        { index: 5, effectId: 112 }, // Delay 1
      ],
      total,
    });
    assert(dump.length >= GEN1_PATCH_DUMP_MIN_LENGTH, 'synthetic dump must satisfy the minimum length');

    const parsed = parsePatchDump(dump);
    assert(parsed.model === 0x01, `parsed model expected 0x01, got ${parsed.model}`);
    assert(parsed.source === 'edit-buffer', `parsed source expected edit-buffer, got ${parsed.source}`);
    assert(parsed.name === 'TEST', `parsed name expected "TEST", got "${parsed.name}"`);
    assert(parsed.cells.length === GEN1_GRID_ROWS * GEN1_GRID_COLS, `expected 48 cells, got ${parsed.cells.length}`);

    const amp = parsed.cells[0];
    assert(amp.effectId === 106, `cell 0 effectId expected 106, got ${amp.effectId}`);
    assert(amp.blockName === 'Amp 1', `cell 0 blockName expected "Amp 1", got "${amp.blockName}"`);
    assert(amp.row === 0 && amp.col === 0, `cell 0 row/col expected (0,0), got (${amp.row},${amp.col})`);
    assert(eqBytes(amp.stateRaw, [0x11, 0x22]), `cell 0 stateRaw expected [11,22], got ${hex(amp.stateRaw)}`);

    const delay = parsed.cells[5];
    assert(delay.effectId === 112, `cell 5 effectId expected 112, got ${delay.effectId}`);
    assert(delay.blockName === 'Delay 1', `cell 5 blockName expected "Delay 1", got "${delay.blockName}"`);
    // Provisional column-major derivation: index 5 -> row 1, col 1.
    assert(delay.row === 1 && delay.col === 1, `cell 5 row/col expected (1,1), got (${delay.row},${delay.col})`);

    // An empty cell decodes to effectId 0 with no resolved name.
    const empty = parsed.cells[1];
    assert(empty.effectId === 0, `empty cell effectId expected 0, got ${empty.effectId}`);
    assert(empty.blockName === undefined, 'empty cell must have no blockName');

    // Param region is a byte count only: total - 1 (F7) - 269 (region offset).
    assert(parsed.paramBlockBytes === total - 1 - 269, `paramBlockBytes expected ${total - 1 - 269}, got ${parsed.paramBlockBytes}`);
    assert(parsed.totalLength === total, `totalLength expected ${total}, got ${parsed.totalLength}`);

    // A stored-source dump flips the source field.
    const storedDump = buildSyntheticDump({ sourceFlag: 0x00, name: 'AB', cells: [], total: GEN1_PATCH_DUMP_MIN_LENGTH });
    const storedParsed = parsePatchDump(storedDump);
    assert(storedParsed.source === 'stored', `stored dump source expected stored, got ${storedParsed.source}`);
    assert(storedParsed.name === 'AB', `stored dump name expected "AB", got "${storedParsed.name}"`);
    assert(storedParsed.paramBlockBytes === 0, `min-length dump paramBlockBytes expected 0, got ${storedParsed.paramBlockBytes}`);

    // A too-short frame is rejected with a diagnostic.
    let threwShort = false;
    try { parsePatchDump(storedDump.slice(0, GEN1_PATCH_DUMP_MIN_LENGTH - 1)); } catch { threwShort = true; }
    assert(threwShort, 'parsePatchDump must reject a frame shorter than the pinned regions');
  }

  // (d) Response matcher accepts a valid dump and rejects a non-0x04 frame.
  {
    const editReq = buildGetPatchDump();
    const editDump = buildSyntheticDump({ sourceFlag: 0x01, name: 'X', cells: [], total: GEN1_PATCH_DUMP_MIN_LENGTH });
    assert(isPatchDumpResponse(editReq, editDump), 'matcher should accept an edit-buffer dump for an edit-buffer request');

    const storedReq = buildGetPatchDump(10);
    const storedDump = buildSyntheticDump({ sourceFlag: 0x00, name: 'X', cells: [], total: GEN1_PATCH_DUMP_MIN_LENGTH });
    assert(isPatchDumpResponse(storedReq, storedDump), 'matcher should accept a stored dump for a stored request');

    // Reply flag must match the request form: an edit-buffer dump is not the
    // reply to a stored request (and vice versa).
    assert(!isPatchDumpResponse(storedReq, editDump), 'matcher must reject an edit-buffer dump for a stored request');
    assert(!isPatchDumpResponse(editReq, storedDump), 'matcher must reject a stored dump for an edit-buffer request');

    // A non-0x04 frame (here: an fn 0x03 request echoed back) is rejected.
    assert(!isPatchDumpResponse(editReq, editReq), 'matcher must reject a non-0x04 frame');
    // A fn 0x02 param-value-shaped frame is rejected too.
    const notDump = [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x0a, 0x06, 0x01, 0x00, 0x08, 0x0c, 0x00, 0xf7];
    assert(!isPatchDumpResponse(editReq, notDump), 'matcher must reject a fn 0x02 frame');
  }
}
