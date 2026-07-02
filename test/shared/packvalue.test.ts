/**
 * Golden round-trip vectors for `packValue` / `unpackValue` /
 * `packFloat32LE` / `unpackFloat32LE`.
 *
 * Captured (displayed_value, internal_scale_factor, wire_5_bytes)
 * tuples are lifted from the upstream `scripts/verify-pack.ts` golden
 * — these were originally captured live from an AM4 over USB. If this
 * test ever fails, the codec drifted from byte-level wire reality, NOT
 * just from internal expectations.
 */
import { packFloat32LE, unpackFloat32LE, packValue, unpackValue } from '../../src/shared/packValue.js';
import { fractalChecksum } from '../../src/shared/checksum.js';

interface Sample {
  label: string;
  displayed: number;
  scale: number;
  wire: number[];
}

const SAMPLES: Sample[] = [
  { label: 'AmpGain 0.0', displayed: 0.0, scale: 0.1, wire: [0x00, 0x00, 0x00, 0x00, 0x00] },
  { label: 'AmpGain 0.25', displayed: 0.25, scale: 0.1, wire: [0x66, 0x73, 0x19, 0x43, 0x60] },
  { label: 'AmpGain 0.5', displayed: 0.5, scale: 0.1, wire: [0x66, 0x73, 0x09, 0x43, 0x68] },
  { label: 'AmpGain 1.0', displayed: 1.0, scale: 0.1, wire: [0x66, 0x73, 0x19, 0x43, 0x68] },
  { label: 'AmpGain 1.5', displayed: 1.5, scale: 0.1, wire: [0x4d, 0x26, 0x23, 0x13, 0x70] },
  { label: 'AmpGain 2.0', displayed: 2.0, scale: 0.1, wire: [0x66, 0x73, 0x09, 0x43, 0x70] },
  { label: 'AmpGain 2.5', displayed: 2.5, scale: 0.1, wire: [0x00, 0x00, 0x10, 0x03, 0x70] },
  { label: 'AmpGain 3.0', displayed: 3.0, scale: 0.1, wire: [0x4d, 0x26, 0x33, 0x13, 0x70] },
  { label: 'AmpGain 4.0', displayed: 4.0, scale: 0.1, wire: [0x66, 0x73, 0x19, 0x43, 0x70] },
  { label: 'EQ -1.0 dB', displayed: -1.0, scale: 1 / 12, wire: [0x55, 0x6a, 0x55, 0x2b, 0x68] },
];

const EPS = 1e-5;

export function runPackValueTests(): void {
  for (const s of SAMPLES) {
    const internal = s.displayed * s.scale;
    const packed = packFloat32LE(internal);
    if (packed.length !== 5) {
      throw new Error(`${s.label}: expected 5 packed bytes, got ${packed.length}`);
    }
    const actualWire = Array.from(packed);
    for (let i = 0; i < 5; i++) {
      if (actualWire[i] !== s.wire[i]) {
        throw new Error(
          `${s.label}: wire byte ${i} mismatch — expected 0x${s.wire[i].toString(16).padStart(2, '0')}, got 0x${actualWire[i].toString(16).padStart(2, '0')}`,
        );
      }
    }
    const decoded = unpackFloat32LE(new Uint8Array(s.wire));
    if (Math.abs(decoded - internal) > EPS) {
      throw new Error(`${s.label}: round-trip drift — expected ${internal}, got ${decoded}`);
    }
  }

  // Generic round-trip on a non-float payload (mirrors the
  // packValueChunked use case for preset names without exercising the
  // chunked path itself).
  const raw = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  const wire = packValue(raw);
  const back = unpackValue(wire, raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (back[i] !== raw[i]) {
      throw new Error(`packValue/unpackValue round-trip drift at index ${i}`);
    }
  }
}

export function runChecksumTests(): void {
  // (bytes-through-last-data, expected_xor_checksum) tuples for the
  // AM4 SysEx envelope (model byte 0x15). XOR of all bytes through
  // the last data byte, masked with 0x7F.
  const samples: Array<{ label: string; bytes: number[]; expected: number }> = [
    { label: 'empty', bytes: [], expected: 0 },
    // F0 ^ 00 ^ 01 ^ 74 ^ 15 ^ 02 = 0x92; & 0x7F = 0x12
    { label: 'F0 00 01 74 15 02', bytes: [0xf0, 0x00, 0x01, 0x74, 0x15, 0x02], expected: 0x12 },
    // F0 ^ 00 ^ 01 ^ 74 ^ 15 ^ 08 = 0x98; & 0x7F = 0x18
    { label: 'F0 00 01 74 15 08', bytes: [0xf0, 0x00, 0x01, 0x74, 0x15, 0x08], expected: 0x18 },
  ];
  for (const s of samples) {
    const got = fractalChecksum(s.bytes);
    if (got !== s.expected) {
      throw new Error(`${s.label}: expected checksum 0x${s.expected.toString(16)}, got 0x${got.toString(16)}`);
    }
  }
}
