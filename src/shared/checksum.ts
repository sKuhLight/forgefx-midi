/**
 * Fractal SysEx XOR checksum.
 * Confirmed across all observed AM4 messages — see docs/SYSEX-MAP.md.
 *
 *   cs = (XOR of every byte from F0 through the last data byte) & 0x7F
 *
 * The result is appended just before the F7 terminator.
 */
export function fractalChecksum(bytes: readonly number[]): number {
  let acc = 0;
  for (const b of bytes) acc ^= b;
  return acc & 0x7f;
}

/**
 * Recompute and write the checksum of every complete SysEx frame inside
 * `bytes`, IN PLACE. For each `F0 … cs F7` span the byte just before the F7 is
 * replaced with the XOR (masked 0x7F) of everything from the F0 through the
 * last data byte. Use after editing a frame's payload (e.g. retargeting a
 * preset-dump header) so the device accepts the edited frame.
 */
export function fixFrameChecksums(bytes: number[]): void {
  for (let i = bytes.indexOf(0xf0); i >= 0; i = bytes.indexOf(0xf0, i + 1)) {
    const end = bytes.indexOf(0xf7, i);
    if (end <= i + 1) continue;
    let acc = 0;
    for (let k = i; k < end - 1; k++) acc ^= bytes[k]!;
    bytes[end - 1] = acc & 0x7f;
  }
}
