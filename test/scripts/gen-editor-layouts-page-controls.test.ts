/**
 * Editor-layout generator (`scripts/gen-editor-layouts.ts`) — page-level
 * controls, unit goldens on tiny inline XML (no editor material needed).
 *
 * A `<Page>` holds controls in the rows of its `<Parameters>` / `<Mixer>`
 * sections and, outside of them, directly under the page. The direct ones
 * become the page's `pageControls`:
 *   1. document order, wherever they sit between the sections; the rows are the
 *      same with and without them; other page children contribute nothing;
 *   2. same shape as a row control: paramId join, placement, firmware gate,
 *      cross-block reference, verbatim label/widget;
 *   3. a parameter of another family than the layout's own gets no id, unless a
 *      cross-block reference names its owner; row controls keep theirs;
 *   4. a page without rows is kept only when a page-level control has a
 *      parameter symbol; a label-only page is dropped;
 *   5. folding page-level type selectors into per-type variants keeps them;
 *   6. the serialiser writes them after the rows, and pages without any are
 *      written exactly as before.
 */
import {
  parseXml,
  buildPages,
  splitVariantByPageSelectors,
  serialize,
  type Resolver,
  type XmlNode,
} from '../../scripts/gen-editor-layouts.js';
import type { DeviceEditorLayouts, EditorLayoutControl, EditorLayoutPage } from '../../src/editorLayouts.js';

const fail = (msg: string): never => {
  throw new Error(`[scripts/gen-editor-layouts page controls] ${msg}`);
};

/** JSON with sorted object keys, so key order does not matter. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1)))
      : x,
  );

function same(got: unknown, want: unknown, what: string): void {
  const a = canon(got);
  const b = canon(want);
  if (a !== b) fail(`${what}:\n    got  ${a}\n    want ${b}`);
}

/** Synthetic catalog: the resolver joins by name, unknown names stay unresolved. */
const CATALOG: Record<string, { paramId: number; family: string }> = {
  BLK_A: { paramId: 1, family: 'BLK' },
  BLK_B: { paramId: 2, family: 'BLK' },
  BLK_MODE: { paramId: 41, family: 'BLK' },
  GLOBAL_TEMPO: { paramId: 900, family: 'GLOBAL' },
};
const resolve: Resolver = (name) => CATALOG[name] ?? { paramId: null, family: null };

const ctl = (attrs: string) => `<EditorControl ${attrs}/>`;
const A = ctl('name="A" type="knob" parameterName="BLK_A" col="0"');
const B = ctl('name="B" type="knob" parameterName="BLK_B" col="1"');
const MODE = ctl('name="Tracking&#10;Mode" type="dropdown1Tight" parameterName="BLK_MODE" positionExact="196,230" version_gtet="11,01"');
const TITLE = ctl('name="VOICE 1" type="sectionLabel" positionExact="305,29"');
const PARAMS = `<Parameters><Row>${A}</Row></Parameters>`;
const MIXER = `<Mixer><Row>${B}</Row></Mixer>`;

function variant(body: string): XmlNode {
  const node = parseXml(`<?xml version="1.0"?><EffectVariant name="V">${body}</EffectVariant>`).children[0];
  if (node?.tag !== 'EffectVariant') fail('fixture must hold one EffectVariant');
  return node!;
}
const pagesOf = (body: string): EditorLayoutPage[] => buildPages(variant(body), resolve, 'Block', 'BLK');
const labels = (cs: readonly EditorLayoutControl[] | undefined) => cs?.map((c) => c.label);

const cases: Array<[string, () => void]> = [
  ['page-level controls keep document order around the sections; rows are unchanged', () => {
    const plain = pagesOf(`<Page name="P" pageNum="2">${PARAMS}${MIXER}</Page>`);
    const mixed = pagesOf(`<Page name="P" pageNum="2">${TITLE}${PARAMS}${MODE}${MIXER}${ctl('name="END" type="labelSeperator"')}</Page>`);
    same(plain.length, 1, 'one page');
    if ('pageControls' in plain[0]) fail('a page without page-level controls must not carry the key');
    same(labels(mixed[0].pageControls), ['VOICE 1', 'Tracking\nMode', 'END'], 'document order');
    same(mixed[0].rows, plain[0].rows, 'rows with and without page-level controls');
    same([mixed[0].name, mixed[0].pageNum], ['P', 2], 'page attributes');
  }],
  ['only direct EditorControl children count: row controls and other page children do not leak', () => {
    const [p] = pagesOf(`<Page name="P">${PARAMS}<Table>${B}</Table>${TITLE}<Parameters>${MODE}<Row>${B}</Row></Parameters></Page>`);
    same(labels(p.pageControls), ['VOICE 1'], 'page-level controls');
    same(p.rows.map((r) => labels(r.controls)), [['A'], ['B']], 'rows');
  }],
  ['same shape as a row control: join, placement, gate, label and widget verbatim', () => {
    const [p] = pagesOf(`<Page name="P">${PARAMS}${MODE}${TITLE}${ctl('name="X" type="knobMini" parameterName="BLK_GONE" offsetX="3" offsetY="-4"')}</Page>`);
    same(p.pageControls, [
      {
        label: 'Tracking\nMode', paramName: 'BLK_MODE', paramId: 41, widget: 'dropdown', rawWidget: 'dropdown1Tight',
        placement: { positionExact: '196,230' }, fw: { gtet: '11,01' },
      },
      { label: 'VOICE 1', paramName: null, paramId: null, widget: 'label', rawWidget: 'sectionLabel', placement: { positionExact: '305,29' } },
      { label: 'X', paramName: 'BLK_GONE', paramId: null, widget: 'knob', rawWidget: 'knobMini', placement: { offsetX: 3, offsetY: -4 } },
    ], 'page-level controls');
    // the same element in a row yields the same control
    const [row] = pagesOf(`<Page name="P"><Parameters><Row>${MODE}</Row></Parameters></Page>`);
    same(p.pageControls![0], row.rows[0].controls[0], 'row control vs page-level control');
  }],
  ['firmware gates: each control keeps its own bounds', () => {
    const [p] = pagesOf(
      `<Page name="P" version_gtet="2,00">${PARAMS}` +
        ctl('name="old" type="toggle" parameterName="BLK_A" version_lt="3,00"') +
        ctl('name="new" type="dropdown1" parameterName="BLK_A" version_gtet="3,00"') +
        ctl('name="mid" type="knob" parameterName="BLK_B" version_gtet="3,00" version_lt="4,05"') +
        '</Page>',
    );
    same(p.fw, { gtet: '2,00' }, 'page gate');
    same(p.pageControls!.map((c) => c.fw), [{ lt: '3,00' }, { gtet: '3,00' }, { gtet: '3,00', lt: '4,05' }], 'control gates');
  }],
  ['cross-block reference: owning effect, family and paramId', () => {
    const [p] = pagesOf(`<Page name="P">${PARAMS}${ctl('name="Tempo" type="knob" parameterName="GLOBAL_TEMPO" effectName="ID_GLOBAL"')}${ctl('name="?" type="knob" effectName="ID_MODIFIER1"')}</Page>`);
    same(p.pageControls!.map((c) => c.crossBlock), [
      { effect: 'ID_GLOBAL', family: 'GLOBAL', paramName: 'GLOBAL_TEMPO', paramId: 900 },
      { effect: 'ID_MODIFIER1', family: null, paramName: null, paramId: null },
    ], 'crossBlock');
    same(p.pageControls!.map((c) => c.paramId), [900, null], 'paramIds');
  }],
  ['a parameter of another family has no id, unless a cross-block reference names its owner; rows keep theirs', () => {
    const tempo = (extra = '') => ctl(`name="Tempo" type="knob" parameterName="GLOBAL_TEMPO"${extra}`);
    const [p] = pagesOf(`<Page name="P"><Parameters><Row>${tempo()}</Row></Parameters>${tempo()}${tempo(' effectName="ID_GLOBAL"')}${A}</Page>`);
    same(p.pageControls!.map((c) => [c.paramName, c.paramId, c.crossBlock?.paramId ?? null]), [
      ['GLOBAL_TEMPO', null, null], ['GLOBAL_TEMPO', 900, 900], ['BLK_A', 1, null],
    ], 'page-level ids');
    same(p.rows[0].controls.map((c) => c.paramId), [900], 'row id');
    // the same page owned by the other family: the foreign one is the block's own then
    const [q] = buildPages(variant(`<Page name="P">${PARAMS}${tempo()}${A}</Page>`), resolve, 'Global', 'GLOBAL');
    same(q.pageControls!.map((c) => c.paramId), [900, null], 'ids under the other owner');
    // a catalog without families (AM4) withholds nothing
    const bare: Resolver = (name) => ({ paramId: CATALOG[name]?.paramId ?? null, family: null });
    const [r] = buildPages(variant(`<Page name="P">${PARAMS}${tempo()}${A}</Page>`), bare, 'Block', 'BLK');
    same(r.pageControls!.map((c) => c.paramId), [900, 1], 'ids without families');
    // it still counts as a parameter: the page is kept without rows
    same(pagesOf(`<Page name="P">${tempo()}</Page>`).length, 1, 'page of a foreign parameter alone');
  }],
  ['a page without rows: label-only is dropped, one with a parameter is kept with empty rows', () => {
    same(pagesOf(`<Page name="P">${TITLE}</Page>`), [], 'label-only page');
    same(pagesOf(`<Page name="P"><Parameters><Row></Row></Parameters>${TITLE}</Page>`), [], 'label-only page with an empty row');
    same(pagesOf('<Page name="P"></Page>'), [], 'empty page');
    const [p, ...rest] = pagesOf(`<Page name="P">${TITLE}${MODE}</Page>`);
    same(rest.length, 0, 'one page');
    same(p.rows, [], 'rows');
    same(labels(p.pageControls), ['VOICE 1', 'Tracking\nMode'], 'page-level controls');
    // unresolved still counts as a parameter: the editor symbol decides, not the join
    same(pagesOf(`<Page name="P">${ctl('type="knob" parameterName="BLK_GONE"')}</Page>`).length, 1, 'unresolved parameter');
  }],
  ['page-level type selectors fold into variants that keep each page\'s own page-level controls', () => {
    const pages = pagesOf(
      `<Page name="Main" parameterName="BLK_TYPE" value="0,2">${PARAMS}${MODE}</Page>` +
        `<Page name="Main" parameterName="BLK_TYPE" value="1">${MIXER}</Page>` +
        `<Page name="Mix">${MIXER}${TITLE}</Page>`,
    );
    const out = splitVariantByPageSelectors({ name: 'V', value: null, pages });
    same(
      out.map((v) => [v.value, v.pages.map((p) => [p.name, p.selectorParamName ?? null, labels(p.pageControls) ?? null])]),
      [
        ['0,2', [['Main', null, ['Tracking\nMode']], ['Mix', null, ['VOICE 1']]]],
        ['1', [['Main', null, null], ['Mix', null, ['VOICE 1']]]],
      ],
      'split variants',
    );
  }],
  ['serialiser: page-level controls follow the rows, other pages are written as before', () => {
    const layoutsOf = (pages: EditorLayoutPage[]): DeviceEditorLayouts => ({
      BLK: { editorName: 'Block', family: 'BLK', variants: [{ name: 'V', value: null, pages }] },
    });
    const pages = [
      ...pagesOf(`<Page name="One" pageNum="0">${PARAMS}${TITLE}${MODE}</Page>`),
      ...pagesOf(`<Page name="Two">${MIXER}</Page>`),
      ...pagesOf(`<Page name="Three">${MODE}</Page>`),
    ];
    const text = serialize(layoutsOf(pages));
    same(new Function(`return ${text}`)(), layoutsOf(pages), 'round trip');
    // purely additive: without the page-level block the document is the one without page-level controls
    const withRows = pages.slice(0, 2);
    const lines = serialize(layoutsOf(withRows)).split('\n');
    const at = lines.indexOf('        ], "pageControls": [');
    same(
      lines.splice(at, 3),
      [
        '        ], "pageControls": [',
        `          ${JSON.stringify(withRows[0].pageControls![0])},`,
        `          ${JSON.stringify(withRows[0].pageControls![1])},`,
      ],
      'emitted block',
    );
    const bare = withRows.map(({ pageControls: _pc, ...rest }) => rest as EditorLayoutPage);
    same(lines.join('\n'), serialize(layoutsOf(bare)), 'document without the block');
  }],
];

export const GEN_LAYOUT_PAGE_CONTROLS_CASE_COUNT = cases.length;

export function runGenLayoutPageControlsTests(): void {
  for (const [name, run] of cases) {
    try {
      run();
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
}
