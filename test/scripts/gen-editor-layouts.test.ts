/**
 * Editor-layout generator (`scripts/gen-editor-layouts.ts`) — unit goldens on
 * tiny inline XML (no editor material needed):
 *   1. the XML scan keeps quoted `>` inside the value and reads single-quoted
 *      attributes;
 *   2. structural errors throw instead of silently re-nesting the tree: a closing
 *      tag that does not match the open element, a stray closing tag, a tag or
 *      comment without its end, an element left open at the end;
 *   3. the page-selector splitter folds pages into per-type variants that carry
 *      the selector parameter;
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
