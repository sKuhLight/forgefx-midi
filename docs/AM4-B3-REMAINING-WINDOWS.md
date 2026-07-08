# AM4 Problem B3 — remaining capture-plan windows (2026-07-08)

Follow-on from [`AM4-CAPTURE-2026-07-05.md`](./AM4-CAPTURE-2026-07-05.md) (initial
wire-shape survey) and [`AM4-B2-AUDIO-CORRELATION.md`](./AM4-B2-AUDIO-CORRELATION.md)
(tuner/main_output/volpan). Those two passes only covered the Meters and Tuner
sections of `/home/pascal/capture_plan.md`. This pass re-decodes the same
BigCapture (`MISTER MEAL.pcapng`, re-supplied as a duplicate download under
`BigCapture (1)/` — byte-identical, same 3,148,564,960-byte pcapng and
34,959,156-byte companion mp3) to close out the plan sections the earlier docs
listed as remaining gaps: Tempo/BPM, CPU, Footswitches, the two Expression/
Modifier stragglers (`0x0003/0x001c`, `0x0002/0x0056`), and Looper.

## Method

Re-ran the existing pipeline (`extract_usbmidi_sysex.py` → 482,866 messages,
identical to the 2026-07-05/06 runs, confirming the file is the same capture;
`scripts/_research/am4-live-decode.ts --include-unknown` → 33,930 poll-response
rows). Extended it with two throwaway scan scripts (not committed — deleted
after use) that read every `fn 0x01 PARAM_RW` message regardless of shape
(not just the 23-byte poll-response shape the shipped decoder targets), to
catch **SET_PARAM write echoes** (`action=0x0001`) and a suspected **UI
navigation marker** (see below).

## New finding: `action=0x0017` + `pidHigh=0x3e81` is a block-navigation marker

Every `action=0x0017` event in the whole capture (406 total) carries
`pidHigh=0x3e81` — a sentinel, not a real parameter ID — paired with a
`pidLow` that is the block being opened. These arrive in tight micro-bursts
(2-8 events within ~10ms) at the exact moment a block's live-poll traffic
starts, e.g.:

```
t=1252.93  pidLow=0x0003  pidHigh=0x3e81   <- Modifier 1 slot opened
...
t=1253.0   0x0003/0x001c poll traffic begins (2564 samples, 1253-1530s)
```

This reads as **"AM4-Edit just navigated to this block's editor page"** — a
UI page-transition marker independent of the ordinary parameter-poll traffic.
It gives exact plan-phase boundaries instead of inferring them from burst
density, and should be the primary tool for any future correlation pass
against this or a fresh capture. Notably `pidLow=0x0002` opens with a
**sequential burst covering `0x0002` through `0x0012`** (17 consecutive IDs)
three times (t=1314.9, 1338.5, 1353.9) — consistent with opening a modifier
panel that exposes ~17 sub-fields at once (source, min/max/start/mid/end/
slope, auto-engage, etc.) each time the panel is (re)opened.

## Tempo / BPM — confirmed via write traffic, no catalog gap

`global.tap_tempo_mode` (`0x0001/0x002e`) shows a real `action=0x0001` write
in `t=[180.3, 896.6]`, confirming the plan's "Change Tap Tempo Mode" step was
executed against the already-known catalog param. `global.tempo_cc`
(`0x0001/0x0048`, a MIDI CC# assignment, not a BPM value) has **zero hits** —
untouched. No distinct numeric BPM address was found anywhere in the capture;
AM4 tap-tempo appears to be tap/CC-driven only in this firmware, with no
separate settable BPM float, matching the absence of any such catalog param.
**Nothing to add** — this section was already fully covered by existing
`KNOWN_PARAMS`.

## Footswitches — confirmed via write traffic, no catalog gap

The 704-1232s span that the 2026-07-05 doc left unlabelled turned out to be
the Footswitch section, pinned by real `action=0x0001` writes to already-known
globals:

| param | address | write window |
|---|---|---|
| `global.fc_ring_bright_level` | `0x0001/0x0058` | 777.3-896.6s |
| `global.fc_ring_dim_level` | `0x0001/0x0059` | 777.3-896.6s |
| `global.startup_mode` | `0x0001/0x0089` | 777.3-896.6s |
| `global.presshold_mode` | `0x0001/0x0092` | 778.4-1231.8s |

`global.fs_press_hold1..4` (`0x0001/0x0084..0087`) are polled (`action=0x000d`
long-read) across the same window but show **no write** — expected, since the
plan's Footswitch section changes the *mode*, not the per-switch hold-duration
values. **Nothing to add** — fully covered by existing catalog.

## CPU — reconfirmed absent

No CPU-shaped address turned up anywhere in the full unfiltered re-decode,
including the previously-unlabelled 704-1232s gap (which is Footswitches, per
above, plus ordinary per-block long-read/type-descriptor background traffic —
`pidHigh` values like `0x07e6`, `0x07dd`, `0x003f`, `0x3e81` recurring across
every block). This reaffirms the 2026-07-05 "Telemetry Verdict": AM4-Edit
carries no CPU meter over `PARAM_RW`. Not actionable — no address exists to
catalog.

## Looper — reconfirmed absent

No unmapped block/pidLow appeared in the full per-address decode summary
beyond the ~15 already-known blocks (ingate, compressor, amp, delay, reverb,
gate, wah, volpan, preset/main-levels, global, tuner, the two modifier
pidLows, block-slot). No standalone looper function or channel exists in this
capture, on a second independent pass. Matches the 2026-07-05 finding.

## Expression / Modifier stragglers — resolved

- **`0x0003/0x001c` → `modifier.slot1_live_value` (PINNED shape).** Confirmed
  by the navigation marker to be inside the "Modifier 1" block (`pidLow=0x0003`,
  opened at t=1252.93, matching the first poll sample at t=1253.0). Float32
  `[0,1]`, 262 unique values over 2564 samples, continuous for the entire
  1253-1530s modifier test window — shape matches a pedal sweep test
  (heel/half/toe). Promoted to `AM4_LIVE_POLL_CANDIDATES` at
  `capture-confirmed-address` (same tier as `main_output`: shape pinned,
  exact knob/dB mapping open — it depends on whatever the modifier target is).
- **`0x0002/0x0056` — still a candidate, not fully pinned.** Active only in a
  narrow 1315-1338s sub-window right after the pedal sweep, float32
  `[0, 0.03]` with ~20 values — too small/quantised to be the pedal readout
  again. Time-coincides with the plan's "Try External 1 and Envelope as
  sources" step. Promoted at `capture-correlated-candidate` with semantics
  left open (envelope-follower or a second modifier slot's live value are
  both plausible).
- **`0x002e/0x0022` (compressor family, flagged unassigned since 2026-07-05)
  — re-scoped, still open.** Active across `[63, 933]s`, not compressor-window
  exclusive as first guessed — spans from baseline through the volpan window.
  Float32 range `[-0.24, 0.68]`, i.e. it can go negative, unlike
  `gain_monitor`'s `[0,1]` — ruling out a simple normalized-meter read.
  Promoted at `capture-correlated-candidate` with the corrected time range;
  semantics still unpinned.
- **`0x0001/0x0088` — investigated, dead end.** Polled throughout the whole
  tuner window (203-297s, 709 samples) but constant `0` the entire time — no
  variation to correlate against the plan's "Change calibration: 430 → 440 →
  450" step. Left unlabelled; a fresh scripted capture that actually changes
  calibration while watching this address is the only way to confirm or rule
  it out.
- **`0x0002/0x000b,000c,000d,000e,0x0042` — timing correlation only.** Five
  sibling addresses under the modifier-panel block, each read exactly 5 times
  in the same tight `[1338.6, 1357.0]s` window, always `0`. Coincides with the
  plan's "Turn Auto-Engage on/off... Remove the modifier" steps. No value
  semantics to pin (always zero) — noted here for future reference, not added
  to the candidate table.

## What remains (unchanged from B2, confirmed still open)

1. `main_output` `[0,1]` → dB curve — needs a B1 cache-join or a scripted
   tone-sweep capture.
2. `volpan` `0x0066/0x0014` semantics — needs a scripted capture.
3. `0x0001/0x0088` (tuner calibration?) and `0x002e/0x0022` (compressor
   family) — need a scripted capture that deliberately varies just that one
   control.
4. Tuner ch4 literal string-name mapping.
5. Action `0x0017` payload (beyond the `pidHigh=0x3e81` navigation-marker
   shape) and rare `0x0027`/`0x0028` variants remain unassigned — low value to
   chase further without a scripted, notated capture.

## Conventions

Same as [`AM4-LIVE-VALUE-DECODE-PLAN.md`](./AM4-LIVE-VALUE-DECODE-PLAN.md):
no AI attribution in commits; rebuild forgefx-midi after codec changes;
`capture-confirmed-address` vs `capture-correlated-candidate` tiers.
