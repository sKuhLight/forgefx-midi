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

All counts verified **2026-07-06** from the generated `catalog/*.json` (authoritative;
regenerate with `npm run catalog:export`, verify with `npm run catalog:check` — both
scripts now live in THIS package) plus the TS calibration/profile modules. Re-verify
counts after any catalog regen.

**2026-07-06 update:** community FM9 (`effectDefinitions_12_76p0`) and Axe-Fx III
(`effectDefinitions_10_32p6`) editor caches arrived and were mined end-to-end (strict
count-driven walker + seeded section voting, FM3 catalog as the validation oracle:
466/471 enum lists exact, ranges 1831/1831). This closed the FM9 + III enum-vocab,
type-roster, and display-range gaps below, and a cross-device "Devs Gift Of Tone"
preset pair calibrated OFFLINE BODY DECODE for FM9 + III (single-preset evidence).

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
- **Offline preset-body decode now covers FM3 + FM9 + III** (`readBlockParamsForModel`;
  VP4 still refused). It powers the **preset-library "search by model" index**
  (`modelsFromBlocks`). Evidence grades differ: FM3 is live-hardware calibrated (429-dump
  parity); FM9 + III are SINGLE-PRESET calibrated from the cross-device "Devs Gift Of
  Tone" pair (both bodies decode to the same models through each device's own tables;
  goldens in `test/gen3/{fm9,axe-fx-iii}/fixtures/`). Their `paramRegionFloor` is set
  tight-high (a too-low floor risks phantom headers), so an unusual preset may have
  blocks SKIPPED from the index until more dumps pin the true region start.

---

## Master matrix

Legend: ✅ complete · 🟡 partial · ⚠️ sparse/stub · ⛔ absent

| | III `0x10` | FM3 `0x11` | FM9 `0x12` | VP4 `0x14` | AM4 `0x15` |
|---|---|---|---|---|---|
| Families / params | 48 / 2216 | 47 / 2021 | 47 / 2052 | 48 / 1690 | 20 / 909 |
| Params present | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ranges (display calib.) | ✅ 2111 rows (1468 informative floats + 591 enums)¹ | ✅ 1831 (~91%) | ✅ 1902 rows (fw 76p0 regen)¹ | ⛔ 0 | ✅ 909 (100%) |
| Type rosters | ✅ all fam² | ✅ all fam² | ✅ all fam² | ⛔ 0 | ✅ 17 |
| Enum vocab (non-type) | ✅ 591 lists / 43 fam | ✅ 471 entries | ✅ 539 lists / 38 fam | ⛔ 0 | ✅ 220 params |
| Editor layouts | ✅ 48 | ✅ 47 | ✅ 47 | ⛔ | (own UI) |
| FC + Modifier | ✅ | ✅ | ✅ | ⛔ | ⛔ |
| Cab IR names | ✅ factory banks⁴ | ✅ bundled | ✅ factory banks⁴ | ⛔ | n/a |
| Live editing | ✅ | ✅ | ✅ | ✅ (reads + cont. writes) | ✅ (own codec) |
| Offline body calibration | ✅ single-preset³ | ✅ live-validated | ✅ single-preset³ | ⛔ | ✅ (own codec) |
| Telemetry | see DEVICE-TELEMETRY.md | ✅ | ✅ | ⛔ | ⛔ |

¹ Mined 2026-07-06 from each editor's own `effectDefinitions` cache (III `10_32p6`, FM9
`12_76p0`) by the strict count-driven walker; section→family assignment seeded from the
FM3 oracle-validated map. Placeholder rows (all-zero float rows mirroring unused wire
slots) are kept 1:1 for stride math; consumers filter them (`informativeDeviceRanges`).
Unmapped (no cache section / below voting floor): III `FC, IRCAPTURE, MIDIBLOCK`; FM9
`FC, IRCAPTURE, IRPLAYER, MIDIBLOCK, RTA, TONEMATCH, VOCODER`.
² Every `<FAMILY>_TYPE` family resolves from the device-true enum vocabulary
(`*_ENUM_OVERRIDES`, family → paramId → labels[], uniform shape across FM3/FM9/III).
The DELAY family's user-facing model selector is `DELAY_MODEL` (`DELAY_TYPE` is the
8-value MONO/STEREO routing enum — cache-confirmed on all three; FM3's old 22-entry
delay roster was the MEGATAP pattern list, mis-bound at generation, now fixed).
³ Cross-device "Devs Gift Of Tone" preset pair; goldens frozen in
`test/gen3/{fm9,axe-fx-iii}/fixtures/` + `modern-family/blockparams-cross.test.ts`.
⁴ `FM9_CAB_IRS` / `AXE3_CAB_IRS` (2026-07-06): FACTORY 1/2 (1024 each) + LEGACY (FM9 189,
III 199) from the cab-IR bank table records (0xfff0-0xfff2) of the same caches — validated
by reproducing `FM3_CAB_IRS` factory banks exactly from the FM3 cache. USER/SCRATCHPAD
banks are deliberately NOT bundled (community-donor per-device content). Axis calls
`/cab/irs?refresh=1` during its cache build so a device-true live reader can merge those
per-unit banks into the local IndexedDB cache; until that wire read is decoded, refresh
falls back to the bundled firmware banks without failing the picker.

---

## Axe-Fx III `0x10` — cache-mined 2026-07-06; near-complete

**Support:** community-beta (decoded; community hardware confirmations).
**Present:** all 2216 params (48 families); **complete device-true enum vocabulary**
(`AXE3_ENUM_OVERRIDES`, 591 lists / 43 families, fw 32.6 era — every type roster incl. the 10
previously-missing families, all modes/LFO/tempo/mic vocab); **device-true display ranges**
(`AXE3_RANGES`, 2111 rows, 1468 informative floats) wired through the descriptor factory AND the
ForgeFX profile (inline param bounds remain the fallback for cache placeholder rows); full editor
layouts (48); FC + modifier models; per-block monitor table; live editing; **offline body decode**
(single-preset calibration, see above).

**Remaining gaps:**
- [ ] Ranges/enum vocab for `FC, IRCAPTURE, MIDIBLOCK` (no cache section / below voting floor).
- [x] ~~Cab IR names~~ ✅ 2026-07-06 factory banks bundled (`AXE3_CAB_IRS`); user banks live-only.
- [ ] Offline-decode floor (`paramRegionFloor 0x1400`) is single-preset evidence — collect more
      III dumps to pin the true block-region start (a wrong-but-high floor only skips blocks).
- [ ] fw 32.6 renamed labels vs the legacy `GEN3_READ_ROSTERS`/overlay spellings (e.g.
      'Vibra-King') — the device-true list wins; the word-order-tolerant set-by-name resolver
      keeps old spellings usable.

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

**Fixed 2026-07-06:** the `delay` roster in `FM3_ROSTERS` was the 22-entry MEGATAP pattern list
(mis-bound at generation); it now carries the device-true 27-model `DELAY_MODEL` list. The DELAY
"type" resolution across the stack (offline decode `typeParamFor`, ForgeFX `#paramId`/rosters)
prefers `<FAM>_MODEL` over `<FAM>_TYPE`, and the exact `<FAM>_TYPE` name over the old
`unit==='enum' && /TYPE$/` heuristic — that heuristic silently bound the FM3/FM9 Drive block's
"type" to `FUZZ_CLIPTYPE` (pid 10) and Pitch to `PITCH_XFADETYPE` (the field-reported
drive-type bug).

**Capture gaps:** none outstanding for editing. (Telemetry items tracked in DEVICE-TELEMETRY.md.)

---

## FM9 `0x12` — cache-mined 2026-07-06; near-complete

**Support:** community-beta (decoded from FM9-Edit cache + community captures).
**Present:** 2052 params (47 families); **complete device-true enum vocabulary**
(`FM9_ENUM_OVERRIDES`, now FAMILY-shaped like FM3's: 539 lists / 38 families, fw 76p0 — every
former gap closed: the 16 missing type rosters, the FILTER 1-entry stub, all non-type enums);
ranges regenerated from the 76p0 cache (1902 rows; amp roster grew 331→336, drive 86→87);
editor layouts (47); FC + modifier; monitor table; live editing; **offline body decode**
(single-preset calibration, `ampChannelStride 0x122`).

**Remaining gaps:**
- [ ] Ranges/enum vocab for `FC, IRCAPTURE, IRPLAYER, MIDIBLOCK, RTA, TONEMATCH, VOCODER`
      (no cache section on the FM9).
- [x] ~~Cab IR bank names~~ ✅ 2026-07-06 factory banks bundled (`FM9_CAB_IRS`); user banks live-only.
- [ ] `DISTORT_DYNPRES/DYNDEPTH` (pids 90/91): the 76p0 cache carries tc=0 stub rows; the
      fw-11.0-mined ranges are kept for those two (flagged inline in ranges.generated.ts).
- [ ] Offline-decode floor (`paramRegionFloor 0x1e00`) is single-preset evidence — more dumps
      welcome (same caveat as the III).

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
- [ ] No surfaced meters/tuner/cpu/looper/RTA. BigCapture analysis (2026-07-05 capture, analyzed
      2026-07-06) confirms AM4-Edit uses `fn 0x01 PARAM_RW` poll variants, especially
      `action=0x0010`, rather than a gen-3 telemetry channel. The diagnostic decoder labels those
      shapes, but payload semantics are still unmapped. `GET_METER` remains wire-confirmed dead.
      See [`AM4-CAPTURE-2026-07-05.md`](./AM4-CAPTURE-2026-07-05.md) and DEVICE-TELEMETRY.md.

---

## Consolidated backlog (priority order)

**Editor RE — no user hardware needed (do these first):**
1. ~~FM9 enum vocab~~ ✅ 2026-07-06 (539 lists from the 76p0 cache).
2. ~~FM9 type rosters~~ ✅ 2026-07-06 (all families resolve; FILTER stub replaced).
3. **VP4 full display-side pass** — ranges, type rosters, enum vocab, layouts, FC/modifier from
   VP4-Edit. *Still needs a VP4 owner's `effectDefinitions_14_*.cache`.* **Now the top item.**
4. ~~III enum vocab + ranges~~ ✅ 2026-07-06 (591 lists, 2111 range rows from the 32.6 cache).
5. ~~III remaining type rosters~~ ✅ 2026-07-06.
6. **FM3 utility-family ranges** (low priority).

**Hardware captures — need a user's device (lower priority; editing already works without them):**
1. ~~Offline preset-body calibration for FM9 + III~~ ✅ 2026-07-06 single-preset ("Devs Gift Of
   Tone" cross-device pair). Remaining: more FM9/III preset dumps to firm the region floors;
   VP4 body calibration still open.
2. ~~Cab IR bank names for FM9 + III~~ ✅ 2026-07-06 (factory banks from the same caches).
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
