import { describeAm4InboundMessage } from '../../src/devices/am4/describe.js';

interface Case {
  label: string;
  bytes: number[];
  includes: string[];
}

function h(hex: string): number[] {
  return hex.trim().split(/\s+/).map((b) => Number.parseInt(b, 16));
}

const cases: Case[] = [
  {
    label: 'fn 0x64 launch ACK',
    bytes: h('f0 00 01 74 15 64 00 00 74 f7'),
    includes: ['Multipurpose response', 'fn=0x00', 'OK'],
  },
  {
    label: 'fn 0x47 system info response',
    bytes: h('f0 00 01 74 15 47 4d 02 00 00 00 02 02 00 68 00 70 f7'),
    includes: ['System info response', 'function 0x47'],
  },
  {
    label: 'action 0x0010 live/value poll response',
    bytes: h('f0 00 01 74 15 01 25 00 10 00 10 00 00 00 04 00 4f 24 41 13 78 71 f7'),
    includes: ['AM4-Edit live/value poll response', 'ingate.gain_monitor', 'action=0x0010', 'hdr4=0x0004'],
  },
  {
    label: 'action 0x0026 status poll response',
    bytes: h('f0 00 01 74 15 01 2e 00 03 00 26 00 00 00 04 00 00 00 00 00 00 1e f7'),
    includes: ['AM4-Edit status poll response', 'action=0x0026', 'hdr4=0x0004'],
  },
  {
    label: 'action 0x0017 descriptor response',
    bytes: h(
      'f0 00 01 74 15 01 25 00 01 7d 17 00 00 00 28 00 7f 5f 60 00 00 00 00 00 ' +
      '00 00 00 03 79 4c 67 33 1f 00 00 03 01 7d 3a 12 00 25 48 45 68 18 01 ' +
      '00 1f 5c 51 28 71 6f 64 41 67 4f 19 5c 62 30 7a f7',
    ),
    includes: ['PARAM_RW descriptor response', 'action=0x0017', 'hdr4=0x0028'],
  },
];

export const AM4_DESCRIBE_CASE_COUNT = cases.length;

export function runAm4DescribeTests(): void {
  const failed: string[] = [];
  for (const c of cases) {
    const label = describeAm4InboundMessage(c.bytes);
    for (const expected of c.includes) {
      if (!label.includes(expected)) {
        failed.push(`${c.label}: expected '${expected}' in '${label}'`);
      }
    }
  }
  if (failed.length > 0) {
    throw new Error(`[am4/describe] ${failed.length} failure(s):\n` + failed.join('\n'));
  }
}
