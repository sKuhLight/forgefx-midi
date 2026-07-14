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
| `src/convert/adapters/{gen3,am4,vp4,gen2}.ts` | per-device lift adapters |

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
