/**
 * `createSysExAssembler` inbound-fragment contract.
 *
 * The assembler's docstring promises: one F0..F7 message per `dispatch`, a message split across
 * fragments is glued back together, and "a fragment with F7 mid-buffer (rare on WinMM but legal MIDI)
 * is split at the F7: prefix is emitted as the completed message, trailing bytes open a new
 * accumulation if they start with F0". Downstream parsers (presetDump assertDumpMessageShape,
 * receiveSysExMatching, every device's response parser) all rely on that one-message-per-emit
 * invariant, so a coalesced buffer MUST NOT be handed over as a single glued blob.
 *
 * Pure function, no MIDI port needed.
 */
import { createSysExAssembler } from '../../src/core/midi/pure.js';

export const SYSEX_ASSEMBLER_CASE_COUNT = 6;

const MSG_A = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x0c, 0x03, 0x00, 0xf7];
const MSG_B = [0xf0, 0x00, 0x01, 0x74, 0x11, 0x76, 0x00, 0xf7];
const SHORT = [0x90, 0x40, 0x7f]; // Note On — a legal non-SysEx MIDI message

function feed(fragments: number[][]): number[][] {
  const out: number[][] = [];
  const assemble = createSysExAssembler((bytes) => out.push(bytes));
  for (const f of fragments) assemble(f);
  return out;
}

function eq(actual: number[], expected: number[], label: string): void {
  if (actual.length !== expected.length || actual.some((b, i) => b !== expected[i])) {
    throw new Error(`${label}: got [${actual.map((b) => b.toString(16))}] want [${expected.map((b) => b.toString(16))}]`);
  }
}

function eqCount(actual: number[][], n: number, label: string): void {
  if (actual.length !== n) {
    throw new Error(`${label}: ${actual.length} message(s) dispatched, want ${n} (got ${JSON.stringify(actual.map((m) => m.map((b) => b.toString(16))))})`);
  }
}

export function runSysExAssemblerTests(): void {
  // 1. A complete message in one fragment ships straight through, byte-identical.
  let got = feed([MSG_A.slice()]);
  eqCount(got, 1, 'single complete message');
  eq(got[0]!, MSG_A, 'single complete message payload');

  // 2. A message split across fragments is glued back into exactly one message.
  got = feed([MSG_A.slice(0, 3), MSG_A.slice(3, 5), MSG_A.slice(5)]);
  eqCount(got, 1, 'split message');
  eq(got[0]!, MSG_A, 'split message payload');

  // 3. Two complete messages coalesced into ONE fragment → two messages, never one glued blob.
  got = feed([[...MSG_A, ...MSG_B]]);
  eqCount(got, 2, 'coalesced pair');
  eq(got[0]!, MSG_A, 'coalesced pair first');
  eq(got[1]!, MSG_B, 'coalesced pair second');

  // 4. A complete message followed by a short (non-SysEx) message in one fragment.
  got = feed([[...MSG_A, ...SHORT]]);
  eqCount(got, 2, 'message + short message');
  eq(got[0]!, MSG_A, 'message + short: first');
  eq(got[1]!, SHORT, 'message + short: second');

  // 5. A complete message followed by a PARTIAL message: emit the complete one now, finish the
  //    partial on the next fragment (nothing may be glued onto the already-complete message).
  got = feed([[...MSG_A, ...MSG_B.slice(0, 4)], MSG_B.slice(4)]);
  eqCount(got, 2, 'message + partial then completion');
  eq(got[0]!, MSG_A, 'message + partial: complete one emitted first');
  eq(got[1]!, MSG_B, 'message + partial: partial completed');

  // 6. A short non-SysEx message alone still bypasses the accumulator.
  got = feed([SHORT.slice()]);
  eqCount(got, 1, 'short message alone');
  eq(got[0]!, SHORT, 'short message payload');
}
