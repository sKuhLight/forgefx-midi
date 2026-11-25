/**
 * Continuous MSB-first 7-bit stream → bytes.
 *
 * A gen-3 `fn 0x01` reply can carry a byte payload whose length is declared
 * separately from the frame: the bytes are packed into one continuous septet
 * stream (not per-value groups), most significant bits first. The receivers
 * unpack exactly `nbytes` bytes from `start` onward.
 *
 * This is the container used by the block graph-curve channel (`sub 0x23`) and
 * by the Looper waveform, which streams the same shape.
 *
 * If the wire ends before `nbytes` bytes were produced, the returned view is
 * short — callers that require a full payload must check `length`.
 */
export function decodeSeptetStream(
  wire: Uint8Array | readonly number[],
  nbytes: number,
  start = 0,
): Uint8Array {
  const out = new Uint8Array(nbytes);
  let acc = 0;
  let nbits = 0;
  let offset = 0;
  for (let i = start; i < wire.length && offset < nbytes; i++) {
    acc = (acc << 7) | ((wire[i] ?? 0) & 0x7f);
    nbits += 7;
    if (nbits >= 8) {
      nbits -= 8;
      out[offset++] = (acc >>> nbits) & 0xff;
    }
  }
  return offset < nbytes ? out.subarray(0, offset) : out;
}
