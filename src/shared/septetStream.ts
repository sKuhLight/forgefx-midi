/** Decode a continuous MSB-first septet stream into up to `nbytes` raw bytes. */
export function decodeSeptetStream(wire: Uint8Array | readonly number[], nbytes: number, start = 0): Uint8Array {
  const out = new Uint8Array(nbytes);
  let acc = 0;
  let nbits = 0;
  let offset = 0;
  for (let i = start; i < wire.length && offset < nbytes; i++) {
    acc = (acc << 7) | (wire[i]! & 0x7f);
    nbits += 7;
    if (nbits >= 8) {
      nbits -= 8;
      out[offset++] = (acc >>> nbits) & 0xff;
    }
  }
  return offset < nbytes ? out.subarray(0, offset) : out;
}
