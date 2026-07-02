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
// lines and version pinning sanity checks. It's read from package.json
// at module load so it never drifts from the published version.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(HERE, '..', 'package.json');
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string };

export const VERSION: string = pkg.version;
