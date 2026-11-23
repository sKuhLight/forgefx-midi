/**
 * Editor-layout generator (`scripts/gen-editor-layouts.ts`) — unit goldens on
 * tiny inline XML (no editor material needed):
 *   1. the XML scan keeps quoted `>` inside the value and reads single-quoted
 *      attributes;
 *   2. structural errors throw instead of silently re-nesting the tree: a closing
 *      tag that does not match the open element, a stray closing tag, a tag or
 *      comment without its end, an element left open at the end;
 *   3. the page-selector splitter folds pages into per-type variants that carry
 *      the selector parameter, and gives a catch-all page (`value=""`) to every
 *      type no explicitly-valued page on the same tab position (with a firmware
 *      gate that contains the catch-all's) names; a sibling gate that only
 *      partly covers the catch-all's, or a catch-all listed before a sibling it
 *      yields to, throws;
 *   4. the per-variant family path: a component hosting two catalog families
 *      yields both, a variant whose prefix is no catalog family stays with its
 *      component, and without catalog families nothing moves.
 */
import {
  parseXml,
  parseBlockLayout,
  splitVariantByPageSelectors,
  type Resolver,
} from '../../scripts/gen-editor-layouts.js';
import type { EditorLayoutVariant } from '../../src/editorLayouts.js';

const fail = (msg: string): never => {
  throw new Error(`[scripts/gen-editor-layouts] ${msg}`);
};

function expectThrow(xml: string, pattern: RegExp, what: string): void {
  try {
    parseXml(xml);
  } catch (e) {
    const msg = (e as Error).message;
    if (!pattern.test(msg)) fail(`${what}: unexpected error '${msg}'`);
    return;
  }
  fail(`${what}: parseXml accepted ${JSON.stringify(xml)}`);
}

/** Resolver stub: any name resolves (paramId = name length), family = name prefix. */
const resolveStub: Resolver = (name) => ({ paramId: name.length, family: name.split('_')[0] });

const ctl = (name: string, param: string) => `<EditorControl name="${name}" parameterName="${param}" type="knob"/>`;
const page = (name: string, body: string, attrs = '') =>
  `<Page name="${name}"${attrs}><Parameters><Row>${body}</Row></Parameters></Page>`;

const cases: Array<[string, () => void]> = [
  ['quoted > stays in the value; single-quoted attributes are read', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- c > d --><Row><EditorControl name="Feedback&#10;L>R" parameterName='DELAY_FEEDLR'/>` +
        `<EditorControl name="Feedback 1->2" parameterName="MULTITAP_FEEDBACK12"/></Row>`,
    );
    const row = root.children[0];
    if (root.children.length !== 1 || row.tag !== 'Row') fail('root must hold one Row');
    if (row.children.length !== 2) fail(`Row must hold 2 controls, got ${row.children.length}`);
    const [a, b] = row.children;
    if (a.attrs.name !== 'Feedback\nL>R' || a.attrs.parameterName !== 'DELAY_FEEDLR') fail(`first control ${JSON.stringify(a.attrs)}`);
    if (b.attrs.name !== 'Feedback 1->2' || b.children.length !== 0) fail(`second control ${JSON.stringify(b.attrs)}`);
  }],
  ['a closing tag must match the open element', () => {
    expectThrow('<A><B></A></B>', /closing tag <\/A> .* open <B>/, 'crossed closing tags');
    expectThrow('<A></A></A>', /closing tag <\/A> .* any open element/, 'stray closing tag');
    expectThrow('</A>', /any open element/, 'closing tag without an open element');
  }],
  ['unterminated constructs and unclosed elements throw', () => {
    expectThrow('<A><B name="x" ', /unterminated tag/, 'tag without its end');
    expectThrow('<A name="unclosed quote>', /unterminated tag/, 'quote running to the end');
    expectThrow('<A><!-- no end', /unterminated comment/, 'comment without its end');
    expectThrow('<A><B/>', /<A> is never closed/, 'element open at the end');
  }],
  ['page selectors fold into per-type variants carrying the selector', () => {
    const base: EditorLayoutVariant = {
      name: 'Delay',
      value: null,
      pages: [
        { name: 'Time', rows: [{ section: 'parameters', controls: [] }], selectorParamName: 'DELAY_TYPE', value: '0' },
        { name: 'Time', rows: [{ section: 'parameters', controls: [] }], selectorParamName: 'DELAY_TYPE', value: '1' },
        { name: 'EQ', rows: [{ section: 'parameters', controls: [] }] },
        { name: 'Time', rows: [{ section: 'parameters', controls: [] }], selectorParamName: 'DELAY_TYPE', value: '' },
      ],
    };
    const out = splitVariantByPageSelectors(base);
    const shape = out.map((v) => `${v.name}|${v.value}|${v.selectorParamName}|${v.pages.length}`).join(' ');
    if (shape !== '0|0|DELAY_TYPE|2 1|1|DELAY_TYPE|2 Default|null|DELAY_TYPE|2') fail(`split ${shape}`);
    for (const v of out) for (const p of v.pages) {
      if (p.selectorParamName !== undefined || p.value !== undefined) fail('split pages must drop the page-level selector');
    }
    const plain = splitVariantByPageSelectors({ name: 'Plain', value: null, pages: [base.pages[2]] });
    if (plain.length !== 1 || plain[0].selectorParamName !== undefined) fail('a selector-less variant stays as it is');
  }],
  ['a catch-all page reaches every type no sibling on its tab names', () => {
    // Each page carries one control whose label identifies it.
    const pg = (id: string, name: string, pageNum: number, value?: string, fw?: { gtet?: string; lt?: string }) => ({
      name,
      pageNum,
      rows: [{ section: 'parameters' as const, controls: [{ label: id, paramName: null, paramId: null, widget: 'knob' as const, rawWidget: 'knob' }] }],
      ...(fw ? { fw } : {}),
      ...(value !== undefined ? { selectorParamName: 'T_TYPE', value } : {}),
    });
    const base: EditorLayoutVariant = {
      name: 'T',
      value: null,
      pages: [
        pg('main0', 'Main', 0, '0'),
        pg('alt1', 'Alt', 0, '1'), // another tab on position 0: keeps the catch-all Main away from 1
        pg('mainAny', 'Main', 0, ''),
        pg('extra2', 'Extra', 1, '2'), // type 2 is named only on another tab
        pg('mod3', 'Mod', 2, '3', { gtet: '8,00' }),
        pg('modOld', 'Mod', 2, undefined, { lt: '8,00' }), // selector-less: claims nothing
        pg('modAny', 'Mod', 2, '', { gtet: '8,00' }),
        pg('old0', 'Old', 3, '0', { lt: '5' }), // never holds together with the gtet 5 catch-all
        pg('oldAny', 'Old', 3, '', { gtet: '5' }),
      ],
    };
    const out = splitVariantByPageSelectors(base);
    const shape = out
      .map((v) => `${v.name}=${v.pages.map((p) => p.rows[0].controls[0].label).join(',')}`)
      .join(' ');
    const expected = [
      '0=main0,modOld,modAny,old0,oldAny',
      '1=alt1,modOld,modAny,oldAny',
      '2=mainAny,extra2,modOld,modAny,oldAny',
      '3=mainAny,mod3,modOld,oldAny',
      'Default=mainAny,modOld,modAny,oldAny',
    ].join(' ');
    if (shape !== expected) fail(`catch-all fold ${shape}`);
  }],
  ['a catch-all yields only where the sibling gate contains its own; partial cover and order throw', () => {
    const pg = (id: string, name: string, pageNum: number, value?: string, fw?: { gtet?: string; lt?: string }) => ({
      name,
      pageNum,
      rows: [{ section: 'parameters' as const, controls: [{ label: id, paramName: null, paramId: null, widget: 'knob' as const, rawWidget: 'knob' }] }],
      ...(fw ? { fw } : {}),
      ...(value !== undefined ? { selectorParamName: 'T_TYPE', value } : {}),
    });
    const shapeOf = (pages: EditorLayoutVariant['pages']) =>
      splitVariantByPageSelectors({ name: 'T', value: null, pages }, 'TFAM')
        .map((v) => `${v.name}=${v.pages.map((p) => p.rows[0].controls[0].label).join(',')}`)
        .join(' ');
    // An ungated sibling contains the catch-all's gtet 9 gate: type 4 never draws the catch-all.
    const contained = shapeOf([pg('w4', 'Wide', 0, '4'), pg('wAny', 'Wide', 0, '', { gtet: '9' }), pg('x5', 'X', 1, '5')]);
    if (contained !== '4=w4 5=wAny,x5 Default=wAny') fail(`containment ${contained}`);
    const expectSplitThrow = (pages: EditorLayoutVariant['pages'], pattern: RegExp, what: string) => {
      try {
        shapeOf(pages);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/^TFAM variant 'T': /.test(msg) || !pattern.test(msg)) fail(`${what}: unexpected error '${msg}'`);
        return;
      }
      fail(`${what}: the splitter accepted it`);
    };
    // The sibling holds on part of the catch-all's firmware only: which page type 4 shows there is not decidable.
    expectSplitThrow([pg('n4', 'Main', 0, '4', { gtet: '8,00' }), pg('nAny', 'Main', 0, '')], /only partly covers/, 'narrower sibling');
    expectSplitThrow(
      [pg('s4', 'Main', 0, '4', { lt: '10' }), pg('sAny', 'Main', 0, '', { gtet: '8,00' })],
      /'Main' \(T_TYPE="4", lt 10\).*only partly covers/,
      'straddling sibling',
    );
    // A catch-all listed before the sibling it yields to.
    expectSplitThrow([pg('eAny', 'Main', 0, ''), pg('e4', 'Main', 0, '4')], /precedes the sibling/, 'catch-all first');
  }],
  ['per-variant family: a merged component yields both families', () => {
    const xml =
      `<CONFIG><EditorControls name="Delay"><EffectVariants>` +
      `<EffectVariant value="" name="Delay">${page('Time', ctl('Time', 'DELAY_TIME') + ctl('Feedback L>R', 'DELAY_FEEDLR') + ctl('Mix', 'BLOCK_MIX'))}</EffectVariant>` +
      `<EffectVariant value="0" name="Quad-Tap">${page('Taps', ctl('Time 1', 'MULTITAP_TIME1') + ctl('Time 2', 'MULTITAP_TIME2') + ctl('Time 3', 'MULTITAP_TIME3'))}</EffectVariant>` +
      `<EffectVariant value="1" name="Mixer Only">${page('Mix', ctl('Mix', 'BLOCK_MIX'))}</EffectVariant>` +
      `</EffectVariants></EditorControls></CONFIG>`;
    const root = parseXml(xml);

    const split = parseBlockLayout(root, resolveStub, false, new Set(['DELAY', 'MULTITAP']));
    const fams = [...split.keys()].sort().join(',');
    if (fams !== 'DELAY,MULTITAP') fail(`families ${fams}`);
    const delay = split.get('DELAY')!;
    const multi = split.get('MULTITAP')!;
    if (delay.editorName !== 'Delay' || multi.editorName !== 'MultiDelay') fail(`editor names ${delay.editorName}/${multi.editorName}`);
    // Component mode: MULTITAP 3, DELAY 2, BLOCK 2. BLOCK_* is no catalog family,
    // so the mixer-only variant stays with the component's family.
    const multiNames = multi.variants.map((v) => v.name).join(',');
    if (multiNames !== 'Quad-Tap,Mixer Only') fail(`MULTITAP variants ${multiNames}`);
    if (delay.variants.map((v) => v.name).join(',') !== 'Delay') fail('DELAY variants');
    const caption = delay.variants[0].pages[0].rows[0].controls[1];
    if (caption.label !== 'Feedback L>R' || caption.paramName !== 'DELAY_FEEDLR') fail('quoted > caption lost its control');

    // Without catalog families (AM4 catalog), nothing moves: one family, the component mode.
    const merged = parseBlockLayout(root, resolveStub, false, new Set());
    if ([...merged.keys()].join(',') !== 'MULTITAP' || merged.get('MULTITAP')!.variants.length !== 3) {
      fail(`no-family catalog: ${[...merged.keys()].join(',')}`);
    }
    if (merged.get('MULTITAP')!.editorName !== 'Delay') fail('the component keeps its own editor name');
  }],
];

export const GEN_EDITOR_LAYOUTS_CASE_COUNT = cases.length;

export function runGenEditorLayoutsTests(): void {
  for (const [name, run] of cases) {
    try {
      run();
    } catch (e) {
      throw new Error(`${name}: ${(e as Error).message}`);
    }
  }
}
