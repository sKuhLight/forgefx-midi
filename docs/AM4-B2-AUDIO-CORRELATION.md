# AM4 Problem B2 — audio-correlation pass (2026-07-06)

Pin the **VALUE scaling / semantics** of the unknown AM4 live-poll addresses by
extracting their per-address value time-series from BigCapture and correlating
against the reference audio, within the plan windows. Follow-on from
[`AM4-LIVE-VALUE-DECODE-PLAN.md`](./AM4-LIVE-VALUE-DECODE-PLAN.md) (Problem B, track B2)
and [`AM4-CAPTURE-2026-07-05.md`](./AM4-CAPTURE-2026-07-05.md).

Targets: tuner `0x0023/0x0001..0004`, main_output `0x002a/0x0016..0017`,
volpan `0x0066/0x0014`. Anchors (already solved): `ingate.gain_monitor`
`0x0025/0x0010`, `compressor.gain_monitor` `0x002e/0x001f`.

## TL;DR verdicts

| Address | Semantics | Scaling | Verdict |
|---|---|---|---|
| `0x0023/0x0001` tuner ch1 | **nearest-note index** = MIDI_note − 9 (note 0 = A0) | float32, **direct integer value** (NOT [0,1]) | **PINNED** |
| `0x0023/0x0002` tuner ch2 | **detected fundamental frequency, Hz** | float32, **direct Hz** (NOT [0,1]) | **PINNED** |
| `0x0023/0x0003` tuner ch3 | **cents deviation** from nearest note | float32, **direct signed cents** (±50) | **PINNED** |
| `0x0023/0x0004` tuner ch4 | **string / octave-band index 0–5** (0 = highest pitch, 5 = lowest) | float32, direct integer 0..5 | **PINNED (index confirmed; exact string map is non-standard — see notes)** |
| `0x002a/0x0016` main_output L | **output level meter, LEFT** of a stereo pair | float32 in **[0,1]** (like gain monitors) | **PINNED shape; dB reference NOT pinned** |
| `0x002a/0x0017` main_output R | **output level meter, RIGHT** (r=0.999 vs L) | float32 in **[0,1]** | **PINNED shape; dB reference NOT pinned** |
| `0x0066/0x0014` volpan | **discrete state/position indicator** (12 levels), NOT a continuous meter | float32 in [0,1], but quantised | **PARTIAL — needs fresh scripted capture** |

The single most important B2 result: **the four tuner channels are self-proving.**
They are NOT `float32∈[0,1]` normalized meters — they carry their quantities
*directly*. ch2 (Hz) → nearest MIDI note (ch1) and cents (ch3) are internally
consistent to within a few cents, so no external audio reference is needed to
trust them.

---

## Method

### 1. Extraction (full capture, not a slice)
`capinfos` showed BigCapture is only **9,586 USB bulk packets** over 1546.2 s
(each packet batches many 4-byte USB-MIDI events → 482,866 SysEx messages), so a
full extraction was cheap — no `editcap`/`-Y` slicing was needed.

```
python3 fm3-scratchpad/devices/am4/decompile/extract_usbmidi_sysex.py \
    "/home/pascal/Downloads/BigCapture/MISTER MEAL.pcapng" \
    -o <scratch>/bigcapture.sysex.txt
```
Result: 482,866 messages, 70 MB, 4-col `DIR<TAB>frame<TAB>time_relative<TAB>hex`,
midi addr auto-detected `1.44.2`. Runtime ~69 s, ~few-hundred-MB RSS.
SysEx traffic begins at t≈10.5 s (relative to first packet).

### 2. Decode with the SHIPPED codec
```
npx tsx scripts/_research/am4-live-decode.ts \
    <scratch>/bigcapture.sysex.txt -o <scratch>/bigcapture.decoded.csv --include-unknown
```
Result: **33,930 value rows, 0 unparseable.** All target addresses present:
tuner 0x0023/0x0001..4 (709 each), main_output 0x002a/16,17 (1247 each),
volpan 0x0066/0x0014 (433). Anchors: `ingate.gain_monitor` 1426, `compressor.gain_monitor` 2508.

### 3. Per-address windowed stats (`analyze.py`)
Sliced each address to its plan window; computed min/max/mean/std, unique-value
count, on both the `rawFloat` and `rawUInt32` interpretations.

### 4. Audio envelope + pitch
`ffmpeg` → mono 8 kHz f32 PCM (1564.4 s, matches capture 1546 s). RMS envelope at
10 Hz (`numpy`). Autocorrelation-based f0 for the tuner window. (No `scipy`/`librosa`
installed; `numpy`+`ffmpeg` sufficed.)

**Caveat on audio alignment:** the mic recording and the pcap have an unknown
start offset, and the mic captured the full processed band mix (amp + effects),
not the clean tuner DI. An anchor cross-correlation (ingate.gain_monitor vs RMS)
returned only r≈0.02, and the float-meter offset sweeps disagreed (+60 s vs −25 s),
so **absolute audio↔capture time alignment could not be fixed**. This does not
block the tuner (self-consistent) but does prevent pinning the main_output dB
reference. See "What remains".

---

## Per-address detail

### Tuner `0x0023/0x0001..0004` — PINNED (window 180–300 s, actual 203–297 s, 709 samples each)

Sampled together in bursts. Interpreting the 4 raw float32 payloads **directly**
(not ÷1 into [0,1]):

| ch | address | range (float32) | uniq | interpretation |
|---|---|---|---|---|
| 1 | `0x0023/0x0001` | 9.0 … 58.0 (integers) | 35 | nearest-note index = **MIDI − 9** |
| 2 | `0x0023/0x0002` | 23.4 … 381.6 | 413 | **frequency in Hz** (guitar range) |
| 3 | `0x0023/0x0003` | −47.7 … +37.9 | 442 | **cents** deviation (signed, ±50) |
| 4 | `0x0023/0x0004` | 0 … 5 (integers) | 6 | **string / octave-band index 0–5** |

**Internal proof (needs no audio):**
- Nearest MIDI note of ch2's Hz value equals `ch1 + 9` in **99.0 %** of samples
  (`midi(ch2) − ch1` is exactly 9 for 702/709; the 7 outliers are transients).
  ⇒ ch1 is a semitone index where index 0 = MIDI 9 = **A0**.
- ch3 tracks the cents-offset computed from ch2's Hz: `corr = 0.873`,
  mean |ch3 − cents_from_Hz| = 4.2 cents. (Divergences occur only where the note
  latch (ch1) and the raw frequency (ch2) update on different transient frames.)
- ch4 index is monotonic in pitch: index 0 median 329.7 Hz (highest), rising index
  → falling pitch, index 5 median 38.5 Hz (lowest).

Example rows:
```
 t       ch1  ch2(Hz)  nearest  note   ch3(cents)  cents_from_Hz  ch4
 213.69   55   329.65    64      E4       0.10        0.11          0
 219.01   31    82.46    40      E2       2.13        1.20          5
 234.94   53   289.55    62      D4     -23.79      -24.45          1
```

**Scaling verdict:** the tuner floats are **absolute engineering values**, decoded
as-is from `unpackFloat32LE` — do **not** apply the ×10 / [0,1] treatment used for
gain monitors. Recommended render: note name from ch1 (`MIDI = ch1 + 9`),
needle from ch3 (cents), optionally string highlight from ch4.

*Note on ch4:* the per-index notes (E4/C#4/G#3/E3/A2/A0) do not match a standard
EADGBE open-string set, so "string index" is confirmed as an ordinal 0–5 field but
its literal string-name mapping may be tuner-mode / tuning dependent, or it may be
an octave/confidence band. Flag as index-only; confirm mapping with a scripted
single-string capture if a string label is needed in the UI.

### main_output `0x002a/0x0016` (L) & `0x0017` (R) — PINNED shape, dB reference open (window 343–423 s)

- `float32 ∈ [0, 0.588]`, same shape as the gain monitors → a normalized **[0,1]
  level meter**.
- L vs R **corr = 0.999**, mean |L−R| = 0.0006 ⇒ a genuine **stereo pair**
  (0x0016 = left, 0x0017 = right).
- Nonzero only ~29 % of samples; when nonzero, continuous (288 unique values).
  It behaves as a **peak/output meter that reads 0 between transients**.
- Audio correlation is weak (best r≈0.33, and the offset is ambiguous), because of
  the unfixable audio↔capture alignment + processed-mix audio. Enough to say it
  **tracks signal presence** (peaks coincide with loud passages by eye in
  `plot_mainout.png`) but **not** enough to pin the exact 0→1 ⇔ dB curve.

**Verdict:** shape/semantics pinned (normalized [0,1] stereo output meter). The
mapping from the [0,1] float to a dBFS/dBu display needs either a B1 cache-join
(preferred) or a fresh scripted capture with a known-amplitude tone sweep.

### volpan `0x0066/0x0014` — PARTIAL (window 542–704 s)

- `float32 ∈ [0,1]` but **only 12 discrete values**
  (0, 0.00235, 0.0126, 0.091, 0.114, 0.128, 0.129, 0.352, 0.372, 0.798, 0.931, 1.0),
  nonzero only ~7 % of the time.
- That quantisation + sparsity is inconsistent with a continuous audio meter;
  audio correlation is weak (r≈0.35). Looks like a **discrete state / position or
  auto-swell-stage indicator**, not a live level.

**Verdict:** not an audio-level meter. Cannot pin semantics from passive
correlation. Needs a **fresh scripted capture** that deliberately drives the
Volume/Pan (or Auto-Swell) control through known positions while polling this
address, or a B1 cache-join, to assign it.

---

## Anchors (sanity check — behaved as expected)
- `ingate.gain_monitor` 0x0025/0x0010: float32 [0.15, 1.0], 1426 samples spanning
  the whole capture — continuous, per the known knob_0_10 unit.
- `compressor.gain_monitor` 0x002e/0x001f: float32 [0.03, 1.0], 2508 samples,
  densest in its 452–660 s compressor window. Both track continuously, confirming
  the float32 decode chain end-to-end on this capture.

---

## Artifacts (all in session scratchpad, NOT the repo)

`/tmp/claude-1000/-home-pascal-Dokumente-Repositorys-FractalAudio/c6471108-4fce-421c-8d01-560cd27f120d/scratchpad/`

- `bigcapture.sysex.txt` — full extraction (70 MB, 482,866 msgs, 4-col w/ time)
- `bigcapture.decoded.csv` — decoded value rows (33,930; the analysis input)
- `env_rms.npy`, `env_t.npy` — 10 Hz audio RMS envelope
- `analyze.py` — windowed per-address stats + anchor xcorr
- `tuner.py`, `tuner2.py` — tuner interpretation + internal-consistency proof
- `meters.py` — main_output / volpan correlation + stereo-pair check
- `plots.py` → `plot_tuner.png`, `plot_tuner_cents.png`, `plot_mainout.png`

## What remains
1. **main_output [0,1] → dB curve** — B1 cache-join (cacheId → typecode/min/max) is
   the clean route; else a scripted tone-sweep capture.
2. **volpan 0x0066/0x0014 semantics** — needs a scripted capture driving the
   control through known states, or B1.
3. **tuner ch4 literal string mapping** — index 0–5 confirmed; if a string *name*
   is needed, capture single plucked strings in a known tuning.
4. Absolute audio↔capture time offset is unresolved; a future capture should log a
   sync marker (e.g. a clap or a known param write at a noted timestamp) if audio
   correlation is to be relied on for level meters.
