#!/usr/bin/env tsx
/**
 * AM4 live-poll capture → per-address value CSV.
 *
 * Reads a `.sysex.txt` dump produced by
 * `fm3-scratchpad/devices/am4/decompile/extract_usbmidi_sysex.py` (either the
 * newer 4-column `DIR<TAB>frame<TAB>time<TAB>hex` form or the older 3-column
 * `DIR<TAB>frame<TAB>hex`), filters the AM4 read-like responses
 * (`fn 0x01 PARAM_RW`, `hdr4=0x0004`, actions 0x0E/0x10/0x26), and decodes each
 * value with the SHIPPED forgefx-midi codec — so this offline analysis is
 * byte-for-byte what ForgeFX would render.
 *
 * Output CSV columns:
 *   time,dir,frame,pidLow,pidHigh,action,rawFloat,rawUInt32,paramKey,display,formatted,candidate,confidence,unknown
 *
 * Usage:
 *   tsx scripts/_research/am4-live-decode.ts <in.sysex.txt> [-o out.csv]
 *        [--address 0x0023/0x0001]   only this pidLow/pidHigh
 *        [--action 0x0010]           only this action
 *        [--dir D2H|H2D]             default D2H (device responses)
 *        [--include-unknown]         keep addresses with no param and no candidate
 *
 * See docs/AM4-LIVE-VALUE-DECODE-PLAN.md (Step 3).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isPollResponse, decodeAm4PollResponse } from '../../src/am4/index.js';

function hexToBytes(hex: string): number[] {
  return hex.trim().split(/\s+/).map((b) => Number.parseInt(b, 16));
}

function parseArgs(argv: string[]) {
  const opts: {
    input?: string;
    out?: string;
    address?: { pidLow: number; pidHigh: number };
    action?: number;
    dir: string;
    includeUnknown: boolean;
  } = { dir: 'D2H', includeUnknown: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') opts.out = argv[++i];
    else if (a === '--action') opts.action = Number.parseInt(argv[++i], 16);
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--include-unknown') opts.includeUnknown = true;
    else if (a === '--address') {
      const [lo, hi] = argv[++i].split('/').map((x) => Number.parseInt(x, 16));
      opts.address = { pidLow: lo, pidHigh: hi };
    } else if (!a.startsWith('-')) opts.input = a;
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input) {
    console.error('usage: tsx scripts/_research/am4-live-decode.ts <in.sysex.txt> [-o out.csv] [--address 0xLO/0xHI] [--action 0xNN] [--dir D2H] [--include-unknown]');
    process.exit(2);
  }

  const text = readFileSync(opts.input, 'utf8');
  const rows: string[] = [
    'time,dir,frame,pidLow,pidHigh,action,rawFloat,rawUInt32,paramKey,display,formatted,candidate,confidence,unknown',
  ];
  const perAddress = new Map<string, { count: number; label: string }>();
  let parsed = 0;
  let skipped = 0;

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const dir = parts[0];
    const frame = parts[1];
    // 4-col (with time) vs 3-col (no time).
    const time = parts.length >= 4 ? parts[2] : '';
    const hex = parts.length >= 4 ? parts[3] : parts[2];
    if (dir !== opts.dir) continue;

    const bytes = hexToBytes(hex);
    if (!isPollResponse(bytes)) continue;

    let r;
    try {
      r = decodeAm4PollResponse(bytes);
    } catch {
      skipped++;
      continue;
    }
    if (opts.action !== undefined && r.action !== opts.action) continue;
    if (opts.address && (r.pidLow !== opts.address.pidLow || r.pidHigh !== opts.address.pidHigh)) continue;
    if (r.unknown && !opts.includeUnknown) continue;

    parsed++;
    const addrKey = `0x${r.pidLow.toString(16).padStart(4, '0')}/0x${r.pidHigh.toString(16).padStart(4, '0')}`;
    const label = r.paramKey ?? r.candidate?.name ?? '(unknown)';
    const agg = perAddress.get(addrKey) ?? { count: 0, label };
    agg.count++;
    perAddress.set(addrKey, agg);

    rows.push(
      [
        time,
        dir,
        frame,
        `0x${r.pidLow.toString(16).padStart(4, '0')}`,
        `0x${r.pidHigh.toString(16).padStart(4, '0')}`,
        `0x${r.action.toString(16).padStart(4, '0')}`,
        r.rawFloat.toFixed(6),
        String(r.rawUInt32),
        r.paramKey ?? '',
        r.display !== undefined ? String(r.display) : '',
        r.formatted ?? '',
        r.candidate?.name ?? '',
        r.candidate?.confidence ?? '',
        String(r.unknown),
      ].join(','),
    );
  }

  const csv = rows.join('\n') + '\n';
  if (opts.out) {
    writeFileSync(opts.out, csv);
    console.error(`${parsed} value rows -> ${opts.out} (${skipped} unparseable)`);
  } else {
    process.stdout.write(csv);
  }

  // Address summary to stderr so it never pollutes CSV stdout.
  const summary = [...perAddress.entries()].sort((a, b) => b[1].count - a[1].count);
  console.error('\n# per-address value counts:');
  for (const [addr, { count, label }] of summary) {
    console.error(`  ${addr}  ${String(count).padStart(6)}  ${label}`);
  }
}

main();
