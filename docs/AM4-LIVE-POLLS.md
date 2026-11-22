# AM4 live polls — wire shapes and value decode

Protocol facts for the AM4's live / meter / tuner readouts, as carried by the
codec in `src/am4/livePolls.ts`, `src/am4/liveDecode.ts`, `src/am4/tuner.ts`
and `src/am4/setParam.ts`. Facts only: how the readouts are polled, how to
decode them, and which addresses are pinned, which are labelled candidates.

## Transport

The AM4 has no separate gen-3-style telemetry or push channel. The editor
reads meter / tuner / status values with ordinary `fn 0x01 PARAM_RW` polls;
nothing is pushed. `GET_METER` is dead on this device (flat, zero variance).
There is no CPU meter and no looper function reachable over `PARAM_RW`.

Non-`PARAM_RW` functions the AM4 uses around the polls:

- `fn 0x64` multipurpose ACK: `f0 00 01 74 15 64 <fn> <rc> <cs> f7`, `rc=0x00` is OK.
- `fn 0x08` firmware / version request and response (version bytes + build date).
- `fn 0x47` system-info-style request and response (same number as gen-2
  `GET_SYSINFO`; the AM4 payload is opaque).
- `fn 0x12` mode switch (ACKed by `fn 0x64`).

## `PARAM_RW` action families

| Action | Shape | Meaning |
| --- | --- | --- |
| `0x000d` | 64-byte response, `hdr4=0x0028` | long read (live bypass state) |
| `0x000e` | 23-byte response, `hdr4=0x0004` | short read (generic) |
| `0x0010` | 18-byte request, 23-byte response, `hdr4=0x0004` | live / value poll |
| `0x0012` | 55-byte response, `hdr4=0x0020` | preset-name read |
| `0x0017` | 23-byte request, 64-byte response, `hdr4=0x0028` | descriptor read; with `pidHigh=0x3e81` it is a block-navigation marker (see below) |
| `0x001f` | 238-byte descriptor response | GET_PATCH (device-true dirty-bit source) |
| `0x0026` | 18-byte request, 23-byte zero-valued response | status / zero poll |
| `0x0027`, `0x0028` | rare | semantics unassigned |

`src/devices/am4/describe.ts` labels these shapes for diagnostics.

## Decode chain

A live-poll response is byte-shape-identical to the short read (`0x000e`): 23
bytes, `hdr4=0x0004`, five packed wire septets that unpack to four raw bytes. Only
the action code differs.

```
5 wire septets -> unpackFloat32LE() -> float32 -> decode(param, f) -> display
```

The four payload bytes are a little-endian `float32` (mirroring the write path
`buildSetParam -> packFloat32LE`), **not** `u32 / 65534`. For the gain / level
monitors the float is a normalized value in `[0, 1]`; for the tuner it is an
absolute engineering value (below). `asInternalFloat()` (`u32 / 65534`) is only
for normalized-integer registers (type / enum), not for continuous meters.

`parseReadResponse` accepts `POLL_READ_ACTIONS` (`0x10`, `0x26`) in addition to
`0x0e`; `isPollResponse` is the shape-only predicate.

## Pinned readouts

| Address | Readout | Scaling |
| --- | --- | --- |
| `0x0025/0x0010` `ingate.gain_monitor` | input-gate gain meter | float32 `[0, 1]`; shipped `knob_0_10` x10 display |
| `0x002e/0x001f` `compressor.gain_monitor` | compressor gain meter | float32 `[0, 1]`; cache range is degenerate (a=b=c=0), same x10 heuristic |
| `0x005e/0x000f` `wah.wah_control` | wah control position | catalogued scaling |
| `0x0023/0x0001` | tuner: nearest-note index, `MIDI note = v + 9` (0 = A0) | float32, direct integer |
| `0x0023/0x0002` | tuner: detected fundamental, Hz | float32, direct Hz |
| `0x0023/0x0003` | tuner: cents deviation from the nearest note (about +/-50) | float32, direct signed cents |
| `0x0023/0x0004` | tuner: string / octave-band index 0..5 (0 = highest pitch) | float32, direct integer; the literal string-name mapping is not pinned |
| `0x002a/0x0016`, `0x002a/0x0017` | main output level, left / right | float32 `[0, 1]`; the dB reference is not pinned |
| `0x0003/0x001c` `modifier.slot1_live_value` | Modifier 1 live value | float32 `[0, 1]`; shape pinned, exact mapping depends on the modifier target |

The tuner channels are self-consistent: `ch1 + 9` equals the nearest MIDI note
of `ch2` (Hz), and `ch3` equals `1200 * log2(f / nearestNoteFreq)`. They are
**absolute** float32 values; do not apply the x10 / `[0, 1]` treatment used for
gain monitors. Suggested rendering: note name from `ch1`, needle from `ch3`,
optional string highlight from `ch4`. `src/am4/tuner.ts` implements it.

## Labelled candidates (not decoded)

- `0x0066/0x0014` volume/pan (`VOLUME_METER` in the resolver): a discrete
  state / position indicator (about 12 quantised levels in `[0, 1]`, mostly
  zero), not a continuous meter. Read-only; do not expose it as a settable knob.
- `0x0002/0x0056`: float32 `[0, 0.03]`, about 20 values; active around
  modifier source selection (envelope-follower or a second modifier slot).
- `0x002e/0x0022` (compressor family): float32 `[-0.24, 0.68]`, so not a simple
  normalized meter.
- `0x0001/0x0088`: polled with the tuner but constant `0`.
- Five sibling reads under the modifier-panel block (`0x0002/0x000b..0x000e`,
  `0x0002/0x0042`) are always `0`.

## Block-navigation marker

Every `action=0x0017` event carries `pidHigh=0x3e81`, a sentinel rather than a
real parameter id, with a `pidLow` that is the block being opened. It arrives in
a tight burst (2..8 events within about 10 ms) at the moment the editor starts
polling that block. Opening a modifier panel emits a sequential burst covering
`pidLow` `0x0002` through `0x0012`.

## Cache join facts

Within a block, wire `pidHigh == cache_id` in the editor definitions cache.
The cache's section `blockTag` is a cache-internal category index, not the wire
`pidLow`; blocks are identified by their enum contents and then joined by
`id == pidHigh`. Float records are `a, b, c, d = min, max, scale, step` with
display = wire x scale, and `log10` taper only for typecodes
`{0x40, 0x44, 0x48, 0x50}`. The cache leaves meters unscaled (degenerate range),
so meter scaling is a decode result, not a cache fact.

## Tempo, footswitch and global parameters

Tempo is tap / CC driven only on this firmware: `global.tap_tempo_mode`
(`0x0001/0x002e`) is a normal write; `global.tempo_cc` (`0x0001/0x0048`) is a
MIDI CC# assignment, not a BPM value; there is no settable BPM float. The
footswitch section is covered by existing catalog globals
(`global.fc_ring_bright_level` `0x0001/0x0058`, `global.fc_ring_dim_level`
`0x0001/0x0059`, `global.startup_mode` `0x0001/0x0089`,
`global.presshold_mode` `0x0001/0x0092`; `global.fs_press_hold1..4`
`0x0001/0x0084..0087` are long-read only).

## Still open

- Main output `[0, 1]` to dB curve.
- Volume/pan indicator semantics.
- Tuner string-name mapping.
- Meaning of `0x0001/0x0088`, `0x002e/0x0022`, `0x0002/0x0056`.
- `action=0x0017` payload beyond the navigation marker, and the rare
  `0x0027` / `0x0028` variants.
