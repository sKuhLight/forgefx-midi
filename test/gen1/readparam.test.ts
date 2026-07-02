/**
 * Axe-Fx Standard / Ultra (gen-1) READ-path codec goldens.
 *
 * Source: the gen-1 wiki "Axe-Fx System Exclusive Message Spec"
 * (docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.wikitext.txt). The query message is
 * the set message with value 0 and the trailing flag set to query(0); the
 * MIDI_PARAM_VALUE response echoes the block/param ids, carries the live value
 * (0..254) and the device's own null-terminated label.
 *
 * These lock the wire shape. The transport round-trip (does the hardware answer
 * a query) is community-beta and unverified — the project owns no gen-1 unit.
 */
import {
  buildGetParam,
  parseParamValue,
  isParamValueResponse,
  buildSetParam,
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

interface QueryCase {
  label: string;
  built: number[];
  expected: number[];
}

// Query goldens. block 106 = 0x6A -> 0A 06; block 101 = 0x65 -> 05 06.
// value bytes are 00 00 (irrelevant for a query); trailing flag is 00 (query).
const QUERY_CASES: QueryCase[] = [
  {
    label: 'Amp 1 Drive query',
    built: buildGetParam(106, 1),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x0a, 0x06, 0x01, 0x00, 0x00, 0x00, 0x00, 0xf7],
  },
  {
    label: 'Compressor 2 Knee query',
    built: buildGetParam(101, 5),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x05, 0x06, 0x05, 0x00, 0x00, 0x00, 0x00, 0xf7],
  },
];

export const AXEFXGEN1_READ_CASE_COUNT = QUERY_CASES.length;

export function runAxeFxGen1ReadParamTests(): void {
  // 1. Query builder byte-exact goldens.
  for (const c of QUERY_CASES) {
    if (!eqBytes(c.built, c.expected)) {
      throw new Error(`gen-1 query golden "${c.label}":\n  built    ${hex(c.built)}\n  expected ${hex(c.expected)}`);
    }
    assert(c.built.length === 14, `gen-1 query must be 14 bytes, got ${c.built.length} for ${c.label}`);
    assert(c.built[12] === 0x00, `gen-1 query flag byte must be 0 (query) for ${c.label}`);
  }

  // 2. The query differs from the SET of the same param ONLY in the flag byte
  //    (set emits 1). Proves the set/query selector interpretation.
  const setBytes = buildSetParam(106, 1, 0);
  const getBytes = buildGetParam(106, 1);
  assert(setBytes.length === getBytes.length, 'set/query length mismatch');
  assert(setBytes[12] === 0x01 && getBytes[12] === 0x00, 'set flag must be 1, query flag must be 0');
  for (let i = 0; i < setBytes.length; i++) {
    if (i === 12) continue;
    assert(setBytes[i] === getBytes[i], `set vs query differ at byte ${i} (only the flag should differ)`);
  }

  // 3. parseParamValue on a constructed MIDI_PARAM_VALUE response:
  //    Amp 1 Drive (block 106, param 1) = 200 (0xC8 -> 08 0C), label "5.00".
  const resp = [
    0xf0, 0x00, 0x01, 0x74, 0x01, 0x02,
    0x0a, 0x06, // block 106
    0x01, 0x00, // param 1
    0x08, 0x0c, // value 200
    0x35, 0x2e, 0x30, 0x30, // "5.00"
    0x00, // null terminator
    0xf7,
  ];
  const parsed = parseParamValue(resp);
  assert(!!parsed, 'parseParamValue returned undefined for a valid response');
  assert(parsed!.blockId === 106, `parsed blockId expected 106, got ${parsed!.blockId}`);
  assert(parsed!.paramId === 1, `parsed paramId expected 1, got ${parsed!.paramId}`);
  assert(parsed!.value === 200, `parsed value expected 200, got ${parsed!.value}`);
  assert(parsed!.label === '5.00', `parsed label expected "5.00", got "${parsed!.label}"`);

  // 4. isParamValueResponse matches the response to its query and rejects
  //    a response for a DIFFERENT param.
  assert(isParamValueResponse(getBytes, resp), 'isParamValueResponse should match its own query');
  const otherQuery = buildGetParam(106, 2); // different param id
  assert(!isParamValueResponse(otherQuery, resp), 'isParamValueResponse must reject a mismatched param');

  // 5. A query echoed verbatim (loopback) is NOT a response.
  assert(!isParamValueResponse(getBytes, getBytes), 'a verbatim query echo must not count as a response');

  // 6. Malformed frames are rejected: wrong manufacturer id, wrong function
  //    byte, and too-short frames. (The model byte is deliberately NOT validated
  //    — it is configurable on the hardware, so we capture it rather than gate.)
  assert(!parseParamValue([0xf0, 0x00, 0x00, 0x7d, 0x01, 0x02, 0x0a, 0x06, 0x01, 0x00, 0x08, 0x0c, 0x00, 0xf7]),
    'parseParamValue must reject a non-(00 01 74) manufacturer id');
  assert(!parseParamValue([0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x00, 0x00, 0x00, 0xf7]),
    'parseParamValue must reject a non-0x02 function');
  assert(!parseParamValue([0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x0a, 0x06, 0xf7]),
    'parseParamValue must reject a too-short frame');
}
