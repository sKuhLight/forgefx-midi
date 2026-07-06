# AM4 B1 — cache-join pass (value scaling from editor definitions cache)

Problem B1 of the AM4 live-value decode effort
([`AM4-LIVE-VALUE-DECODE-PLAN.md`](./AM4-LIVE-VALUE-DECODE-PLAN.md)):
pin the value **scaling** of the AM4 live-poll addresses deterministically
from the editor definitions cache, **without hardware**.

No shipped source was edited. This is a findings + proposed-entries document only.

---

## 0. How the join actually works (this is the load-bearing finding)

The plan hints "map `(pidLow,pidHigh)` → cacheId → typecode/min/max/step". The
real mechanics, verified against the shipped catalog, are:

1. **Within a block, `wire pidHigh == cache_id`.** Proven from the shipped
   catalog's own inline notes: `compressor.look_ahead_time` (pidHigh `0x15`=21)
   is annotated "Cache id=21"; `emphasis` (`0x17`=23) → "Cache id=23";
   `input_level` (`0x19`=25) → id=25; `sidechain_q` (`0x1d`=29) → id=29;
   `sidechain_filter_type` (`0x20`=32) → id=32; `drive` (`0x29`=41) → id=41.
   Every one of these lands on the matching `id` in
   `cache-section2.json`, with byte-matching ranges. Same rule holds for volpan
   against `variantResolverTables.ts` (VOLUME_ATTACK→17 = pidHigh `0x11`, etc.).

2. **`cache-section2.json` groups records into blocks by a `blockHeader`
   record carrying a `blockTag`.** The `blockTag` is a **cache-internal category
   index, NOT the wire pidLow.** In `effectDefinitions_15_66p1.cache` the six
   headers are:

   | section2 `block` | `blockTag` | identity (from enum contents) | shipped wire pidLow |
   |---|---|---|---|
   | 0 | (no header) | global / LFO / sequencer / controllers | — (global 0x01 family) |
   | 1 | 35 (0x23) | **modifier / control** (SRC1±SRC2, EXPONENTIAL/LINEAR, CHAN A–D) | 0x23 (see §2) |
   | 2 | 42 (0x2a) | **compressor** (id19 = compressor-type list) | **0x2e** |
   | 3 | 23 (0x17) | GEQ (id20 = "10 Band Constant Q") | 0x32 |
   | 4 | 37 (0x25) | 5-band PEQ (5 freq / 5 Q / 5 gain ±20 / 5 filter-type) | 0x36 |
   | 5 | 152 (0x98) | amp (id10 = amp models, id75 = power tubes) | 0x3a |
   | 6 | 79 (0x4f) | cab (cab/mic enums) | 0x3e |

   The `blockTag` numbering is *not* the wire pidLow (blockTag 0x2a is the
   compressor here, whereas the wire compressor is 0x2e and wire 0x2a is the
   preset/Main-Levels family). Blocks are identified by their **enum payloads**,
   then joined by `id == pidHigh`.

3. **Record grammar** (cache-oracle, per `cacheOracleParams.generated.ts`
   header): float records carry `a,b,c,d = (min, max, scale, step)`;
   **display = wire × scale**, wire ∈ [0,1]. In `cache-records.json`
   (section 1, the global/system params) the equivalent fields are already
   named `min,max,step`. `typecode` taper: `log10` only for the
   hardware-confirmed set `{0x40,0x44,0x48,0x50}`; everything else linear.

4. **`cache-section1` (`cache-records.json`) is the GLOBAL/system param space**,
   keyed directly by the resolver's `cache_id` (effectType 1). e.g. id 13 =
   `GLOBAL_TUNINGREF` {430..450}, ids 17–22 = `GLOBAL_OFFSET1..6` (±25,
   typecode 55). This is a separate id space from the per-block section-2 ids.

### Snapshot coverage limit

`effectDefinitions_15_66p1.cache` is a **partial, preset-specific snapshot**: it
contains only the blocks loaded in that preset (modifier, compressor, GEQ, PEQ,
amp, cab + globals). **ingate (wire 0x25), preset/Main-Levels (wire 0x2a), wah
(wire 0x5e), volpan (wire 0x66), and the pitch-tuner readout are NOT present in
this snapshot.** Their scaling can only be pinned from (a) the resolver +
symbolic-name semantics, or (b) the older `_2p0` cache the shipped catalog was
built from, or (c) B2 audio correlation. This is called out per address below.

---

## 1. Per-address table

Legend for confidence: **pinned** = cache record present, range read directly;
**partial** = block/semantics identified (resolver or content match) but the
range record is degenerate or outside this snapshot; **cache-silent** = the
cache defines no display range (meter with a=b=c=0), a B2 job.

| address (pidLow/pidHigh) | block (wire) | param-index / cache_id | section2 block · id / section1 id | typecode | cache min/max/scale(step) | proposed unit + displayMin/Max + scaling | confidence | notes |
|---|---|---|---|---|---|---|---|---|
| **0x0025/0x0010** `ingate.gain_monitor` | ingate 0x25 | pidHigh 0x10 = id 16 | not in 66p1 snapshot | — | — | keep shipped `knob_0_10` 0..10 | cache-silent (this snapshot) | Ingate block absent from 66p1. Shipped 0..10 is a meter heuristic; degenerate-range expected (see compressor monitor). B2 or `_2p0` cache to confirm. |
| **0x002e/0x001f** `compressor.gain_monitor` | compressor 0x2e | pidHigh 0x1f = **id 31** | section2 block 2 · id 31 | 0 | **a=0 b=0 c=0** (degenerate) | keep shipped `knob_0_10` 0..10 | **cache-silent** | Record PRESENT but zero-range — it is a read-only meter with no cache display range. Shipped 0..10 is a heuristic, NOT cache-backed. Sibling `0x2e/0x22` (id 34, the capture's "unassigned") is also degenerate 0,0,0. |
| **0x005e/0x000f** `wah.wah_control` | wah 0x5e | pidHigh 0x0f = id 15 | not in 66p1 snapshot | — | — | keep shipped `knob_0_10` 0..10 | partial (semantics pinned) | Wah block absent from 66p1. `WAH_CONTROL` is the pedal-position control (0..10), not a meter; shipped 0..10 is consistent with all other wah knobs. `_2p0` cache would give the record. |
| **0x0023/0x0001** tuner cand. 1 | **modifier/control 0x23** | pidHigh 0x01 = id 1 | section2 block 1 · id 1 | 0 | a=0 b=1 c=10 (step 0.001) | `knob_0_10` 0..10 linear | partial | Block 0x23 is the **modifier/controller** block, not the pitch tuner (enums = SRC1±SRC2, EXPONENTIAL/LINEAR, modifier sources). ids 1–9 are all identical generic 0..10 float slots. Range is cache-real; per-slot *meaning* (which live value) is unproven → B2. |
| **0x0023/0x0002** tuner cand. 2 | modifier/control 0x23 | pidHigh 0x02 = id 2 | section2 block 1 · id 2 | 0 | a=0 b=1 c=10 (0.001) | `knob_0_10` 0..10 linear | partial | Same generic 0..10 slot. |
| **0x0023/0x0003** tuner cand. 3 | modifier/control 0x23 | pidHigh 0x03 = id 3 | section2 block 1 · id 3 | 0 | a=0 b=1 c=10 (0.001) | `knob_0_10` 0..10 linear | partial | Same generic 0..10 slot. |
| **0x0023/0x0004** tuner cand. 4 | modifier/control 0x23 | pidHigh 0x04 = id 4 | section2 block 1 · id 4 | 0 | a=0 b=1 c=10 (0.001) | `knob_0_10` 0..10 linear | partial | Same generic 0..10 slot. |
| **0x002a/0x0016** main_output cand. 1 | preset / Main-Levels 0x2a | pidHigh 0x16 = 22 | not resolvable in 66p1 | — | — | UNKNOWN | cache-silent | Wire 0x2a is the preset/Main-Levels family (shipped `preset.*`). pidHigh 0x16/0x17 (22/23) are unregistered there; sit just before `preset.scene_1_level` (0x18). No per-cache_id record locatable — likely output level meters. → B2. |
| **0x002a/0x0017** main_output cand. 2 | preset / Main-Levels 0x2a | pidHigh 0x17 = 23 | not resolvable in 66p1 | — | — | UNKNOWN | cache-silent | As above; second channel of the same meter pair. → B2. |
| **0x0066/0x0014** volpan cand. | volpan 0x66 | pidHigh 0x14 = **cache_id 20 = `VOLUME_METER`** | not in 66p1 snapshot; resolver-pinned | — | — | meter (level/gain-reduction); range UNKNOWN | **partial (semantics PINNED)** | `variantResolverTables.ts`: `VOLUME_METER → [20]`, and pidHigh 0x14 = 20 exactly. `symbolicIds.ts` volpan list contains `VOLUME_METER`. So this is a **read-only meter**, NOT a settable param. Scaling not in 66p1 → B2 (or `_2p0` cache). Do NOT ship as a settable knob. |

---

## 2. VALIDATION of the three already-scaled monitors against the cache

| monitor | shipped catalog | cache record found? | verdict |
|---|---|---|---|
| `ingate.gain_monitor` 0x25/0x10, `knob_0_10` 0..10 | 0..10 | ingate block **absent** from 66p1 | Cannot validate against this snapshot. Shipped range is a meter heuristic, not cache-anchored. |
| `compressor.gain_monitor` 0x2e/0x1f, `knob_0_10` 0..10 | 0..10 | **YES** — section2 block 2 id 31 = **a=0,b=0,c=0** | Cache displayMin/Max do **NOT** match: cache says degenerate (no range). The shipped 0..10 is a heuristic for a meter the cache leaves unscaled. Not a contradiction of a real range — the cache simply has none. |
| `wah.wah_control` 0x5e/0x0f, `knob_0_10` 0..10 | 0..10 | wah block **absent** from 66p1 | Cannot validate here. `WAH_CONTROL` is a pedal-position control (not a meter); 0..10 is consistent with every sibling wah knob. |

**Key validation takeaway:** the only one of the three whose record is in this
snapshot (`compressor.gain_monitor`) confirms these gain-monitor addresses are
**meters with a degenerate (zero) cache range**. The shipped `knob_0_10` 0..10
values are display heuristics, not cache-derived scaling. This is expected for
live meters and means their true scaling is a **B2 audio-correlation job**, not
a B1 cache lookup. (The plan's Problem-A "scaling already catalogued" is true as
a heuristic; it is not cache-anchored.)

---

## 3. Proposed KNOWN_PARAMS TS entries (for review)

Only entries with a **cache-real range** are proposed. The tuner-cluster
addresses have a real 0..10 cache range but unproven per-slot *meaning*, so they
are proposed as candidates (read-only), clearly flagged. The meters (compressor/
ingate/main_output/volpan) are intentionally **not** proposed here — their
scaling is cache-silent and belongs to B2.

```ts
// ── Modifier / control block (wire pidLow=0x0023) ──
// NOTE: wire 0x23 is the MODIFIER/CONTROL block (not the pitch tuner).
// Cache (effectDefinitions_15_66p1, section2 block 1) gives ids 1..4 an
// identical generic 0..10 float range (a=0 b=1 c=10, step 0.001 → knob_0_10).
// The RANGE is cache-real; which live value each slot carries during the
// Tempo/Tuner capture window is unproven (B2). Expose read-only if surfaced.
'control.live_slot_1': { block: 'control', name: 'live_slot_1', pidLow: 0x0023, pidHigh: 0x0001, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
'control.live_slot_2': { block: 'control', name: 'live_slot_2', pidLow: 0x0023, pidHigh: 0x0002, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
'control.live_slot_3': { block: 'control', name: 'live_slot_3', pidLow: 0x0023, pidHigh: 0x0003, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
'control.live_slot_4': { block: 'control', name: 'live_slot_4', pidLow: 0x0023, pidHigh: 0x0004, unit: 'knob_0_10', displayMin: 0, displayMax: 10 },
```

For the volpan meter, the *identity* is pinned even though the range is not.
Recommended as a **labelled read-only meter** once B2 pins scaling:

```ts
// volpan VOLUME_METER — resolver-pinned (cache_id 20 == pidHigh 0x14).
// Read-only gain/level meter. Range NOT in the 66p1 snapshot → scaling from B2.
// Do NOT expose as a settable param.
// 'volpan.meter': { block: 'volpan', name: 'meter', pidLow: 0x0066, pidHigh: 0x0014, unit: /* B2 */, displayMin: /* B2 */, displayMax: /* B2 */ },
```

---

## 4. Needs-B2 list (cache can't resolve scaling)

- **`compressor.gain_monitor` 0x2e/0x1f** — record present but degenerate
  (a=0,b=0,c=0). Meter; true scaling unknown. Sibling `0x2e/0x22` (id 34,
  the capture's "unassigned") is also degenerate.
- **`ingate.gain_monitor` 0x25/0x10** — ingate block absent from 66p1; almost
  certainly the same degenerate-meter situation. Confirm via B2 or `_2p0` cache.
- **`main_output` 0x2a/0x0016 and 0x2a/0x0017** — preset/Main-Levels family;
  unregistered pidHighs with no locatable cache_id record. Likely output level
  meters. Pure B2.
- **`volpan` 0x66/0x14 (`VOLUME_METER`)** — identity PINNED (read-only meter),
  scaling absent from 66p1 snapshot. B2 (or the `_2p0` cache) for the range.
- **tuner-cluster 0x23/0x0001..0x0004** — range pinned (0..10 knob) but the
  per-slot semantic (which live control/tuner value) needs B2 to confirm what
  each slot reports during the Tempo/Tuner window.

## 5. Follow-up that would improve B1 without hardware

Re-run the cache parser against the **`effectDefinitions_15_2p0.cache`** (the
one the shipped catalog was generated from) instead of the partial `66p1`
snapshot. That cache should contain the ingate, wah, volpan, and preset blocks
absent here, letting `VOLUME_METER` and the ingate/wah monitors be range-checked
directly by the same `id == pidHigh` join proven above.
