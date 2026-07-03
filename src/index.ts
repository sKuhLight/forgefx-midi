// fractal-midi public entry point.
//
// The shape exposed here is intentionally narrow at the root; consumers
// import from the subpath that matches their device or layer:
//
//   import { packValue, fractalChecksum } from 'fractal-midi/shared';
//   import { ... } from 'fractal-midi/am4';
//   import { ... } from 'fractal-midi/gen2/axe-fx-ii';
//
// The root `VERSION` constant is convenience-only — useful for log
// lines and version pinning sanity checks. It lives in src/version.ts,
// regenerated from package.json by `npm run build` (scripts/gen-version.ts),
// so the root entry stays importable from browser bundles (no fs read
// at module load — Axis Browser Direct bundles these codecs).

export { VERSION } from './version.js';
