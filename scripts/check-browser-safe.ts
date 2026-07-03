/**
 * Browser-safety probe for the codec subpath exports.
 *
 * Bundles each browser-relevant entry point from SOURCE with esbuild at
 * `platform: 'browser'`. If any module in the graph imports a Node core
 * module (`node:fs`, `path`, …) or a Node-only package (serialport,
 * @julusian/midi), resolution fails and this script exits non-zero.
 *
 * Deliberately NOT probed (Node-only by design):
 *   - core/midi          — node-midi / serialport transports
 *   - devices/am4/safety — fs/crypto backup utilities
 *   - devices/gen2       — the Axe-Fx II descriptor's reader/writer tools
 *                          connect via node-midi; there is no ForgeFX
 *                          Axe-Fx II driver, so the browser never needs it.
 *                          (The gen2/axe-fx-ii CODEC subpath IS probed.)
 *
 * Run via `npm test` (chained) or `npm run check:browser`.
 */
import { build } from 'esbuild';

const ENTRIES = [
  'src/index.ts',
  'src/shared/index.ts',
  'src/core/index.ts',
  'src/am4/index.ts',
  'src/gen1/index.ts',
  'src/gen2/axe-fx-ii/index.ts',
  'src/gen3/fm3/index.ts',
  'src/gen3/fm9/index.ts',
  'src/gen3/axe-fx-iii/index.ts',
  'src/gen3/vp4/index.ts',
  'src/devices/gen1/index.ts',
  'src/devices/gen3/index.ts',
  'src/devices/am4/index.ts',
];

let failed = 0;
for (const entry of ENTRIES) {
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      logLevel: 'silent',
    });
    console.log(`PASS  browser-safe: ${entry}`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message.split('\n').slice(0, 6).join('\n') : String(e);
    console.error(`FAIL  browser-safe: ${entry}\n${msg}`);
  }
}

if (failed) {
  console.error(`check-browser-safe: ${failed}/${ENTRIES.length} entry point(s) pull Node-only code.`);
  process.exit(1);
}
console.log(`check-browser-safe: all ${ENTRIES.length} entry points bundle clean for the browser.`);
