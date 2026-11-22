# AM4 Channel (A/B/C/D) switch — wire decode

Channel switching (A/B/C/D) on the AM4, both directions: setting the channel
from software and reading it back, which is also how front-panel changes are
reflected. Tracked as **FORGEFXMID-18**.

**Status:** both directions are hardware-verified (swaps from the editor and
swaps from the AM4 front panel).

---

## Frame layout recap (func 0x01 PARAM_RW)

```
F0 00 01 74 15 01 [pid_lo:14][pid_hi:14][action:14][hdr3:14][hdr4:14] [value…] cs F7
```
Each 14-bit field = two 7-bit septets, LSB first. `hdr4 = packedValueBytes.length − 1`.
Value is 8→7 septet-packed (`shared/packValue.ts`). Action `0x0001` = WRITE.

## The channel-switch message (SET — VERIFIED)

Channel switch is a **WRITE (action 0x0001) to the AMP block** `pidLow = 0x3A`,
**`pidHigh = 0x7D2`**, value = **float32 channel index** (`A=0.0, B=1.0, C=2.0, D=3.0`).

It is exactly:

```ts
buildSetFloatParam({ pidLow: 0x3A, pidHigh: 0x7D2 }, channelIndex /* 0..3 as float */)
```

The four software swaps wrote floats **1, 2, 3, 0 = B, C, D, A**,
matching "A up to D then A again".

Byte-exact reconstruction of the channel-B write vs. the observed frame:

```
observed : f0 00 01 74 15 01 3a 00 52 0f 01 00 00 00 04 00  00 00 10 03 78  18 f7
fields   : func=01  pidLo=3A  pidHi=7D2  action=01  hdr3=0  hdr4=04  value=0000100378
value    : 8→7 unpack(0000100378) = 00 00 80 3F = float32 1.0  (= channel B)
```

`buildSetFloatParam` + `packFloat32LE(1.0)` reproduces `0000100378` and the whole
frame including checksum `0x18`.

The WRITE **response** (IN) is a 40-byte structure (`hdr4=0x28`) whose leading float
is ≈ the newly selected channel (1.001, 2.0018, 3.0077, ~0 for the four writes) —
i.e. the register read-back carries the active channel in its first field.

## Reading the active channel / reflecting front-panel changes (VERIFIED)

The AM4 **never pushes** — 0 unsolicited IN frames in 28 s; strictly request/response.
AM4-Edit reflects channel changes (from *either* source) by **polling a separate
read-back register per block**:

**Read `(blockPidLow, 0x7DD)` with read action `0x0D`.** The response is a **54-byte
block-status structure** (block id, name, short-name, flags) whose **byte 50 = the
current channel index (0..3)**.

Proof: across the four amp channel states, the `(0x3A, 0x7DD)` structure is
**byte-identical except byte 50**, which reads 0/1/2/3:

```
ch A: 3a009800416d70…414d5000000000000a000000010000000400   (byte50 = 00)
ch B: …0a000000010001000400                                  (byte50 = 01)
ch C: …0a000000010002000400                                  (byte50 = 02)
ch D: …0a000000010003000400                                  (byte50 = 03)
```

AM4-Edit polls `(block, 0x7DD)` for every block about every 0.5 s. The **amp** byte-50 cycles `0→1→2→3→0` during the part-1 (AM4-Edit) swaps;
**other blocks** (Enhancer `0x7A`, Reverb `0x42`) cycle during the part-2 (front-panel)
swaps — confirming the same read-back register catches front-panel changes.

**Two distinct registers — do not confuse them:**

| purpose | pidHigh | action | value |
|---|---|---|---|
| **set** the channel | `0x7D2` | `0x01` WRITE | float32 index (A=0…D=3) |
| **read** the channel | `0x7DD` | `0x0D` READ | 54-byte struct, **byte 50** = index |

## Implementation for ForgeFX

- `buildSetChannel(blockPidLow, idx)` = `buildSetFloatParam({pidLow, pidHigh:0x7D2}, idx)`.
- `buildReadChannel(blockPidLow)` = read `(pidLow, 0x7DD, action 0x0D)`; parse byte 50 of
  the unpacked (chunked 8→7) payload.
- Channel watch: poll `(block, 0x7DD)` at a low rate (mirror the scene watch; keep it
  cheap to avoid the scene-change latency regression).

## Notes / minor open points

- `0x7DD` structure has other fields (name at offset 4, short-name near offset 42, a
  `0x0a`/`0x01` flag pair) not needed for channel; document if reused.
- Per-block generality is now shown for amp/enhancer/reverb (all expose `(block,0x7DD)`
  byte 50); assume the full block set follows.
