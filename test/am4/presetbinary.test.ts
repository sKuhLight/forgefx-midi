/**
 * AM4 preset binary — name field codec goldens.
 *
 * Wire bytes lifted directly from  calibration captures
 * (`samples/exports/{ABCDEFG, Test 1234}.syx`, mcp-midi-control repo,
 * 2026-05-21). Every byte is checked here so a regression in the
 * 3-byte-per-2-char chunked encoding fails the suite, not just the
 * factory-bank lookup.
 */
import {
  decodeAm4PresetName,
  encodeAm4PresetName,
  decodeAm4PresetNameFromFrame,
  AM4_PRESET_NAME_OFFSET,
  AM4_PRESET_NAME_WIRE_LENGTH,
} from '../../src/am4/index.js';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface Case {
  label: string;
  name: string;
  wireHex: string;
}

// 48 wire bytes, name field, from frame offset 0x21.
const calibrationCases: Case[] = [
  {
    label: 'ABCDEFG — short alpha name (BK-036 calibration capture)',
    name: 'ABCDEFG',
    wireHex:
      '410401430801450c01474000204000204000204000204000204000204000204000204000204000204000204000200000',
  },
  {
    label: 'Test 1234 — mixed case + digits + space (BK-036 calibration)',
    name: 'Test 1234',
    wireHex:
      '544a01736801206200326600344000204000204000204000204000204000204000204000204000204000204000200000',
  },
];

const roundTripCases: string[] = [
  '',                                  // empty name
  'A',                                 // single char
  'AB',                                // even split
  'ABC',                               // odd split — exercises the carry
  '0123456789',                        // digits
  'space test',                        // embedded space
  '!@#$%^&*()',                        // ASCII punctuation range
  'A B C D E F G H I J K L M N O',     // 31-char (max name length)
];

export const AM4_PRESET_BINARY_CASE_COUNT =
  calibrationCases.length * 3 + roundTripCases.length;

export function runAm4PresetBinaryTests(): void {
  // Calibration: decode wire → expected name.
  for (const c of calibrationCases) {
    const decoded = decodeAm4PresetName(hexToBytes(c.wireHex));
    if (decoded !== c.name) {
      throw new Error(
        `[am4/presetBinary] ${c.label}: decoded "${decoded}", expected "${c.name}"`,
      );
    }
  }

  // Calibration: encode name → expected wire bytes (byte-exact).
  for (const c of calibrationCases) {
    const encoded = encodeAm4PresetName(c.name);
    const encodedHex = bytesToHex(encoded);
    if (encodedHex !== c.wireHex) {
      throw new Error(
        `[am4/presetBinary] ${c.label}: encode mismatch\n  got:      ${encodedHex}\n  expected: ${c.wireHex}`,
      );
    }
  }

  // Calibration: decodeAm4PresetNameFromFrame on a synthetic frame.
  for (const c of calibrationCases) {
    const frame = new Uint8Array(AM4_PRESET_NAME_OFFSET + AM4_PRESET_NAME_WIRE_LENGTH);
    frame.set(hexToBytes(c.wireHex), AM4_PRESET_NAME_OFFSET);
    const decoded = decodeAm4PresetNameFromFrame(frame);
    if (decoded !== c.name) {
      throw new Error(
        `[am4/presetBinary] ${c.label}: frame decode "${decoded}", expected "${c.name}"`,
      );
    }
  }

  // Round-trip: encode → decode → original.
  for (const name of roundTripCases) {
    const wire = encodeAm4PresetName(name);
    if (wire.length !== AM4_PRESET_NAME_WIRE_LENGTH) {
      throw new Error(
        `[am4/presetBinary] round-trip "${name}": encoded ${wire.length} bytes, expected ${AM4_PRESET_NAME_WIRE_LENGTH}`,
      );
    }
    const decoded = decodeAm4PresetName(wire);
    if (decoded !== name) {
      throw new Error(
        `[am4/presetBinary] round-trip "${name}": decoded "${decoded}"`,
      );
    }
  }
}
