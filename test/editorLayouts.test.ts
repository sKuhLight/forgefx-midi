/**
 * Editor-layout catalog v2 — structural + paramId-join integrity goldens.
 *
 * Covers all four devices' `<DEV>_LAYOUTS`:
 *   - structure: every family has variants; every variant has pages; every
 *     page has rows; every row has controls; widget kinds are all in the
 *     known set; page/variant order preserved (non-empty, well-formed).
 *   - paramId join integrity (gen3): every control's paramId is EXACTLY the
 *     join of its parameterName against the device catalog — the resolved id
 *     when the name is catalogued, null otherwise (no stray or wrong ids).
 *   - paramId sanity (AM4): non-null ids are non-negative integers.
 *   - amp firmware pinning: firmware-versioned DISTORT has exactly one pinned
 *     variant; cross-block refs carry a paramName.
 */
import { FM3_LAYOUTS } from '../src/gen3/fm3/index.js';
import { FM9_LAYOUTS, FM9_PARAMS } from '../src/gen3/fm9/index.js';
import { AXE3_LAYOUTS, PARAMS as AXE3_PARAMS } from '../src/gen3/axe-fx-iii/index.js';
import { FM3_PARAMS } from '../src/gen3/fm3/index.js';
import { AM4_LAYOUTS } from '../src/am4/index.js';
import { EDITOR_WIDGET_KINDS, type DeviceEditorLayouts } from '../src/editorLayouts.js';

interface CatalogParam { name: string; paramId: number; family: string }

export const EDITOR_LAYOUTS_CASE_COUNT = 4;

function nameToId(params: readonly CatalogParam[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of params) if (!m.has(p.name)) m.set(p.name, p.paramId);
  return m;
}

/** Structure + widget-set validation shared by every device. */
function checkStructure(dev: string, L: DeviceEditorLayouts, fail: (m: string) => never): number {
  const known = new Set<string>(EDITOR_WIDGET_KINDS);
  let controls = 0;
  const families = Object.keys(L);
  if (families.length === 0) fail(`${dev}: no families`);
  for (const [key, block] of Object.entries(L)) {
    if (block.family !== key) fail(`${dev}.${key}: family mismatch (${block.family})`);
    if (!block.editorName) fail(`${dev}.${key}: empty editorName`);
    if (!Array.isArray(block.variants) || block.variants.length === 0) fail(`${dev}.${key}: no variants`);
    for (const v of block.variants) {
      if (!Array.isArray(v.pages) || v.pages.length === 0) fail(`${dev}.${key}/${v.name}: no pages`);
      for (const p of v.pages) {
        if (!Array.isArray(p.rows) || p.rows.length === 0) fail(`${dev}.${key}/${v.name}/${p.name}: no rows`);
        for (const r of p.rows) {
          if (r.section !== 'parameters' && r.section !== 'mixer') fail(`${dev}.${key}: bad row section ${r.section}`);
          if (!Array.isArray(r.controls) || r.controls.length === 0) fail(`${dev}.${key}/${v.name}/${p.name}: empty row`);
          for (const c of r.controls) {
            controls++;
            if (!known.has(c.widget)) fail(`${dev}.${key}: unknown widget kind '${c.widget}' (raw '${c.rawWidget}')`);
            if (typeof c.label !== 'string') fail(`${dev}.${key}: non-string label`);
            if (c.paramName !== null && typeof c.paramName !== 'string') fail(`${dev}.${key}: bad paramName`);
            if (c.paramId !== null && !Number.isInteger(c.paramId)) fail(`${dev}.${key}: non-integer paramId ${c.paramId}`);
            if (c.crossBlock && c.crossBlock.paramName === undefined) fail(`${dev}.${key}: crossBlock missing paramName`);
          }
        }
      }
    }
  }
  return controls;
}

/** gen3 join integrity: paramId === catalog[paramName] ?? null, for every control. */
function checkGen3Join(dev: string, L: DeviceEditorLayouts, params: readonly CatalogParam[], fail: (m: string) => never): { checked: number; joined: number } {
  const map = nameToId(params);
  let checked = 0, joined = 0;
  for (const [key, block] of Object.entries(L)) {
    for (const v of block.variants) for (const p of v.pages) for (const r of p.rows) for (const c of r.controls) {
      if (c.paramName === null) {
        if (c.paramId !== null) fail(`${dev}.${key}: decorative control has paramId ${c.paramId}`);
        continue;
      }
      checked++;
      const expected = map.has(c.paramName) ? map.get(c.paramName)! : null;
      if (c.paramId !== expected) {
        fail(`${dev}.${key}: paramId join mismatch for '${c.paramName}': got ${c.paramId}, catalog ${expected}`);
      }
      if (c.paramId !== null) joined++;
    }
  }
  return { checked, joined };
}

function checkAm4(dev: string, L: DeviceEditorLayouts, fail: (m: string) => never): void {
  for (const [key, block] of Object.entries(L)) {
    for (const v of block.variants) for (const p of v.pages) for (const r of p.rows) for (const c of r.controls) {
      if (c.paramId !== null && (!Number.isInteger(c.paramId) || c.paramId < 0)) {
        fail(`${dev}.${key}: invalid AM4 paramId ${c.paramId} for '${c.paramName}'`);
      }
    }
  }
}

/** Firmware-versioned amp blocks must pin exactly one variant. */
function checkAmpPinning(dev: string, L: DeviceEditorLayouts, fail: (m: string) => never): void {
  const amp = (L as Record<string, DeviceEditorLayouts[string]>)['DISTORT'];
  if (!amp) fail(`${dev}: no DISTORT (amp) family`);
  const pinned = amp.variants.filter((v) => v.pinned);
  if (amp.variants.length > 1 && pinned.length !== 1) {
    fail(`${dev}: DISTORT has ${amp.variants.length} variants but ${pinned.length} pinned (expected 1)`);
  }
}

export function runEditorLayoutsTests(): void {
  const fail = (msg: string): never => { throw new Error(`[editorLayouts] ${msg}`); };

  // Structure — all four devices.
  const nFm3 = checkStructure('FM3', FM3_LAYOUTS, fail);
  const nFm9 = checkStructure('FM9', FM9_LAYOUTS, fail);
  const nAxe3 = checkStructure('III', AXE3_LAYOUTS, fail);
  const nAm4 = checkStructure('AM4', AM4_LAYOUTS, fail);
  if (nFm3 + nFm9 + nAxe3 + nAm4 < 1000) fail(`suspiciously few controls: ${nFm3 + nFm9 + nAxe3 + nAm4}`);

  // Join integrity — gen3 devices vs their own PARAMS catalog.
  const fm9 = checkGen3Join('FM9', FM9_LAYOUTS, FM9_PARAMS as readonly CatalogParam[], fail);
  const axe3 = checkGen3Join('III', AXE3_LAYOUTS, AXE3_PARAMS as readonly CatalogParam[], fail);
  const fm3 = checkGen3Join('FM3', FM3_LAYOUTS, FM3_PARAMS as readonly CatalogParam[], fail);
  // FM9 / III are mined from these same editor XMLs — expect full join.
  if (fm9.checked > 0 && fm9.joined !== fm9.checked) fail(`FM9 join incomplete: ${fm9.joined}/${fm9.checked}`);
  if (axe3.checked > 0 && axe3.joined !== axe3.checked) fail(`III join incomplete: ${axe3.joined}/${axe3.checked}`);
  if (fm3.checked > 0 && fm3.joined !== fm3.checked) fail(`FM3 join incomplete: ${fm3.joined}/${fm3.checked}`);

  // AM4 paramId sanity.
  checkAm4('AM4', AM4_LAYOUTS, fail);

  // Amp firmware pinning (III / FM9 have firmware-versioned amp layouts).
  checkAmpPinning('FM9', FM9_LAYOUTS, fail);
  checkAmpPinning('III', AXE3_LAYOUTS, fail);
}
