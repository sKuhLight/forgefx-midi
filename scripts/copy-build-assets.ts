/**
 * Post-build asset copier. tsc compiles .ts → .js but doesn't copy
 * data files (.json, etc.) into the dist/ tree. `lineageLookup.ts`
 * reads JSON files at runtime via `fs.readFileSync('<dist>/shared/
 * lineage/<block>-lineage.json')`, so the JSON files have to be
 * present alongside the compiled .js.
 *
 * Run via `npm run build` (chained after tsc).
 */
import { readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

interface AssetCopy {
  src: string;
  dst: string;
}

const COPIES: AssetCopy[] = [
  { src: 'src/shared/lineage', dst: 'dist/shared/lineage' },
];

function safeExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function copyTree(srcDir: string, dstDir: string): number {
  if (!safeExists(srcDir)) return 0;
  mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const name of readdirSync(srcDir)) {
    const srcPath = join(srcDir, name);
    const dstPath = join(dstDir, name);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      count += copyTree(srcPath, dstPath);
    } else if (!srcPath.endsWith('.ts')) {
      copyFileSync(srcPath, dstPath);
      count += 1;
    }
  }
  return count;
}

let total = 0;
for (const { src, dst } of COPIES) {
  const n = copyTree(src, dst);
  console.log(`  copied ${n} file(s) from ${src} -> ${dst}`);
  total += n;
}
console.log(`copy-build-assets: ${total} file(s) mirrored.`);
