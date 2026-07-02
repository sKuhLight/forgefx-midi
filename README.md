# forgefx-midi

Pure-TypeScript codec and parameter catalogs for Fractal Audio devices, used by
ForgeFX. Builds and parses the SysEx wire bytes for each device family —
transport-agnostic (no MIDI I/O dependency; bring your own transport).

Covered devices: Axe-Fx Standard/Ultra (gen1), Axe-Fx II (gen2),
Axe-Fx III / FM3 / FM9 / VP4 (gen3), and AM4.

## Install

Local package for now — not published.

```sh
npm install
npm run build   # tsc → dist/, plus runtime JSON assets
npm test        # tsx test/run-all.ts (golden test suites)
```

## Subpath exports

| Import | Contents |
|---|---|
| `forgefx-midi` | root index (VERSION, top-level re-exports) |
| `forgefx-midi/shared` | cross-device helpers (checksums, value packing, lineage lookup) |
| `forgefx-midi/am4` | AM4 codec + param maps |
| `forgefx-midi/gen1` | Axe-Fx Standard/Ultra codec |
| `forgefx-midi/gen2/axe-fx-ii` | Axe-Fx II codec |
| `forgefx-midi/gen3/axe-fx-iii` | Axe-Fx III codec |
| `forgefx-midi/gen3/fm3` | FM3 codec (params, meters, FC, modifiers) |
| `forgefx-midi/gen3/fm9` | FM9 codec |
| `forgefx-midi/gen3/vp4` | VP4 codec |
| `forgefx-midi/catalog/*.json` | device catalogs (7 devices + index) |

## Catalogs

`catalog/` ships one JSON per device (`am4`, `axe-fx-gen1`, `axe-fx-ii`,
`axe-fx-iii`, `fm3`, `fm9`, `vp4`) plus `index.json`. Schema is documented in
`docs/CATALOG-SCHEMA.md`.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
