# Editing-Catalog Coverage — per-device status & implementation checklist

**What editing data (params, ranges, type rosters, enum vocab, layouts, FC/modifier)
this package actually holds for each device, what is missing, and whether closing a
gap needs *editor RE* (mine an editor install — no user hardware) or a *hardware
capture* (needs a user's device).**

This is the companion to [`DEVICE-TELEMETRY.md`](./DEVICE-TELEMETRY.md): that doc
covers device→editor *streaming* (meters/tuner/looper/RTA); **this** doc covers the
static *editing catalog*. Treat it as the implementation checklist — keep it updated
as gaps close so we never re-research the same status.

Scope: gen-3+ only — **Axe-Fx III `0x10`, FM3 `0x11`, FM9 `0x12`, VP4 `0x14`, AM4 `0x15`**.
Gen-1 (`0x01`) and Axe-Fx II (`0x07`) are out of scope.

All counts verified **2026-07-05** from the generated `catalog/*.json` (authoritative;
regenerate with `npm run catalog:export`, verify with `npm run catalog:check`) plus the
TS calibration/profile modules. Re-verify counts after any catalog regen.

---

## Data categories & provenance

| Category | Meaning | How a gap is closed |
|---|---|---|
| **Params** | paramId + name + label + unit (wire addressing) | **Editor RE** |
| **Ranges** | display min/max + taper (so a knob reads "2.5 kHz", not a raw position) | **Editor RE** |
| **Type rosters** | the sub-model list *inside* a block (Phaser → "Script 45"…) | **Editor RE** |
| **Enum vocab** | labels for non-type enums (modes, LFO shapes, tempo subdivisions, mic/cab picks) | **Editor RE** |
| **Layouts** | editor page organization (which controls, which page) | **Editor RE** |
| **FC / Modifier** | foot-controller + modifier address models | **Editor RE** (some source enums capture-confirmed) |
| **Cab IR names** | IR bank contents | **Live device read** (per-unit) or capture |
| **Offline body calibration** | param-array offset + per-channel stride + value scaling to decode params out of a **stored preset blob with no device attached** | **Hardware capture** (needs real preset dumps as ground truth) |

### Two traps (carried from CATALOG-SCHEMA.md)
1. **paramIds are device-specific.** Never reuse one gen-3 device's paramIds on another.
2. **Block effect IDs are family-shared** (ship once in `axe-fx-iii.json` `AXE_FX_III_BLOCKS`).
   The *type rosters* above are the per-device sub-model lists, **not** the shared effect-id table.

### Critical distinction — live editing vs. offline decode
- **Live block editing works on ALL gen-3 today.** ForgeFX `gen3.blockParams()` reads the
  connected device via the fn-0x1F bulk read and applies the profile's ranges/enums. It is
  **not** gated by calibration.
- **Offline preset-body decode is FM3-only** (`readBlockParamsForModel`, gated to model `0x11`).
  It powers the **preset-library "search by model" index** (`modelsFromBlocks`) — decoding which
  models a stored `.syx` uses *without loading it*. For III/FM9/VP4 that index is empty. **This does
  not affect editing.** So body-calibration captures are lower priority than the editor-RE gaps.

---

## Master matrix

Legend: ✅ complete · 🟡 partial · ⚠️ sparse/stub · ⛔ absent

| | III `0x10` | FM3 `0x11` | FM9 `0x12` | VP4 `0x14` | AM4 `0x15` |
|---|---|---|---|---|---|
| Families / params | 48 / 2216 | 47 / 2021 | 47 / 2052 | 48 / 1690 | 20 / 909 |
| Params present | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ranges (display calib.) | 🟡 333 inline | ✅ 1831 (~91%) | ✅ 1891 (~92%) | ⛔ 0 | ✅ 909 (100%) |
| Type rosters | 🟡 11 fam | ✅ all fam¹ | ⚠️ 3 fam² | ⛔ 0 | ✅ 17 |
| Enum vocab (non-type) | ⚠️ ~21 params | ✅ 471 entries | ⛔ 0 | ⛔ 0 | ✅ 220 params |
| Editor layouts | ✅ 48 | ✅ 47 | ✅ 47 | ⛔ | (own UI) |
| FC + Modifier | ✅ | ✅ | ✅ | ⛔ | ⛔ |
| Cab IR names | live-only | ✅ bundled | ⛔ | ⛔ | n/a |
| Live editing | ✅ | ✅ | ✅ | ✅ (reads + cont. writes) | ✅ (own codec) |
| Offline body calibration | ⛔ | ✅ only device | ⛔ | ⛔ | ✅ (own codec) |
| Telemetry | see DEVICE-TELEMETRY.md | ✅ | ✅ | ⛔ | ⛔ |

¹ FM3: 8 explicit slug rosters (amp/cab/comp/delay/drive/geq/reverb/wah — with manufacturer/basedOn
lineage) **+** enum-override fallback for every other `<FAMILY>_TYPE` family (wired in ForgeFX
`fm3RosterFor`, 2026-07-05). All type families resolve.
² FM9 real rosters: DISTORT (331), FUZZ (86), REVERB (79). FILTER is a **1-entry stub** → redo.

---

## Axe-Fx III `0x10` — mostly complete; gaps are cosmetic

**Support:** community-beta (decoded; community hardware confirmations).
**Present:** all 2216 params (48 families); 11 type rosters from `GEN3_READ_ROSTERS`; full editor
layouts (48); FC + modifier models; per-block monitor table; live editing.

**Editor-RE gaps** (mine from Axe-Fx III-Edit; no user hardware):
- [ ] **Display ranges** — only **333/2216** params carry explicit `displayMin/Max`. The rest fall
      back to the classic **0–10 knob** (correct for natively-0–10 params; imprecise only for the
      real-unit subset: ~42 dB, 27 Hz, 17 ms, 88 percent, 107 bipolar-percent). Fill engineering-unit
      min/max. *Impact: cosmetic (units), not broken.*
- [ ] **Enum vocab** — the TS overlay (`enumOverlay.ts`) labels only ~21 enum params; most non-type
      enums render as raw ordinals. Mine the full III enum overlay.
- [ ] **Type rosters** missing for 10 families: `DYNDIST, ENHANCER, GATE, GEQ, INPUT, MEGATAP, PITCH,
      RINGMOD, TENTAP, VOLUME`. (Have: CHORUS 17, COMP 16, DELAY 24, DISTORT 284, FILTER 10, FLANGER 21,
      FUZZ 58, PHASER 14, REVERB 59, TREMOLO 6, WAH 7.)
- [ ] Ranges: zero-calib families `FC, INPUT, IRCAPTURE, MIDIBLOCK, MOD, PRESET`.

**Capture gaps** (low priority — editing already works):
- [ ] Offline preset-body calibration (unlocks library search-by-model only).
- [ ] Cab IR names — read live from the unit today; bundling optional.

---

## FM3 `0x11` — the reference device; near-complete

**Support:** community-beta (device-true; discrete set-by-name + striped read hardware-confirmed).
**Present:** 2021 params (47 families); ranges ~91% (1831); **all** type families resolve (8 explicit
slug rosters + enum-override fallback); rich enum vocab (471 override entries); editor layouts (47);
FC + modifier; **bundled cab IR names**; monitor table; **only device with offline body calibration**;
live editing.

**Editor-RE gaps** (minor):
- [ ] Ranges — zero-calib utility families: `CROSSOVER, FC, IRCAPTURE, IRPLAYER, MIDIBLOCK, RTA,
      TONEMATCH, VOCODER`.
- [ ] Ranges — partials: `CONTROLLERS 130/141, FLANGER 33/55, GEQ 20/21, PRESET 50/51, TENTAP 48/49`.

**Capture gaps:** none outstanding for editing. (Telemetry items tracked in DEVICE-TELEMETRY.md.)

---

## FM9 `0x12` — highest-impact backlog (user-visible)

**Support:** community-beta (decoded from FM9-Edit cache + community captures).
**Present:** 2052 params (47 families); ranges ~92% (1891); editor layouts (47); FC + modifier;
monitor table; live editing works.

**Editor-RE gaps** (mine from FM9-Edit cache — no user hardware; **do these first**):
- [ ] **Enum vocab — ENTIRELY MISSING.** `FM9_ENUM_OVERRIDES` has only **5 entries** (the `*_TYPE`
      keys). Every non-type enum (modes, LFO waveforms, tempo subdivisions, mic/cab pickers, slopes)
      renders as a raw ordinal `#0/#1/…`. **This is the gap FM9 users will notice.**
- [ ] **Type rosters** missing for **16 families**: `CHORUS, COMP, DELAY, ENHANCER, FLANGER, GATE,
      GEQ, INPUT, MEGATAP, PHASER, PITCH, RINGMOD, TENTAP, TREMOLO, VOLUME, WAH`.
- [ ] **FILTER roster is a 1-entry stub** → recapture/refill.
      (Real rosters today: DISTORT 331, FUZZ 86, REVERB 79.)
- [ ] Ranges — zero-calib families: `FC, IRCAPTURE, IRPLAYER, MIDIBLOCK, RTA, TONEMATCH, VOCODER`;
      partials `CABINET 106/122, CONTROLLERS 130/141, GEQ 20/21, PRESET 50/51, TENTAP 48/49`.

**Capture gaps** (lower priority):
- [ ] Cab IR bank names (none bundled — wire live-read or capture).
- [ ] Offline preset-body calibration (`paramArrayBase` / `ampChannelStride` / value-scale) — library
      search-by-model only; not needed for editing.

---

## VP4 `0x14` — params-only skeleton; needs a full editor-RE pass

**Support:** community-beta (reads + continuous-knob writes decoded from captures; display
calibration pending — wire values pass through raw 0..65534).
**Present:** 1690 params (48 families) = wire addressing only. Reads + continuous-knob writes work.

**Editor-RE gaps** (everything display-side — largest single-device effort; mine from VP4-Edit):
- [ ] **Ranges** — NONE (0 families). Every knob passes raw 0..65534.
- [ ] **Type rosters** — NONE (21 `<FAMILY>_TYPE` families empty).
- [ ] **Enum vocab** — NONE.
- [ ] **Editor layouts** — NONE.
- [ ] **FC + Modifier models** — NONE.

**Capture gaps:**
- [ ] Offline preset-body calibration (library search-by-model only).

---

## AM4 `0x15` — separate codec; editing catalog complete

**Support:** hardware-verified. Own codec + device path (not gen-3 shared).
**Present:** 909 params across 20 blocks; **100% display calibration** (909/909 have min/max); 17 type
rosters (`enums.*_VALUES`); 220 params with inline enum values; `BLOCK_TYPE_VALUES` (18). Editing is
complete.

**Gaps** — telemetry only (not editing):
- [ ] No meters/tuner/cpu/looper/RTA. `GET_METER` is wire-confirmed dead (zero-variance probe). AM4
      metering is human-in-the-loop. See DEVICE-TELEMETRY.md.

---

## Consolidated backlog (priority order)

**Editor RE — no user hardware needed (do these first):**
1. **FM9 enum vocab** — mine full `FM9_ENUM_OVERRIDES` from FM9-Edit. *Most user-visible fix.*
2. **FM9 type rosters** — 16 families + FILTER stub.
3. **VP4 full display-side pass** — ranges, type rosters, enum vocab, layouts, FC/modifier from VP4-Edit.
4. **III enum vocab** + engineering-unit ranges (cosmetic but broad).
5. **III / remaining type rosters** (10 families).
6. **FM3 utility-family ranges** (low priority).

**Hardware captures — need a user's device (lower priority; editing already works without them):**
1. Offline preset-body calibration for FM9, III, VP4 (unlocks library *search-by-model*, not editing).
2. Cab IR bank names for FM9 (and optionally III bundling).
3. Telemetry wire shapes — see [`DEVICE-TELEMETRY.md`](./DEVICE-TELEMETRY.md).

---

### How to re-verify this doc
```
npm run catalog:export   # regenerate catalog/*.json from src
npm run catalog:check    # assert catalog matches src
```
Counts here come from `catalog/{axe-fx-iii,fm3,fm9,vp4,am4}.json` `data.*` keys + the TS modules
`src/devices/gen3/blockParams.ts` (VERIFIED_MODELS), `src/gen3/*/layouts.generated.ts`,
`src/gen3/*/{footController,modifiers}.ts`, and ForgeFX `server/src/devices.ts` (profile wiring).
