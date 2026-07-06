# AM4 live-value decode — plan & progress

Decode the 4-byte VALUE payload / scaling of AM4-Edit's live-poll responses
(`fn 0x01 PARAM_RW`, actions `0x0010` live/value poll and `0x0026` status poll)
so ForgeFX can render AM4 meters/tuner instead of only *labelling* the poll
addresses. Follow-on from the 2026-07-05 BigCapture analysis
([`AM4-CAPTURE-2026-07-05.md`](./AM4-CAPTURE-2026-07-05.md)) and the
`AM4_LIVE_POLL_CANDIDATES` label table in `src/am4/livePolls.ts`.

## The key finding that grounds all of this

A live-poll response is **byte-shape-identical** to the existing short read
(`action 0x000E`): 23 bytes, `hdr4=0x0004`, 5 packed wire septets → 4 raw bytes.
So there is **no new payload format to reverse** — only the *action code*
differs, and `parseReadResponse` used to hard-throw on `action != 0x000E`.

The 4 payload bytes are a **`float32` LE in `[0,1]`** (mirroring the write path
`buildSetParam → packFloat32LE`), **not** `u32/65534`. Proven by decoding four
real `ingate.gain_monitor` (`0x0025/0x0010`, action `0x0010`) frames from
`Repositorys/fm3-scratchpad/devices/am4/captures/`:

| interpretation | f1 | f2 | f3 | f4 |
|---|---|---|---|---|
| `u32/65534` | 16237 | 16237 | 16238 | 16238 (nonsense) |
| **float32 LE** | 0.9253 | 0.9235 | 0.9285 | 0.9265 |
| × 10 (`knob_0_10`) | **9.25** | 9.23 | 9.28 | 9.27 (live gain meter) |

Corrected decode chain:
```
5 wire septets → unpackFloat32LE()  →  float32 ∈ [0,1]  →  decode(param, f)  →  display (e.g. ×10)
```
`unpackFloat32LE()` already exists (`src/shared/packValue.ts:104`). The
`asInternalFloat()` accessor (`u32/65534`) is for normalized-**integer**
registers (type/enum), not continuous meters.

## Two classes of address

- **Problem A — addresses already in `KNOWN_PARAMS`** (`ingate.gain_monitor`
  `0x0025/0x0010`, `compressor.gain_monitor` `0x002e/0x001f`, `wah.wah_control`
  `0x005e/0x000f`): scaling already catalogued (`unit` + `displayMin/Max`).
  Decoding is essentially free once the parser accepts the poll actions.
- **Problem B — addresses with no param entry** (tuner `0x0023/0x0001..0004`,
  main output `0x002a/0x0016..0017`, vol/pan `0x0066/0x0014`): need scaling
  pinned. Two tracks:
  - **B1 cache-driven (preferred, no hardware):** map `(pidLow,pidHigh)` →
    cacheId → `typecode/min/max/step/values` from
    `Repositorys/fm3-scratchpad/devices/am4/decompile/cache-records.json`
    (parsed `effectDefinitions_15_66p1.cache`). e.g. tuner ref-A freq cache id
    13 = `{typecode:50 float, min:430, max:450, step:0.1}`.
  - **B2 correlation (only where B1 is silent):** extract the per-address value
    time-series from BigCapture, overlay on `Audio_Take8_Mic-1.1.mp3` within the
    plan windows, pin scaling across the whole window (never one sample).

## Source material (all under `Repositorys/fm3-scratchpad`, NOT the `Dokumente` twin)

- `devices/am4/captures/{preset-swap,preset-save,amp-model-change}.sysex.txt` —
  already-extracted SysEx with real `0x0010` frames for the known addresses.
- `devices/am4/decompile/extract_usbmidi_sysex.py` — pcapng → SysEx extractor
  (tshark front-end; produced the `.sysex.txt` files above).
- `devices/am4/decompile/cache-records.json` (+ `cache-section2/3.json`) —
  parsed editor cache: `typecode/min/max/step/values` per cacheId.
- BigCapture: `/home/pascal/Downloads/BigCapture/MISTER MEAL.pcapng` (3.1 GB) +
  `Audio_Take8_Mic-1.1.mp3`.
- forgefx-midi decode path: `src/am4/setParam.ts` (`parseReadResponse`),
  `src/shared/packValue.ts` (`unpackFloat32LE`), `src/am4/params.ts`
  (`decode`, `formatDisplay`, `KNOWN_PARAMS`).

---

## Work log

### Step 1 — codec: accept poll actions + float32 accessor  ✅ (2026-07-06)
- [x] `src/am4/setParam.ts`: added `READ_TYPE_LIVE_POLL=0x10`, `READ_TYPE_STATUS_POLL=0x26`, `POLL_READ_ACTIONS`.
- [x] `ReadResponse`: added `action` field + `asFloat32()` (uses existing `unpackFloat32LE`). Doc-corrected `asInternalFloat` (u32/65534) as integer-register-only.
- [x] Generalized `parseReadResponse` to accept `POLL_READ_ACTIONS`; added shape-only `isPollResponse` predicate (no outgoing read needed — for passive capture replay).
- [x] Exported new symbols from `src/am4/index.ts`.
- [x] Golden test `test/am4/polldecode.test.ts` — four REAL ingate frames → float32 ≈ 0.925, and asserts `asInternalFloat` is nonsensical (guards the correction). Wired into `run-all.ts`.

### Step 2 — codec: live-decode helper  ✅ (2026-07-06)
- [x] `src/am4/liveDecode.ts`: `PARAM_BY_PID` reverse index + `am4ParamKeyForPid`, `decodeAm4LiveValue(pidLow,pidHigh,rawFloat,rawUInt32,action)`, and `decodeAm4PollResponse(bytes)`. Returns `{paramKey?, unit?, display?, formatted?, candidate?, rawFloat, rawUInt32, unknown}`. KNOWN_PARAMS lookup (enum via uint32 index; continuous via `decode(param,float)`), else `AM4_LIVE_POLL_CANDIDATES` label, else `unknown:true` with raw only.
- [x] Exported from `src/am4/index.ts`; browser-safe (passes check-browser-safe).
- [x] Test `test/am4/livedecode.test.ts` (known param → 9.25 / candidate-only / unknown); wired into `run-all.ts`.

### Step 3 — tooling: capture → per-address value CSV  ✅ (2026-07-06)
- [x] Extended `extract_usbmidi_sysex.py` with a `frame.time_relative` column → 4-col output (`DIR<TAB>frame<TAB>time<TAB>hex`); reader accepts old 3-col too. `py_compile` clean.
- [x] `scripts/_research/am4-live-decode.ts`: reads a `.sysex.txt`, filters AM4 `fn 0x01 hdr4=0x0004` responses via `isPollResponse`, decodes with the SHIPPED `decodeAm4PollResponse`, emits per-address CSV + a per-address count summary. Offline == production.
- [x] Smoke-tested on `preset-swap.sysex.txt`: 109 value rows, 0 unparseable; 57× `ingate.gain_monitor` all ≈ 9.2/10; correctly resolved `amp.channel_*_color`, `ingate.level`.

**Verification:** `npm test` → all 42 suites pass (was 40). `npm run build` clean; ForgeFX
`server` typechecks (exit 0) against the rebuilt `dist/`.

**Result summary:** the decode chain is proven end-to-end on real capture data —
`5 septets → unpackFloat32LE → decode(param) → display`. Problem-A monitors
(`ingate.gain_monitor`, `compressor.gain_monitor`, `wah.wah_control`) now render
live values today. Problem-B (tuner / main-output / vol-pan candidates) awaits the
cache-join (B1) and audio-correlation (B2) passes below, for which the CSV tool is
the input.

### B1 — cache-join  ✅ DONE (2026-07-06) — see [`AM4-B1-CACHE-JOIN.md`](./AM4-B1-CACHE-JOIN.md)
Join mechanics proven: **within a block, wire `pidHigh` == `cache_id`**; the
section-2 `blockTag` is a cache-internal category index, NOT the wire pidLow, so
blocks are identified by enum payload then joined by `id == pidHigh`. Float
grammar `a,b,c,d = min,max,scale,step`, display = wire×scale, `log10` only for
typecodes `{0x40,0x44,0x48,0x50}`.

Results:
- **`effectDefinitions_15_66p1.cache` is a partial preset snapshot** — ingate
  (0x25), preset/Main-Levels (0x2a), wah (0x5e), volpan (0x66) blocks are ABSENT.
- **Gain-monitor ×10 scaling is a display heuristic, not cache-anchored.** The
  one monitor present (`compressor.gain_monitor` 0x2e/0x1f = id 31) has a
  degenerate range (a=b=c=0) — the cache leaves meters unscaled. → true scaling
  is a B2 job for all four gain/level meters.
- **"tuner" candidates `0x0023/0x0001..4` are the modifier/control block**, not
  the pitch tuner. Real 0..10 knob range (cache ids 1..4); per-slot meaning → B2.
  livePolls.ts labels `tuner.live_channel_*` are misnamed → rename to
  `control.live_slot_*` when we touch it.
- **`volpan 0x0066/0x0014` = `VOLUME_METER`** (resolver-pinned, read-only meter);
  range absent from 66p1 → B2. Do NOT ship as a settable knob.
- **`main_output 0x002a/0x0016..0017`** — preset/Main-Levels family, unregistered
  pidHighs, no cache record → pure B2.
- Blocked follow-up: re-parsing the fuller `_2p0` cache would resolve the absent
  blocks, but **`effectDefinitions_15_2p0.cache` is NOT on disk** (only `66p1`).
  Would need to locate/extract it (older AM4-Edit build) — parked.

**Net: no `KNOWN_PARAMS` changes are cache-safe yet.** Meter scaling all falls to B2.

### B2 — audio correlation  ✅ DONE (2026-07-06) — see [`AM4-B2-AUDIO-CORRELATION.md`](./AM4-B2-AUDIO-CORRELATION.md)
Full BigCapture extraction was cheap (9,586 USB bulk packets → 482,866 SysEx);
the shipped decoder produced 33,930 value rows, 0 unparseable.
- **Tuner `0x0023/0x0001..4` — FULLY DECODED (overrides B1's cache guess).** The
  cache `blockTag` 0x23 was the modifier block; wire 0x23 is the tuner readout,
  and its value ranges (23–382 Hz, ±48 cents) refute a 0..10 knob. Channels:
  0x01 note index (MIDI = v+9), 0x02 freq Hz (absolute float32), 0x03 signed
  cents, 0x04 string/band 0–5. Self-proving: note(freq)==index 99%; cents ==
  1200·log2(freq/nearestNoteFreq). Independently re-verified here (A0/28.108 Hz/
  +37.9 cents on a real frame set). **These are ABSOLUTE float32, not [0,1].**
- **`main_output 0x002a/0x0016(L),0x0017(R)` — shape pinned:** normalized
  float32 [0,1] stereo output meter (L/R r=0.999, max ~0.59). dB reference not
  pinned (passive audio correlation too weak). Left as labelled candidates.
- **`volpan 0x0066/0x0014` — partial:** only ~12 discrete values, mostly zero —
  a discrete state/position indicator, not a continuous meter. Deferred.

### PROMOTED to code (2026-07-06)
- `src/am4/tuner.ts` (new): `decodeAm4Tuner`, `am4TunerNoteName`, channel
  constants, `isAm4TunerChannel`. Test `test/am4/tuner.test.ts` (real frames).
- `src/am4/livePolls.ts`: renamed tuner candidates → `tuner.{note_index,freq_hz,
  cents,string_band}` @ `capture-decoded-value`; `main_output.{level_l,level_r}`
  @ `capture-confirmed-address` ([0,1] meter); `volpan.meter_candidate` note.
- Added `capture-decoded-value` confidence tier. All 43 suites pass; build clean;
  ForgeFX typechecks.

### Later (not this session)
- `main_output` [0,1]→dB curve, `volpan` semantics, tuner ch4 literal string-map:
  need a scripted hardware capture (ramp input gain / play known pitch) or the
  `_2p0` cache (NOT on disk — would need locating from an older AM4-Edit build).
- Gain monitors (`ingate`/`compressor`) stay at the heuristic `knob_0_10` 0..10
  (range-consistent with the observed [0,1]); true dB unconfirmed.
- Rewrite the stale roadmap negative `ROADMAP-full-api.md:72` ("AM4 live metering: wire-confirmed absent").
- ForgeFX side: surface the AM4 tuner (values pinned). Meters wait on the dB curve. Driver telemetry flags stay `false` until wired.

## Conventions
- No AI attribution in commits. Rebuild forgefx-midi (`npm run build`) after codec
  changes so ForgeFX's symlinked `dist/` sees them. Keep the
  `capture-confirmed-address` vs `capture-correlated-candidate` tiers.
