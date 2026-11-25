/**
 * Shared synthetic-frame helpers for the septet-container tests.
 *
 * `packSeptetStream` is the exact inverse of `decodeSeptetStream` (continuous
 * MSB-first 7-bit stream), used to build curve replies without hand-waving
 * payload lengths.
 */

/** Inverse of `decodeSeptetStream`: bytes -> one continuous MSB-first septet stream. */
export function packSeptetStream(bytes: readonly number[]): number[] {
  const nsept = Math.ceil((bytes.length * 8) / 7);
  const out = new Array<number>(nsept).fill(0);
  let bitPos = 0;
  for (const b of bytes) {
    for (let k = 7; k >= 0; k--, bitPos++) {
      const sept = Math.floor(bitPos / 7);
      out[sept] = (((out[sept] ?? 0) << 1) | ((b >> k) & 1)) & 0x7f;
    }
  }
  const pad = nsept * 7 - bytes.length * 8;
  if (pad > 0) out[nsept - 1] = ((out[nsept - 1] ?? 0) << pad) & 0x7f;
  return out;
}

/** Little-endian float32 wire bytes for `values`. */
export function float32Bytes(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    out.push(...new Uint8Array(buf));
  }
  return out;
}
