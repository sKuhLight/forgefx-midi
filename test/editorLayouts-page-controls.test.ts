/**
 * Editor-layout page-level controls (`EditorLayoutPage.pageControls`) — goldens
 * on the committed layouts of all four devices:
 *   1. per-device counts, and the block's own parameters the editor offers ONLY
 *      there (no row of the block shows them);
 *   2. a page-level id addresses a parameter of its OWN block: without a
 *      cross-block reference it is the catalog's id of that symbol under the
 *      layout's family (gen-3: the device's params; AM4: the family's own block
 *      table), and an own parameter never lacks its id. A parameter of another
 *      family has none;
 *   3. the Synth's tracking mode in full, with its firmware gate;
 *   4. page-level controls survive the folding of page-level type selectors
 *      into variants (Drive) and every firmware-versioned amp layout.
 * The rows are covered by editorLayouts.test.ts, the generator by
 * scripts/gen-editor-layouts-page-controls.test.ts.
 */
import { FM3_LAYOUTS, FM3_PARAMS } from '../src/gen3/fm3/index.js';
import { FM9_LAYOUTS, FM9_PARAMS } from '../src/gen3/fm9/index.js';
import { AXE3_LAYOUTS, PARAMS as AXE3_PARAMS } from '../src/gen3/axe-fx-iii/index.js';
import { AM4_LAYOUTS } from '../src/am4/index.js';
import { PARAMETER_NAME_TO_CACHE_ID } from '../src/am4/variantResolverTables.js';
import type { DeviceEditorLayouts, EditorLayoutControl, EditorLayoutPage } from '../src/editorLayouts.js';

interface CatalogParam { name: string; paramId: number; family: string }

const fail = (msg: string): never => {
  throw new Error(`[editorLayouts-page-controls] ${msg}`);
};

/**
 * `pages` carry at least one page-level control; `params` counts the distinct
 * parameter symbols among `paramControls`. Those without an id: `unresolved`
 * are symbols the device catalog does not hold at all (the AM4 editor config
 * also lists blocks the AM4 does not have), `foreign` counts controls whose
 * parameter belongs to another family, as `<layout family>/<symbol>`.
 * `onlyThere`: per family, its own (resolved) parameters no row of it shows.
 */
interface Golden {
  pages: number;
  controls: number;
  paramControls: number;
  params: number;
  unresolved: string[];
  foreign: Record<string, number>;
  onlyThere: Record<string, string[]>;
}

const GEN3_ONLY_THERE: Record<string, string[]> = {
  DISTORT: ['DISTORT_EQONOFF', 'DISTORT_EQPOSITION', 'DISTORT_EQTYPE', 'DISTORT_ZEROEQ'],
  FUZZ: ['FUZZ_EQON'],
  GEQ: ['GEQ_MASTERQ', 'GEQ_ZEROEQ'],
  LOOPER: ['LOOPER_END_TRIM', 'LOOPER_HALF', 'LOOPER_START_TRIM'],
  MULTICOMP: ['MULTICOMP_GAINMON1', 'MULTICOMP_GAINMON2', 'MULTICOMP_GAINMON3'],
  SYNTH: ['SYNTH_PD_RANGE'],
};

const GOLDENS: Record<string, Golden> = {
  FM3: {
    pages: 335, controls: 696, paramControls: 228, params: 24,
    unresolved: [], foreign: {},
    onlyThere: {
      DELAY: ['DELAY_MAXDEPTH'],
      DISTORT: ['DISTORT_EQONOFF', 'DISTORT_EQPOSITION', 'DISTORT_EQTYPE', 'DISTORT_ZEROEQ'],
      FUZZ: ['FUZZ_EQON'],
      GEQ: ['GEQ_MASTERQ', 'GEQ_ZEROEQ'],
      LOOPER: ['LOOPER_END_TRIM', 'LOOPER_HALF', 'LOOPER_START_TRIM'],
      MULTICOMP: ['MULTICOMP_GAINMON1', 'MULTICOMP_GAINMON2', 'MULTICOMP_GAINMON3'],
      MULTITAP: ['MULTITAP_FBKRET', 'MULTITAP_FBKSEND', 'MULTITAP_FEEDBACK'],
      SYNTH: ['SYNTH_PD_RANGE'],
    },
  },
  FM9: {
    pages: 283, controls: 575, paramControls: 183, params: 28,
    unresolved: [], foreign: {},
    onlyThere: {
      DELAY: ['DELAY_MAXDEPTH'],
      DISTORT: ['DISTORT_EQONOFF', 'DISTORT_EQPOSITION', 'DISTORT_EQTYPE', 'DISTORT_ZEROEQ'],
      FUZZ: ['FUZZ_EQON'],
      GEQ: ['GEQ_MASTERQ', 'GEQ_ZEROEQ'],
      LOOPER: ['LOOPER_END_TRIM', 'LOOPER_HALF', 'LOOPER_START_TRIM'],
      MULTICOMP: ['MULTICOMP_GAINMON1', 'MULTICOMP_GAINMON2', 'MULTICOMP_GAINMON3'],
      MULTITAP: ['MULTITAP_FBKRET', 'MULTITAP_FBKSEND', 'MULTITAP_FEEDBACK'],
      SYNTH: ['SYNTH_PD_RANGE'],
    },
  },
  III: {
    pages: 318, controls: 731, paramControls: 293, params: 28,
    unresolved: [], foreign: {},
    onlyThere: {
      DELAY: ['DELAY_MAXDEPTH'],
      DISTORT: ['DISTORT_EQONOFF', 'DISTORT_EQPOSITION', 'DISTORT_EQTYPE', 'DISTORT_ZEROEQ'],
      FUZZ: ['FUZZ_EQON'],
      GEQ: ['GEQ_MASTERQ', 'GEQ_ZEROEQ'],
      LOOPER: ['LOOPER_END_TRIM', 'LOOPER_HALF', 'LOOPER_START_TRIM'],
      MULTICOMP: ['MULTICOMP_GAINMON1', 'MULTICOMP_GAINMON2', 'MULTICOMP_GAINMON3'],
      MULTITAP: ['MULTITAP_FBKRET', 'MULTITAP_FBKSEND', 'MULTITAP_FEEDBACK'],
      SYNTH: ['SYNTH_PD_RANGE'],
    },
  },
  AM4: {
    pages: 28, controls: 60, paramControls: 60, params: 8,
    unresolved: ['PITCH_KEY', 'PITCH_SCALE', 'SYNTH_PD_RANGE'], foreign: {},
    onlyThere: {
      DISTORT: ['DISTORT_EQONOFF', 'DISTORT_EQTYPE', 'DISTORT_ZEROEQ'],
      GEQ: ['GEQ_MASTERQ', 'GEQ_ZEROEQ'],
    },
  },
};

/** A device's catalog as this suite needs it: the ids of a symbol under one family, and whether any family holds it. */
interface Catalog {
  own(family: string, name: string): readonly number[];
  holds(name: string): boolean;
}

function gen3Catalog(params: readonly CatalogParam[]): Catalog {
  const own = new Map<string, number[]>();
  const names = new Set<string>();
  for (const p of params) {
    const key = `${p.family}/${p.name}`;
    own.set(key, [...(own.get(key) ?? []), p.paramId]);
    names.add(p.name);
  }
  return { own: (family, name) => own.get(`${family}/${name}`) ?? [], holds: (name) => names.has(name) };
}

/** The AM4 block whose table a layout family addresses; a family without one has no page-level ids. */
const AM4_BLOCK: Record<string, string> = { DISTORT: 'amp', GEQ: 'geq' };
const AM4_CATALOG: Catalog = {
  own: (family, name) => PARAMETER_NAME_TO_CACHE_ID[AM4_BLOCK[family] ?? '']?.[name] ?? [],
  holds: (name) => Object.values(PARAMETER_NAME_TO_CACHE_ID).some((block) => block[name] !== undefined),
};

const DEVICES: ReadonlyArray<{ dev: string; layouts: DeviceEditorLayouts; catalog: Catalog }> = [
  { dev: 'FM3', layouts: FM3_LAYOUTS, catalog: gen3Catalog(FM3_PARAMS as readonly CatalogParam[]) },
  { dev: 'FM9', layouts: FM9_LAYOUTS, catalog: gen3Catalog(FM9_PARAMS as readonly CatalogParam[]) },
  { dev: 'III', layouts: AXE3_LAYOUTS, catalog: gen3Catalog(AXE3_PARAMS as readonly CatalogParam[]) },
  { dev: 'AM4', layouts: AM4_LAYOUTS, catalog: AM4_CATALOG },
];

function pagesOf(L: DeviceEditorLayouts, family: string): EditorLayoutPage[] {
  return (L[family]?.variants ?? []).flatMap((v) => v.pages);
}

function stats(L: DeviceEditorLayouts, catalog: Catalog): Golden {
  let pages = 0, controls = 0, paramControls = 0;
  const params = new Set<string>();
  const unresolved = new Set<string>();
  const foreign: Record<string, number> = {};
  const onlyThere: Record<string, string[]> = {};
  for (const family of Object.keys(L).sort()) {
    const inRows = new Set<string>();
    const onPage = new Set<string>();
    for (const p of pagesOf(L, family)) {
      for (const r of p.rows) for (const c of r.controls) if (c.paramName) inRows.add(c.paramName);
      if (!p.pageControls) continue;
      pages++;
      for (const c of p.pageControls) {
        controls++;
        if (!c.paramName) continue;
        paramControls++;
        params.add(c.paramName);
        if (c.paramId !== null) onPage.add(c.paramName);
        else if (!catalog.holds(c.paramName)) unresolved.add(c.paramName);
        else foreign[`${family}/${c.paramName}`] = (foreign[`${family}/${c.paramName}`] ?? 0) + 1;
      }
    }
    const only = [...onPage].filter((n) => !inRows.has(n)).sort();
    if (only.length) onlyThere[family] = only;
  }
  return { pages, controls, paramControls, params: params.size, unresolved: [...unresolved].sort(), foreign, onlyThere };
}

function checkCounts(dev: string, L: DeviceEditorLayouts, catalog: Catalog): void {
  const got = JSON.stringify(stats(L, catalog));
  const want = JSON.stringify(GOLDENS[dev]);
  if (got !== want) fail(`${dev}: counts\n    got  ${got}\n    want ${want}`);
}

/** An id without a cross-block reference is one of the layout's own family; an own parameter always has its id. */
function checkOwnIds(dev: string, L: DeviceEditorLayouts, catalog: Catalog): void {
  let resolved = 0;
  for (const family of Object.keys(L)) {
    for (const p of pagesOf(L, family)) for (const c of p.pageControls ?? []) {
      const where = `${dev}.${family}/${p.name}: '${c.paramName}'`;
      if (c.paramName === null) {
        if (c.paramId !== null) fail(`${where}: a decorative control has paramId ${c.paramId}`);
        continue;
      }
      if (c.crossBlock) continue; // names its owner itself
      const own = catalog.own(family, c.paramName);
      if (c.paramId === null) {
        if (own.length) fail(`${where}: a parameter of its own family (${own.join()}) has no paramId`);
        continue;
      }
      resolved++;
      if (!own.includes(c.paramId)) fail(`${where}: paramId ${c.paramId} is not a ${family} id (${own.join() || 'none'})`);
    }
  }
  if (!resolved) fail(`${dev}: no resolved page-level control`);
}

/** One page-level control on each of the three voice pages, gated as in the editor. */
function checkSynthTracking(dev: string, L: DeviceEditorLayouts, want: Partial<EditorLayoutControl>): void {
  const pages = pagesOf(L, 'SYNTH');
  const names = pages.map((p) => p.name).join(',');
  if (names !== 'Voice 1,Voice 2,Voice 3') fail(`${dev}.SYNTH: pages ${names}`);
  const exp = JSON.stringify([{
    label: 'Tracking\nMode', paramName: 'SYNTH_PD_RANGE', paramId: null,
    widget: 'dropdown', rawWidget: 'dropdown1Tight', ...want,
  }]);
  for (const p of pages) {
    const got = JSON.stringify(p.pageControls);
    if (got !== exp) fail(`${dev}.SYNTH/${p.name}: ${got} (expected ${exp})`);
  }
}

/** Variants of `family` in which at least one page offers `param` page-level. */
function variantsWith(L: DeviceEditorLayouts, family: string, param: string): string {
  const variants = L[family].variants;
  const hit = variants.filter((v) => v.pages.some((p) => p.pageControls?.some((c) => c.paramName === param)));
  return `${hit.length}/${variants.length}`;
}

const cases: Array<[string, () => void]> = [
  ...DEVICES.map(({ dev, layouts, catalog }): [string, () => void] => [`${dev} counts`, () => checkCounts(dev, layouts, catalog)]),
  ...DEVICES.map(({ dev, layouts, catalog }): [string, () => void] => [`${dev} ids address their own block`, () => checkOwnIds(dev, layouts, catalog)]),
  ['Synth tracking mode', () => {
    checkSynthTracking('FM3', FM3_LAYOUTS, { paramId: 41, placement: { positionExact: '196,230' }, fw: { gtet: '11,01' } });
    checkSynthTracking('FM9', FM9_LAYOUTS, { paramId: 41, placement: { positionExact: '196,230' }, fw: { gtet: '10,01' } });
    checkSynthTracking('III', AXE3_LAYOUTS, { paramId: 41, placement: { positionExact: '196,230' }, fw: { gtet: '29,02' } });
    checkSynthTracking('AM4', AM4_LAYOUTS, { placement: { positionExact: '4,220' } });
  }],
  ['variants carry their pages\' controls: versioned amp layouts, type-selector folding', () => {
    const got = [
      ['FM3', variantsWith(FM3_LAYOUTS, 'DISTORT', 'DISTORT_EQTYPE'), variantsWith(FM3_LAYOUTS, 'FUZZ', 'FUZZ_EQON')],
      ['FM9', variantsWith(FM9_LAYOUTS, 'DISTORT', 'DISTORT_EQTYPE'), variantsWith(FM9_LAYOUTS, 'FUZZ', 'FUZZ_EQON')],
      ['III', variantsWith(AXE3_LAYOUTS, 'DISTORT', 'DISTORT_EQTYPE'), variantsWith(AXE3_LAYOUTS, 'FUZZ', 'FUZZ_EQON')],
    ].map((r) => r.join(' ')).join(', ');
    const want = 'FM3 2/2 40/40, FM9 2/2 36/36, III 4/4 41/41';
    if (got !== want) fail(`variants with page-level controls: ${got} (expected ${want})`);
  }],
];

export const EDITOR_LAYOUT_PAGE_CONTROLS_CASE_COUNT = cases.length;

export function runEditorLayoutPageControlsTests(): void {
  for (const [name, run] of cases) {
    try {
      run();
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
}
