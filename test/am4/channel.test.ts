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
import {
  buildSetFloatParam,
  buildSetParam,
  buildReadActiveChannel,
  parseActiveChannelResponse,
  AM4_CHANNEL_STATUS_PID_HIGH,
  KNOWN_PARAMS,
} from '../../src/am4/index.js';

function hex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytes(h: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

/**
 * Active-channel READ goldens, byte-exact from Channels.pcapng (2026-07-11,
 * AM4-Edit A→B→C→D→A both in-app and front-panel). The channel-SELECT register
 * 0x07D2 is unreadable (FORGEFXMID-16); 0x07DD long-read byte 50 is the reliable
 * source. See docs/AM4-CHANNEL-SWITCH-DECODE.md.
 */
const CHANNEL_READ_REQUEST_AMP = 'f000017415013a005d0f0d000000000074f7';
const CHANNEL_READ_RESPONSES: ReadonlyArray<{ label: string; frame: string; expect: number }> = [
  { label: 'amp/A', frame: 'f000017415013a005d0f0d00000036001d00130002055a700000000000000000000000000000000000000000000000000000000000000000001029550000000000000120000000010000000020000df7', expect: 0 },
  { label: 'amp/B', frame: 'f000017415013a005d0f0d00000036001d00130002055a700000000000000000000000000000000000000000000000000000000000000000001029550000000000000120000000010000200020002df7', expect: 1 },
  { label: 'amp/C', frame: 'f000017415013a005d0f0d00000036001d00130002055a700000000000000000000000000000000000000000000000000000000000000000001029550000000000000120000000010000400020004df7', expect: 2 },
  { label: 'amp/D', frame: 'f000017415013a005d0f0d00000036001d00130002055a700000000000000000000000000000000000000000000000000000000000000000001029550000000000000120000000010000600020006df7', expect: 3 },
  { label: 'drive/A', frame: 'f0000174150176005d0f0d00000036003b000620021164693b1924030800000000000000000000000000000000000000000000000000000000110a253000000000000310000000010000000020003cf7', expect: 0 },
  { label: 'reverb/A', frame: 'f0000174150142005d0f0d00000036002100091002494a76325c4c2000000000000000000000000000000000000000000000000000000000001448553000000000000140000000010000000020002ef7', expect: 0 },
  { label: 'enhancer/A', frame: 'f000017415017a005d0f0d00000036003d00022002155c68305b4c362b4800000000000000000000000000000000000000000000000000000011296440000000000003200000000100000000200052f7', expect: 0 },
];

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

  // ── Active-channel READ (0x07DD long read, byte 50) ──────────────────────
  // buildReadActiveChannel(amp) must reproduce the captured request byte-exact.
  assert(
    hex(buildReadActiveChannel(0x003a)) === CHANNEL_READ_REQUEST_AMP,
    `[am4/channel] buildReadActiveChannel(amp) != captured request ${CHANNEL_READ_REQUEST_AMP}`,
  );
  // The read targets 0x07DD (the readable status register), NOT the 0x07D2
  // write-only select register.
  assert(
    KNOWN_PARAMS['amp.channel'].pidHigh !== AM4_CHANNEL_STATUS_PID_HIGH,
    `[am4/channel] select (0x07D2) and status (0x07DD) registers must differ`,
  );
  // parseActiveChannelResponse decodes byte 50 → channel index, byte-exact
  // against real captured responses (amp A–D + drive/reverb/enhancer).
  for (const { label, frame, expect } of CHANNEL_READ_RESPONSES) {
    const got = parseActiveChannelResponse(bytes(frame));
    assert(
      got === expect,
      `[am4/channel] parseActiveChannelResponse(${label}) = ${got}, expected ${expect}`,
    );
  }
  // Rejects a non-0x07DD frame (a 0x07D2 select echo) rather than misreading it.
  assert(
    parseActiveChannelResponse(buildSetParam('amp.channel', 2)) === null,
    `[am4/channel] parseActiveChannelResponse must reject a non-0x07DD frame`,
  );
}
