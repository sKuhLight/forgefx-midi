# Cross-Device Preset Converter — IR + Taxonomy (P0a)

The `fractal-midi/convert` module is the foundation for converting presets
between Fractal devices. P0a delivers three things: a **device-agnostic preset
IR**, a **universal block-family taxonomy** spanning every generation, and
**per-device lift adapters** that raise each device's decoded preset into the
IR as deep as its current decode allows.

Design goal: **lossless-from-source, best-effort-to-target.** The lift captures
everything the current decode exposes and records how much that was, so the
conversion engine (P1/P2) and the UI can be honest about conversion quality.
The engine's job — mapping a source family onto a different target family,
scaling params, laying out routing — is explicitly NOT in P0a.

## Module layout

| file | role |
|---|---|
| `src/convert/families.ts` | family vocabulary, per-device native→family maps, presence sets, topology |
| `src/convert/ir.ts` | the IR types (`ConverterPreset`, `ConverterBlock`, `ConverterParam`, `ConverterRouting`) |
| `src/convert/conceptLookup.ts` | reverse concept-key lookup (device-local param name → concept key) |
| `src/convert/lineageIndex.ts` | unified model-lineage index + `matchModel` (P0b) |
| `src/convert/adapters/{gen3,am4,vp4,gen2}.ts` | per-device lift adapters |
| `src/convert/engine.ts` | the P2 conversion engine (`convertPreset`) |
| `src/convert/events.ts` | conversion-event schema + `severityOf` (UI contract) |
| `src/convert/targetRanges.ts` | target-device param range resolution for validation |

Import via the `./convert` subpath export (`fractal-midi/convert`).

## The IR

A `ConverterPreset` carries:

- `sourceDevice`, `name`, `sceneNames?`, `sceneCount`
- `blocks: ConverterBlock[]` — placed blocks. **Shunts are NOT blocks** — they
  are routing-only and live in `routing.gridCells`.
- `routing: ConverterRouting` — **both** views:
  - `gridCells?` — the source grid verbatim (grid-shaped devices only),
    including shunts, route flags, and incoming-row masks.
  - `seriesChains: string[][]` — block keys in signal order; each parallel
    branch is a separate chain. Shunts are traversed for connectivity but never
    appear as chain entries.
- `decodeDepth: 'full' | 'partial' | 'skeleton'` — preset-level fidelity.

Each `ConverterBlock` has a stable `key` (`<family><instance>`, e.g. `amp1`),
its `family`, `instance`, optional `typeName`/`typeValue`, `params`, per-scene
`channels`/`bypassPerScene`, a `position` (`{row,col}` or `{slot}`), and a
`liftedFrom: 'full-decode' | 'partial-decode'` fidelity flag.

Each `ConverterParam` carries the device-native name, the resolved
`conceptKey?` (cross-device concept, via the concept-key registry), the raw
`value`, an optional `normalized` (0..1) and `displayValue`.

## Taxonomy derivation rules

The family vocabulary (`CONVERTER_FAMILIES`) has **one family per distinct block
identity** across all generations. Cross-family equivalence (routing a `plex`
onto a `delay`-only target) is deliberately NOT collapsed here — that is the
engine's job. This keeps the lift unambiguous and lossless.

Per-device native→family maps are **derived mechanically** from the existing
per-device block tables — no roster data is hand-copied:

1. Each device's own block table is imported (`gen3/axe-fx-iii/blockTypes`,
   `gen2/axe-fx-ii/blockTypes`, `gen1/blockTypes`, `am4/blockTypes`).
2. Every entry's identity is normalized (`normalizeBlockToken`: lowercase, drop
   non-alphanumerics, strip a trailing instance number) and looked up in one
   small alias table (`FAMILY_ALIASES`). Because the table is keyed by the
   normalized token, it simultaneously covers gen-3 display names, the gen-3
   body-decoder's own vocabulary, gen-2 display names, gen-1 slugs, and AM4
   lowercase names.
3. Any unresolved entry lands in `UNMAPPED_NATIVES` — which the families test
   asserts is empty. A miss means a new block spelling needs an alias.

`familyPresence(device)` is exact for devices with a real block table (gen-3
honors the table's `availability` gate so III-only / III+FM9 blocks are absent
where they should be). **VP4** has no block table of its own — its chain carries
shared gen-3 effect IDs — so its presence is an explicit, documented effect
roster (`VP4_FAMILIES`), community-beta pending a capture. The two load-bearing
VP4 facts are firm: **no `amp`**, **yes `pitch`**.

`deviceTopology(device)`:

| device | topology |
|---|---|
| Axe-Fx III / FM9 | `grid` 6×14 |
| FM3 / Axe-Fx II | `grid` 4×12 |
| Axe-Fx gen-1 | `grid` 4×12 (community-documented, `confirmed: false`) |
| AM4 | `slots`, single-instance-per-family |
| VP4 | `chain`, 4 slots |

## Adapter depth per device

| adapter | device(s) | depth | what is lifted |
|---|---|---|---|
| `liftGen3Preset` | Axe-Fx III / FM9 / FM3 | **full** | grid → gridCells + seriesChains; blocks with per-scene channels + bypass; amp params (native names + concept keys) |
| `liftAm4Preset` | AM4 | **partial** | name, 4 scenes, amp block per-channel params; cab/FX not decoded |
| `liftVp4Preset` | VP4 | **skeleton** | name, 4 scenes, 4-slot chain as identity-only blocks (family + type name) |
| `liftGen2Preset` | Axe-Fx II | **skeleton** | name only; per-scene/per-block binary is opaque (deeper decode is capture-gated, FORGEFXMID-31) |

There is **no gen-1 adapter yet** — its dump decode is minimal. gen-1 is present
in the taxonomy (device id, topology, presence) so the engine can TARGET it
later; a lift adapter lands when its decode deepens.

The gen-3 amp is the one block family the body decoder extracts named knob
values for, so it is the only place P0a produces per-param values; other gen-3
blocks carry type identity + per-scene channel/bypass state (`liftedFrom:
'partial-decode'`). Generic per-block param VALUE decode is deferred (no in-repo
value-scale ground truth — see `devices/gen3/presetBody.ts`).

## Lineage index & concept-key coverage (P0b)

Two cross-device lookup layers sit alongside the taxonomy.

### Concept-key registry (`core/protocol-generic/concept-keys.ts`)

Canonical `<block>.<concept>` keys map ONE cross-device word to each device's
local param name (e.g. `amp.preamp_gain` → II `input_drive` / AM4 `gain` / gen-3
`drive`). P0b grew the registry from ~40 to **128 keys** across amp, cab, drive,
compressor, gate, delay, reverb, chorus, flanger, phaser, rotary, tremolo, wah,
pitch, filter, vol/pan, enhancer, graphic-EQ and parametric-EQ (plus the
untouched Hydrasynth synth concepts).

The gen-3 floor units share ONE vocabulary column: `normalizeConceptPort()`
folds `fm3` / `fm9` / `vp4` onto the `axe-fx-iii` column, so each resolves 121
keys without the registry duplicating an entry per model. A per-model override
hook (`MODEL_PARAM_OVERRIDES`) lets a floor unit diverge one param at a time
(currently empty — the vocabularies are identical). Resolvable-key counts:
axe-fx-iii / fm3 / fm9 / vp4 = **121**, axe-fx-ii = **117**, am4 = **108**,
hydrasynth = 8, gen-1 = 0.

Every Fractal-device local name is verified to EXIST in that device's real param
table by `test/convert/concept-coverage.test.ts` — the authoritative sources are
gen-3 `PARAMS_BY_FAMILY` (family-prefix-stripped), gen-2 `KNOWN_PARAMS`, and AM4
`KNOWN_PARAMS` (`am4/params.ts`, the table `buildBlocks()` iterates). A typo or a
column that names a param the device lacks fails the build.

### Lineage index (`convert/lineageIndex.ts`)

`buildLineageIndex()` (memoized) folds every device's model-lineage source into
ONE table keyed by `(family, normalized-name)`: AM4 lineage JSON (structured
`basedOn`), Axe-Fx II lineage (`axefx2Name` + `wireIndex` + `basedOn`), FM3
rosters (inline `{value, name, manufacturer, basedOn}`), and the FM9 + III read
rosters (ordinal→name only — they inherit FM3 lineage by name-identity). A model
hosted on several devices under the same name collapses to ONE record with a
`device → nativeValue` map. Current size: **951 records** (amp 475, reverb 165,
drive 102, cab 45; per device fm3 612 / am4 543 / iii 515 / fm9 500 / ii 352).

`matchModel(source, targetDevice)` ranks target candidates through a fixed
confidence ladder:

| confidence | rule |
|---|---|
| `exact` | identical normalized name on the target device |
| `lineage` | same real gear — `basedOn` manufacturer+model identity, or a manufacturer + model-in-primary-text bridge for roster-only records |
| `fuzzy` | name/token/manufacturer overlap, ranked by a numeric `score` |
| `fallback` | the family's lowest-ordinal target model (only when nothing else matched AND the family has target data) |

Families with no roster/lineage data for the target (or unknown families) return
`[]`, and the P2 engine emits an unresolved-type event.

## Conversion engine (P2)

`convert/engine.ts` lowers a lifted `ConverterPreset` onto a chosen target
device, best-effort, and reports every lossy/approximate decision as an event.
The engine is **pure and deterministic**: same input → same output, the source
preset is never mutated, and there is no `Date`/`Math.random`.

### Public API

```ts
function convertPreset(
  source: ConverterPreset,
  targetDevice: ConverterDeviceId,
  opts?: ConvertOptions,
): ConversionResult;

interface ConvertOptions {
  maxBlocks?: number;            // extra cap on top of device capacity
  keepUnresolvedTypes?: boolean; // default true — keep block w/ undefined type
}
interface ConversionResult { target: ConverterPreset; events: ConversionEvent[] }
```

Supporting exports: `FAMILY_PRIORITY` (capacity/overflow ordering),
`deviceSceneCount` / `deviceChannelCount` (`families.ts`), `resolveTargetRange`
(`targetRanges.ts`), and the whole event schema + `severityOf` (`events.ts`).

### Pipeline (in order)

0. **source-partial** — when `source.decodeDepth !== 'full'`, prepend a blanket
   caveat event.
1. **Family presence + instancing** — drop blocks whose family the target lacks
   (`block-dropped`/`family-missing`). For single-per-family targets (AM4) keep
   the FIRST instance per family in signal order, drop the rest
   (`instance-limit`).
2. **Capacity** — device capacity = `rows*cols` (grid) / `slots` (slots/chain),
   further limited by `opts.maxBlocks`. Overflow blocks are dropped LOWEST-
   priority first (`FAMILY_PRIORITY`, then source signal order) with
   `capacity-exceeded`.
3. **Type mapping** — **shared-roster short-circuit first**: when source and
   target share one block/type roster (`sharesTypeRoster` in `families.ts` —
   the gen-3 trio + VP4 fold onto one `gen3` slug, mirroring
   `normalizeConceptPort`), types transfer **verbatim** (`typeName` +
   `typeValue` unchanged, ZERO type events). Exception: the target's reduced
   roster verifiably lacks the model (`modelOnDevice(...) === 'absent'`,
   checked against the FM3/FM9 generated rosters + III read rosters via the
   lineage index) → that block falls through to the normal path. With no
   roster data to check (`'unknown'`, e.g. VP4), the shared codec is trusted.
   Normal path: for each block with a `typeName`, `matchModel(...)`; best
   candidate → `type-substituted` (emitted even for `exact`, so the UI has
   full provenance — severity follows confidence). No candidates (or no source
   type) → `type-unresolved`; the block is KEPT with `typeName` cleared
   (default) so the fake-grid can offer a picker, or removed
   (`block-unplaced`) when `keepUnresolvedTypes: false`.
4. **Param mapping** — when source and target share ONE concept-key vocabulary
   column (the gen-3 trio+VP4, or the same device), params pass through
   **verbatim, no events** (lossless). Otherwise, per param: resolve its
   `conceptKey` to the target's local name (`resolveConceptKey`); no concept →
   `param-dropped`/`no-concept-mapping`; concept not on target →
   `param-dropped`/`target-lacks-param`; else range-validate against
   `resolveTargetRange` — clamp + `param-clamped`, or `param-unverified` when no
   range data exists.
5. **Routing / placement** — grid→grid upsize (target dims ≥ source dims) keeps
   the source layout verbatim (lossless). grid→smaller-grid re-lays the source
   series chains row by row (longest chain first, so the main signal path lands
   in row 0 intact) — `routing-simplified`. grid→chain/slots flattens the main
   chain into slots — `routing-simplified`. chain/slots→grid lays a single row
   (no event — expansion). Anything with no free cell/slot → `block-unplaced`
   (removed). Shunts are routing-only and are NOT synthesized on the target.
6. **Scene + channel collapse** — `source.sceneCount > deviceSceneCount(target)`
   truncates scenes → `scene-collapsed`; per block,
   `channels.count > deviceChannelCount(target)` clamps → `channel-collapsed`.
7. **Result IR** — a valid target `ConverterPreset`. `sourceDevice` stays the
   ORIGINAL source (provenance); `meta.convertedFrom` / `meta.convertedTo`
   record the conversion.

### Event catalog (the UI contract — `convert/events.ts`)

`ConversionEvent` is a discriminated union on `kind`. `severityOf(event)` maps
each to `info` | `warn` | `loss` in one place.

| kind | payload (beyond `kind`) | severity |
|---|---|---|
| `source-partial` | `decodeDepth`, `detail` | warn |
| `block-dropped` | `blockKey`, `family`, `reason: family-missing\|capacity-exceeded\|instance-limit` | loss |
| `block-unplaced` | `blockKey`, `family`, `reason` | loss |
| `type-substituted` | `blockKey`, `family`, `sourceTypeName`, `targetTypeName`, `confidence`, `score?` | `exact`/`lineage` → info; `fuzzy`/`fallback` → warn |
| `type-unresolved` | `blockKey`, `family`, `sourceTypeName` | warn |
| `param-clamped` | `blockKey`, `nativeName`, `conceptKey?`, `sourceValue`, `targetValue`, `targetMin?`, `targetMax?` | warn |
| `param-dropped` | `blockKey`, `nativeName`, `reason: no-concept-mapping\|target-lacks-param` | loss |
| `param-unverified` | `blockKey`, `nativeName`, `value` | info |
| `routing-simplified` | `detail`, `affectedBlockKeys` | warn |
| `scene-collapsed` | `sourceScenes`, `targetScenes` | loss |
| `channel-collapsed` | `blockKey`, `sourceChannels`, `targetChannels` | loss |

### Target range data (`convert/targetRanges.ts`)

Range validation uses only real, name-keyed data: AM4 display ranges from the
`KNOWN_PARAMS` registry, and the gen-3 amp tone knobs' device-true 0..10 display
range (the body decoder's scale — the amp knobs are the params the gen-3/AM4
adapters actually lift). Everything else returns `undefined`, and the engine
emits `param-unverified` rather than guessing a range.
