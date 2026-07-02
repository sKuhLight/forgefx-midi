// Gen-1 nibble-split codec primitive.
//
// The whole gen-1 wire is nibble-split, low-nibble-first: an 8-bit value
// 0..255 is transmitted as two MIDI bytes [v & 0x0f, (v >> 4) & 0x0f], each a
// single nibble (0..15) so the high bit is always clear (MIDI-safe by
// construction). This holds identically for block ids, param ids, and values.
//
// Proven from the published Ultra doc: value 163 = 0xA3 -> "03 0A"; block
// Compressor 1 = decimal 100 = 0x64 -> "04 06"; and the doc's full 0..255
// conversion table (256/256 verified by scripts/_research/parse-gen1-sysex.ts).
// NOT gen-2's septet pack, NOT gen-1-has-a-checksum (it does not).

/** 8-bit value (0..255) -> [lowNibble, highNibble]. */
export function nibbleSplit(value: number): [number, number] {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`gen-1 nibbleSplit: ${value} out of range 0..255`);
  }
  return [value & 0x0f, (value >> 4) & 0x0f];
}

/** [lowNibble, highNibble] -> 8-bit value. */
export function nibbleJoin(low: number, high: number): number {
  return ((high & 0x0f) << 4) | (low & 0x0f);
}
