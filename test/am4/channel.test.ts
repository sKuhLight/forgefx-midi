/**
 * AM4 block `channel` (A/B/C/D) coverage.
 *
 * `channel` sits at pidHigh=0x07d2 in every block's own pidLow namespace.
 * amp/drive/reverb/delay are hardware-confirmed via real captures (see the
 * session-09/session-18 goldens in setparam.test.ts). The other 14 blocks
 * are pattern-extended from that offset (docs: chorus.channel note in
 * src/am4/params.ts) — this test locks in the encode/decode roundtrip for
 * all of them so a future capture that contradicts the pattern shows up as
 * a diff here, not a silent drift.
 */
import { buildSetFloatParam, buildSetParam, KNOWN_PARAMS } from '../../src/am4/index.js';

function hex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CHANNEL_BLOCKS = [
  'amp', 'drive', 'reverb', 'delay', // hardware-confirmed
  'chorus', 'flanger', 'phaser', 'wah', 'compressor', 'geq', 'filter',
  'gate', 'enhancer', 'ingate', 'tremolo', 'volpan', 'peq', 'rotary', // pattern-extended
] as const;

export const AM4_CHANNEL_CASE_COUNT = CHANNEL_BLOCKS.length * 4;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export function runAm4ChannelTests(): void {
  for (const block of CHANNEL_BLOCKS) {
    const key = `${block}.channel` as keyof typeof KNOWN_PARAMS;
    const param = KNOWN_PARAMS[key];
    assert(Boolean(param), `[am4/channel] ${key} missing from KNOWN_PARAMS`);
    assert(param.pidHigh === 0x07d2, `[am4/channel] ${key} not at the shared channel offset 0x07d2`);
    assert(
      JSON.stringify(param.enumValues) === JSON.stringify({ 0: 'A', 1: 'B', 2: 'C', 3: 'D' }),
      `[am4/channel] ${key} enum drifted from A/B/C/D`,
    );

    for (let i = 0; i <= 3; i++) {
      const built = buildSetParam(key, i);
      const rebuilt = buildSetFloatParam(param, i);
      assert(
        hex(built) === hex(rebuilt),
        `[am4/channel] ${key} index ${i} roundtrip mismatch (display-vs-raw encode diverged)`,
      );
    }
  }

  // Cross-block sanity: every block uses ITS OWN pidLow at the shared
  // channel offset — no two blocks should collide on the same address.
  const seen = new Set<number>();
  for (const block of CHANNEL_BLOCKS) {
    const param = KNOWN_PARAMS[`${block}.channel` as keyof typeof KNOWN_PARAMS];
    assert(!seen.has(param.pidLow), `[am4/channel] duplicate pidLow ${param.pidLow} across channel params`);
    seen.add(param.pidLow);
  }
}
