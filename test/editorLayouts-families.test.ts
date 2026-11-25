/**
 * Editor-layout family split — regression goldens for the generator's XML scan.
 *
 * The editor config carries literal `>` glyphs inside quoted captions
 * ("Feedback L>R", "Feedback 1->2", AM4 "Amp->Cab Type Linking"). A tag-end scan
 * that stopped at the first `>` left those controls open and mis-nested every
 * following node: the Delay block had no layout of its own (its pages were filed
 * under MULTITAP with editorName "Delay"), rows lost controls, and the AM4 Global
 * pages were filed under the amp (DISTORT) family.
 *
 * Asserts, on the committed generated layouts:
 *   1. gen-3 DELAY and MULTITAP are separate families (Delay / MultiDelay) whose own
 *      controls stay inside their family, with pinned variant / page / control counts;
 *   2. variants split from page-level selectors name that selector (DELAY_TYPE,
 *      REVERB_BASETYPE); editor-keyed variants carry none; a catch-all page
 *      (`value=""`) reaches every type no sibling page on its tab names;
 *   3. captions containing `>` stay on their own control;
 *   4. editor names are unique per device (one editor component per family);
 *   5. AM4 Global is its own family and the amp family holds only the amp editor;
 *   6. pinned per-device totals (families / variants / pages / controls).
 */
import { FM3_LAYOUTS } from '../src/gen3/fm3/index.js';
import { FM9_LAYOUTS } from '../src/gen3/fm9/index.js';
import { AXE3_LAYOUTS } from '../src/gen3/axe-fx-iii/index.js';
import { AM4_LAYOUTS } from '../src/am4/index.js';
import type { DeviceEditorLayouts, EditorBlockLayout, EditorLayoutControl } from '../src/editorLayouts.js';

const fail = (msg: string): never => {
  throw new Error(`[editorLayouts-families] ${msg}`);
};

const DEVICES: ReadonlyArray<readonly [string, DeviceEditorLayouts]> = [
  ['FM3', FM3_LAYOUTS],
  ['FM9', FM9_LAYOUTS],
  ['III', AXE3_LAYOUTS],
  ['AM4', AM4_LAYOUTS],
];

function controlsOf(block: EditorBlockLayout): EditorLayoutControl[] {
  const out: EditorLayoutControl[] = [];
  for (const v of block.variants) for (const p of v.pages) for (const r of p.rows) out.push(...r.controls);
  return out;
}

function counts(block: EditorBlockLayout): string {
  let pages = 0;
  for (const v of block.variants) pages += v.pages.length;
  return `${block.variants.length}/${pages}/${controlsOf(block).length}`;
}

function totals(layouts: DeviceEditorLayouts): string {
  let variants = 0, pages = 0, controls = 0;
  for (const block of Object.values(layouts)) {
    variants += block.variants.length;
    for (const v of block.variants) {
      pages += v.pages.length;
      for (const p of v.pages) for (const r of p.rows) controls += r.controls.length;
    }
  }
  return `${Object.keys(layouts).length}/${variants}/${pages}/${controls}`;
}

function get(dev: string, layouts: DeviceEditorLayouts, family: string): EditorBlockLayout {
  const block = layouts[family];
  if (!block) fail(`${dev}: no ${family} family`);
  return block!;
}

/** Variants / pages / controls of the two delay families, per gen-3 device. DELAY carries the
 *  editor's catch-all `Modulation` page (fw >= 8.00 FM3 / 6.00 FM9 / 23.00 III) on every type its
 *  `DELAY_TYPE="6"` sibling does not name (0-5, 7): 7 pages / 210 controls per device. */
const DELAY_COUNTS: Record<string, { DELAY: string; MULTITAP: string }> = {
  FM3: { DELAY: '9/63/1390', MULTITAP: '12/87/1991' },
  FM9: { DELAY: '9/54/1252', MULTITAP: '12/82/1844' },
  III: { DELAY: '9/79/1782', MULTITAP: '12/84/1916' },
};

/** Families / variants / pages / controls per device. Catch-all pages fold into every type no
 *  sibling page names: FM3 +12 pages (DELAY 7, REVERB 4, TREMOLO 1), FM9 +17 (DELAY 7, REVERB 9,
 *  TREMOLO 1), III +15 (DELAY 7, REVERB 4, TREMOLO 1, CHORUS 3), AM4 +1 (FILTER 1). */
const TOTALS: Record<string, string> = {
  FM3: '44/188/950/17640',
  FM9: '44/182/853/16035',
  III: '47/199/1175/21995',
  AM4: '32/184/383/4042',
};

/** Page tabs (name + firmware gate) of a variant, in editor order. */
function tabs(block: EditorBlockLayout, variantName: string, gate?: string): string {
  const v = block.variants.find((x) => x.name === variantName && (gate === undefined || JSON.stringify(x.fw ?? null) === gate));
  if (!v) fail(`${block.family}: no variant '${variantName}'${gate ? ` ${gate}` : ''}`);
  return v!.pages.map((p) => (p.fw ? `${p.name}${JSON.stringify(p.fw).replace(/"/g, '')}` : p.name)).join(' | ');
}

/** Captions containing `>` and the parameter each one belongs to. */
const ARROW_CAPTIONS: ReadonlyArray<readonly [family: string, label: string, paramName: string]> = [
  ['DELAY', 'Feedback\nL>R', 'DELAY_FEEDLR'],
  ['DELAY', 'Feedback\nR>L', 'DELAY_FEEDRL'],
  ['MULTITAP', 'Feedback 1->2', 'MULTITAP_FEEDBACK12'],
  ['MULTITAP', 'Feedback 4->1', 'MULTITAP_FEEDBACK41'],
  ['PITCH', 'Feedback 1->2', 'PITCH_FEEDBACK3'],
];

const cases: Array<[string, () => void]> = [
  ['gen-3 DELAY and MULTITAP are separate families', () => {
    for (const [dev, layouts] of DEVICES) {
      if (dev === 'AM4') continue;
      const delay = get(dev, layouts, 'DELAY');
      const multi = get(dev, layouts, 'MULTITAP');
      if (delay.editorName !== 'Delay') fail(`${dev} DELAY editorName '${delay.editorName}'`);
      if (multi.editorName !== 'MultiDelay') fail(`${dev} MULTITAP editorName '${multi.editorName}'`);
      for (const [family, block] of [['DELAY', delay], ['MULTITAP', multi]] as const) {
        for (const c of controlsOf(block)) {
          if (!c.paramName || c.crossBlock) continue;
          if (!c.paramName.startsWith(`${family}_`)) fail(`${dev} ${family}: foreign control '${c.paramName}'`);
        }
        const got = counts(block);
        if (got !== DELAY_COUNTS[dev][family]) fail(`${dev} ${family}: ${got}, expected ${DELAY_COUNTS[dev][family]}`);
      }
    }
  }],
  ['split variants carry their selector parameter', () => {
    for (const [dev, layouts] of DEVICES) {
      if (dev === 'AM4') continue;
      // DELAY variants are keyed by the routing type DELAY_TYPE, not the model selector DELAY_MODEL.
      for (const v of get(dev, layouts, 'DELAY').variants) {
        if (v.selectorParamName !== 'DELAY_TYPE') fail(`${dev} DELAY/${v.name}: selector ${v.selectorParamName}`);
      }
      const reverb = get(dev, layouts, 'REVERB').variants.filter((v) => v.selectorParamName !== undefined);
      if (reverb.length === 0) fail(`${dev} REVERB: no split variant`);
      for (const v of reverb) {
        if (v.selectorParamName !== 'REVERB_BASETYPE') fail(`${dev} REVERB/${v.name}: selector ${v.selectorParamName}`);
      }
      // Editor-keyed and versioned variants carry no generated selector.
      for (const fam of ['MULTITAP', 'DISTORT', 'GEQ']) {
        for (const v of get(dev, layouts, fam).variants) {
          if (v.selectorParamName !== undefined) fail(`${dev} ${fam}/${v.name}: unexpected selector ${v.selectorParamName}`);
        }
      }
    }
  }],
  ['catch-all pages reach every type no sibling page names', () => {
    const fm3 = (family: string) => get('FM3', FM3_LAYOUTS, family);
    const want = (got: string, expected: string, what: string) => {
      if (got !== expected) fail(`${what}: ${got}, expected ${expected}`);
    };
    // REVERB fw >= 10: the types the "Pitch Shift" page names get the catch-all Basic..EQ tabs too; the
    // "Ducker" tab of 0,5 keeps the catch-all "Duck + Mod" (same tab position) away from them.
    want(tabs(fm3('REVERB'), '1,2,3,6,7,8,9,10', '{"gtet":"10"}'), 'Basic | Advanced | Duck + Mod | EQ | Pitch Shift', 'FM3 REVERB 1,2,3,6..10');
    want(tabs(fm3('REVERB'), '0,5', '{"gtet":"10"}'), 'Basic | Advanced | Ducker | EQ', 'FM3 REVERB 0,5');
    want(tabs(fm3('REVERB'), 'Default', '{"gtet":"10"}'), 'Basic | Advanced | Duck + Mod | EQ', 'FM3 REVERB Default');
    // DELAY: the fw >= 8.00 catch-all Modulation reaches every type but 6, which names its own; an
    // `lt 8,00` page on the same tab does not block it (the gates never hold together).
    for (const t of ['0', '1', '2', '3', '4', '5', '7', 'Default']) {
      const mod = tabs(fm3('DELAY'), t).split(' | ').filter((n) => n.startsWith('Modulation')).join(' | ');
      want(mod, 'Modulation{lt:8,00} | Modulation{gtet:8,00}', `FM3 DELAY ${t} Modulation`);
    }
    const delay6 = fm3('DELAY').variants.find((v) => v.name === '6')!;
    const mod6 = delay6.pages.filter((p) => p.name === 'Modulation' && p.fw?.gtet === '8,00');
    const catchAll = fm3('DELAY').variants.find((v) => v.name === 'Default')!.pages.find((p) => p.name === 'Modulation' && p.fw?.gtet === '8,00');
    if (mod6.length !== 1 || mod6[0] === catchAll) fail('FM3 DELAY 6: exactly its own fw >= 8.00 Modulation page');
    // TREMOLO fw >= 8.00: types 0/2/4 draw the catch-all Tremolo page; the Panner type does not.
    want(tabs(fm3('TREMOLO'), '0,2,4'), 'Tremolo{lt:8,00} | Tremolo{gtet:8,00}', 'FM3 TREMOLO 0,2,4');
    want(tabs(fm3('TREMOLO'), '1'), 'Panner{lt:8,00} | Panner{gtet:8,00}', 'FM3 TREMOLO 1');
    // Axe-Fx III Chorus fw >= 32.03: the catch-all Expert tab reaches the types only the Basic tab names.
    want(tabs(get('III', AXE3_LAYOUTS, 'CHORUS'), '9', '{"gtet":"32,03"}'), 'Basic | Expert', 'III CHORUS 9');
    // AM4 Filter: the catch-all Config tab reaches the Modulation-only types; type 16 keeps its own tab.
    want(tabs(get('AM4', AM4_LAYOUTS, 'FILTER'), '4,5,6,9,10,11'), 'Config | Modulation', 'AM4 FILTER 4,5,6,9,10,11');
    want(tabs(get('AM4', AM4_LAYOUTS, 'FILTER'), '16'), 'Filter', 'AM4 FILTER 16');
  }],
  ['captions containing > stay on their own control', () => {
    for (const [dev, layouts] of DEVICES) {
      if (dev === 'AM4') continue;
      for (const [family, label, paramName] of ARROW_CAPTIONS) {
        const hits = controlsOf(get(dev, layouts, family)).filter((c) => c.label === label);
        if (hits.length === 0) fail(`${dev} ${family}: no control captioned ${JSON.stringify(label)}`);
        for (const c of hits) if (c.paramName !== paramName) fail(`${dev} ${family} ${JSON.stringify(label)} -> ${c.paramName}, expected ${paramName}`);
      }
    }
    const amp = controlsOf(get('AM4', AM4_LAYOUTS, 'GLOBAL')).filter((c) => c.label === 'Amp->Cab Type Linking');
    if (amp.length !== 1 || amp[0].paramName !== 'GLOBAL_DYNACAB_SYNC') fail('AM4 GLOBAL: Amp->Cab Type Linking control');
  }],
  ['editor names are unique per device', () => {
    for (const [dev, layouts] of DEVICES) {
      const seen = new Map<string, string>();
      for (const [family, block] of Object.entries(layouts)) {
        const prev = seen.get(block.editorName);
        if (prev) fail(`${dev}: editorName '${block.editorName}' on both ${prev} and ${family}`);
        seen.set(block.editorName, family);
      }
    }
  }],
  ['AM4 Global is its own family', () => {
    const global = get('AM4', AM4_LAYOUTS, 'GLOBAL');
    const amp = get('AM4', AM4_LAYOUTS, 'DISTORT');
    if (global.editorName !== 'Global') fail(`AM4 GLOBAL editorName '${global.editorName}'`);
    if (amp.editorName !== 'Amp') fail(`AM4 DISTORT editorName '${amp.editorName}'`);
    if (amp.variants.some((v) => v.name === 'Global')) fail('AM4 DISTORT still holds the Global variant');
    const pages = global.variants.flatMap((v) => v.pages.map((p) => p.name)).join(',');
    if (pages !== 'Audio,Footswitches,MIDI/Remote,Global') fail(`AM4 GLOBAL pages ${pages}`);
  }],
  ['per-device totals', () => {
    for (const [dev, layouts] of DEVICES) {
      const got = totals(layouts);
      if (got !== TOTALS[dev]) fail(`${dev}: families/variants/pages/controls ${got}, expected ${TOTALS[dev]}`);
    }
  }],
];

export const EDITOR_LAYOUT_FAMILIES_CASE_COUNT = cases.length;

export function runEditorLayoutFamiliesTests(): void {
  for (const [name, run] of cases) {
    try {
      run();
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
}
