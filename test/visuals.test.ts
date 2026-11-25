/**
 * Block visuals — role resolution per device + graph-slot normalisation.
 *
 * Covers `src/visuals.ts` (role tables, resolver, slot normaliser, stamping) and
 * `src/devices/gen3/visuals.ts` (binding to each gen-3 device's own catalog):
 *   - per model (FM3 / FM9 / Axe-Fx III) every served paramId is that device's own id for the
 *     role's symbol — no id ever leaks from another device's catalog;
 *   - required roles: a visual is dropped when no `requires` group resolves; optional roles are
 *     simply left out; the presence filter drops absent roles (monitors exempt);
 *   - strict layout narrowing (the server adds a Default variant's controls for add-on variants:
 *     the reverb types whose only page is 'Pitch Shift' then keep their decay visual);
 *   - COMP variants: full curve / THRESH2-only / SUSTAIN-only (gain-reduction display) / none;
 *   - GATE variants, TREMOLO tremolo vs panner, CONTROLLERS lfo1/lfo2/adsr1/adsr2;
 *   - DELAY resolves without a layout (none ships on any of the three devices);
 *   - graph-slot normalisation of the layout tokens, and stamping over every shipped layout.
 */
import {
  BLOCK_VISUAL_DEFS,
  VISUAL_KEYS,
  graphSlotKey,
  layoutParamIds,
  resolveBlockVisuals,
  stampGraphKeys,
  type BlockVisual,
  type GraphSlotKey,
  type VisualCatalogParam,
} from '../src/visuals.js';
import { blockVisuals, gen3VisualModel, hasBlockVisuals, type Gen3VisualModel } from '../src/devices/gen3/visuals.js';
import { FM3_PARAMS_BY_FAMILY, FM3_LAYOUTS } from '../src/gen3/fm3/index.js';
import { FM9_PARAMS_BY_FAMILY, FM9_LAYOUTS } from '../src/gen3/fm9/index.js';
import { PARAMS_BY_FAMILY as AXE3_PARAMS_BY_FAMILY, AXE3_LAYOUTS } from '../src/gen3/axe-fx-iii/index.js';
import type { DeviceEditorLayouts, EditorLayoutPage } from '../src/editorLayouts.js';

export const VISUALS_CASE_COUNT = 15;

type Catalog = Readonly<Record<string, readonly VisualCatalogParam[]>>;
const DEVICES: ReadonlyArray<{ model: Gen3VisualModel; byte: number; catalog: Catalog; layouts: DeviceEditorLayouts }> = [
  { model: 'fm3', byte: 0x11, catalog: FM3_PARAMS_BY_FAMILY as unknown as Catalog, layouts: FM3_LAYOUTS as unknown as DeviceEditorLayouts },
  { model: 'fm9', byte: 0x12, catalog: FM9_PARAMS_BY_FAMILY as unknown as Catalog, layouts: FM9_LAYOUTS as unknown as DeviceEditorLayouts },
  { model: 'axe3', byte: 0x10, catalog: AXE3_PARAMS_BY_FAMILY as unknown as Catalog, layouts: AXE3_LAYOUTS as unknown as DeviceEditorLayouts },
];

function fail(msg: string): never {
  throw new Error(`[visuals] ${msg}`);
}
function eq<T>(got: T, want: T, msg: string): void {
  if (got !== want) fail(`${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function idOf(catalog: Catalog, family: string, name: string): number | undefined {
  return catalog[family]?.find((p) => p.name === name)?.paramId;
}
function byKey(vs: readonly BlockVisual[], key: string): BlockVisual | undefined {
  return vs.find((v) => v.key === key);
}
function rolesOf(v: BlockVisual | undefined): string {
  return v ? Object.keys(v.roles).sort().join(',') : '-';
}
/** Pages of the named variant of a family's layout (all of them, as shipped). */
function variantPages(layouts: DeviceEditorLayouts, family: string, name: string): EditorLayoutPage[] {
  const v = layouts[family]?.variants.find((x) => x.name === name);
  if (!v) fail(`no '${name}' variant in ${family}`);
  return v.pages;
}

// ── 1. every symbol of every table exists on every device ─────────────────
function symbolsResolveEverywhere(): void {
  for (const d of DEVICES) {
    for (const [family, defs] of Object.entries(BLOCK_VISUAL_DEFS)) {
      for (const def of defs) {
        for (const symbol of [...Object.values(def.roles), ...Object.values(def.monitorRoles ?? {})]) {
          if (idOf(d.catalog, family, symbol as string) == null) fail(`${d.model}: ${family} symbol ${symbol} is not in the catalog`);
        }
      }
      // with the full catalog (no presence filter) every visual of the family is offered
      const keys = blockVisuals(d.model, family).map((v) => v.key).join(',');
      eq(keys, defs.map((x) => x.key).join(','), `${d.model} ${family}: all visuals offered on the full catalog`);
    }
  }
}

// ── 2. ids come from the device's OWN catalog (no cross-device leak) ──────
function idsAreDeviceOwn(): void {
  let differing = 0;
  for (const d of DEVICES) {
    for (const [family, defs] of Object.entries(BLOCK_VISUAL_DEFS)) {
      const served = blockVisuals(d.model, family);
      for (const def of defs) {
        const v = byKey(served, def.key)!;
        for (const [role, symbol] of Object.entries({ ...def.roles, ...def.monitorRoles })) {
          const want = idOf(d.catalog, family, symbol as string);
          eq((v.roles as Record<string, number>)[role], want, `${d.model} ${family}.${def.key}.${role} (${symbol})`);
          for (const other of DEVICES) {
            if (other === d) continue;
            const otherId = idOf(other.catalog, family, symbol as string);
            if (otherId !== want) differing++;
          }
        }
      }
    }
  }
  if (differing === 0) fail('expected at least one symbol whose paramId differs across devices (else the leak check proves nothing)');
  // spot checks where the devices genuinely disagree
  const time = (m: Gen3VisualModel) => byKey(blockVisuals(m, 'DELAY'), 'echo')?.roles.time;
  eq(time('fm3'), 8, 'FM3 DELAY_TIME');
  eq(time('fm9'), 12, 'FM9 DELAY_TIME');
  eq(time('axe3'), 2, 'III DELAY_TIME');
  const rt = (m: Gen3VisualModel) => byKey(blockVisuals(m, 'REVERB'), 'decay')?.roles.time;
  eq(rt('fm3'), 1, 'FM3 REVERB_TIME');
  eq(rt('fm9'), 11, 'FM9 REVERB_TIME');
  eq(rt('axe3'), 1, 'III REVERB_TIME');
  const skew = (m: Gen3VisualModel) => byKey(blockVisuals(m, 'CONTROLLERS'), 'lfo1')?.roles.skew;
  eq(skew('fm3'), 119, 'FM3 CONTROLLERS_LFO1BETA');
  eq(skew('axe3'), 167, 'III CONTROLLERS_LFO1BETA');
  const curve = (m: Gen3VisualModel) => byKey(blockVisuals(m, 'CONTROLLERS'), 'adsr2')?.roles.curve;
  eq(curve('fm3'), 129, 'FM3 CONTROLLERS_ADSR2_TYPE');
  eq(curve('axe3'), 177, 'III CONTROLLERS_ADSR2_TYPE');
  // the model byte resolves the same catalog as the key
  for (const d of DEVICES) {
    eq(JSON.stringify(blockVisuals(d.byte, 'COMP')), JSON.stringify(blockVisuals(d.model, 'COMP')), `${d.model} by model byte`);
  }
}

// ── 3. required vs optional roles ─────────────────────────────────────────
function requiredRoles(): void {
  const rows = (names: Record<string, number>): VisualCatalogParam[] => Object.entries(names).map(([name, paramId]) => ({ name, paramId }));
  // REVERB: time is required, the rest optional
  eq(resolveBlockVisuals(rows({ REVERB_PREDELAY: 9, REVERB_EARLYLEVEL: 7 }), 'REVERB').length, 0, 'REVERB without TIME → dropped');
  const onlyTime = resolveBlockVisuals(rows({ REVERB_TIME: 42 }), 'REVERB');
  eq(onlyTime.length, 1, 'REVERB with TIME only → offered');
  eq(rolesOf(onlyTime[0]), 'time', 'REVERB optional roles left out');
  eq(onlyTime[0]!.roles.time, 42, 'REVERB time id from the given catalog');
  // CABINET needs both delays (CABINET_ZOOM is no role: an unknown symbol here is simply ignored)
  eq(resolveBlockVisuals(rows({ CABINET_DELAY1: 16, CABINET_ZOOM: 40 }), 'CABINET').length, 0, 'CABINET with one delay → dropped');
  eq(rolesOf(resolveBlockVisuals(rows({ CABINET_DELAY1: 16, CABINET_DELAY2: 17, CABINET_ZOOM: 40 }), 'CABINET')[0]), 'delay1,delay2', 'CABINET roles: the two delays only');
  // the presence filter drops a required role → visual gone; an unrelated visual of the family stays
  const fm3Filter = FM3_PARAMS_BY_FAMILY.FILTER!;
  const allButFreq = fm3Filter.filter((p) => p.name !== 'FILTER_FREQ').map((p) => p.paramId);
  const filtered = blockVisuals('fm3', 'FILTER', allButFreq);
  eq(byKey(filtered, 'response'), undefined, 'FILTER without FREQ present → no response');
  eq(byKey(filtered, 'lfo')?.key, 'lfo', 'FILTER LFO unaffected by FREQ');
  // empty presence set → nothing but monitor-only roles, which never satisfy a requirement
  eq(blockVisuals('fm3', 'COMP', []).length, 0, 'COMP with nothing present → dropped');
  // unknown family / device
  eq(blockVisuals('fm3', 'NOT_A_FAMILY').length, 0, 'unknown family');
  eq(resolveBlockVisuals(undefined, 'COMP').length, 0, 'no catalog rows');
}

/** A family's visuals narrowed by one shipped layout variant (no present filter). */
function withLayout(model: Gen3VisualModel, family: string, pages: readonly EditorLayoutPage[]): BlockVisual[] {
  return blockVisuals(model, family, null, { layoutParamIds: layoutParamIds(pages) });
}

// ── 4. COMP variants (from the shipped layouts) ───────────────────────────
function compVariants(): void {
  for (const d of DEVICES) {
    const visual = (variant: string) => byKey(withLayout(d.model, 'COMP', variantPages(d.layouts, 'COMP', variant)), 'dynamics');
    const full = visual('Studio FF');
    eq(full?.title, 'Compressor curve', `${d.model} Studio FF title`);
    eq(full?.mode, 'compressor', `${d.model} Studio FF mode`);
    eq(rolesOf(full), 'autoMakeup,gainReduction,knee,level,mix,ratio,threshold', `${d.model} Studio FF roles`);
    const thresh2 = visual('Dynamics');
    eq(thresh2?.title, 'Gain reduction', `${d.model} Dynamics (THRESH2-only) title`);
    eq(rolesOf(thresh2), 'gainReduction,level,mix,threshold2', `${d.model} Dynamics roles`);
    const sustain = visual('Pedal1');
    eq(sustain?.title, 'Gain reduction', `${d.model} Pedal1 (SUSTAIN-only) title`);
    eq(rolesOf(sustain), 'gainReduction,level,mix,sustain', `${d.model} Pedal1 roles`);
    eq(visual('Compander'), undefined, `${d.model} Compander: no threshold/sustain → no visual`);
    // the monitor role survives a presence set that lacks it
    const thrRatio = [idOf(d.catalog, 'COMP', 'COMP_THRESH')!, idOf(d.catalog, 'COMP', 'COMP_RATIO')!];
    eq(rolesOf(byKey(blockVisuals(d.model, 'COMP', thrRatio), 'dynamics')), 'gainReduction,ratio,threshold', `${d.model} monitor role is never presence-filtered`);
    // present set and layout narrowing combine: a role must pass both
    const pedal1 = layoutParamIds(variantPages(d.layouts, 'COMP', 'Pedal1'));
    const noMix = [...pedal1].filter((id) => id !== idOf(d.catalog, 'COMP', 'COMP_MIX'));
    eq(rolesOf(byKey(blockVisuals(d.model, 'COMP', noMix, { layoutParamIds: pedal1 }), 'dynamics')), 'gainReduction,level,sustain', `${d.model} Pedal1 minus a non-present MIX`);
  }
}

// ── 4b. layout narrowing is strict (the server decides the Default-variant exception) ──
function layoutNarrowing(): void {
  const rows = (names: Record<string, number>): VisualCatalogParam[] => Object.entries(names).map(([name, paramId]) => ({ name, paramId }));
  const catalog = rows({ REVERB_TIME: 1, REVERB_PREDELAY: 9, REVERB_EARLYLEVEL: 7, REVERB_SHIFT1: 54 });
  eq(resolveBlockVisuals(catalog, 'REVERB', null, { layoutParamIds: [54] }).length, 0, 'a layout showing none of the decay params → no decay');
  eq(rolesOf(resolveBlockVisuals(catalog, 'REVERB', null, { layoutParamIds: [1, 54] })[0]), 'time', 'roles narrowed to what the layout shows');
  eq(resolveBlockVisuals(catalog, 'REVERB', null, { layoutParamIds: [9] }).length, 0, 'layout without the required role → dropped');
  eq(rolesOf(resolveBlockVisuals(catalog, 'REVERB', [1, 9], { layoutParamIds: [1, 7, 9] })[0]), 'predelay,time', 'present set and layout both apply');
  // real data: the shift-capable REVERB variants resolve their pages from the source's catch-all rule, so
  // every variant that lists decay-bearing pages keeps the decay visual; the "layout without the decay
  // params drops it" case is covered above with a synthetic catalog (the current source has no variant
  // whose only page is Pitch Shift)
  for (const d of DEVICES) {
    const shift = d.layouts.REVERB!.variants.find((v) => v.value === '1,2,3,6,7,8,9,10');
    if (!shift) fail(`${d.model}: no REVERB '1,2,3,6,7,8,9,10' variant`);
    if (!layoutParamIds(shift.pages).size) fail(`${d.model}: shift variant resolves no parameter`);
    if (byKey(withLayout(d.model, 'REVERB', shift.pages), 'decay')?.roles.time == null) fail(`${d.model} shift variant → decay with time`);
    const dflt = d.layouts.REVERB!.variants.find((v) => v.value === null);
    if (!dflt) fail(`${d.model}: no REVERB Default variant`);
    const union = new Set([...layoutParamIds(shift.pages), ...layoutParamIds(dflt.pages)]);
    if (byKey(blockVisuals(d.model, 'REVERB', null, { layoutParamIds: union }), 'decay')?.roles.time == null) fail(`${d.model} shift ∪ Default → decay with time`);
  }
}

// ── 5. GATE variants ──────────────────────────────────────────────────────
function gateVariants(): void {
  for (const d of DEVICES) {
    const visual = (variant: string) => byKey(withLayout(d.model, 'GATE', variantPages(d.layouts, 'GATE', variant)), 'dynamics');
    const withRatio = visual('3');
    eq(withRatio?.mode, 'gate', `${d.model} GATE mode`);
    eq(withRatio?.title, 'Gate curve', `${d.model} GATE title`);
    if (withRatio?.roles.ratio == null || withRatio.roles.knee == null) fail(`${d.model} GATE type 3: ratio + knee expected`);
    const rangeOnly = visual('1,2');
    if (rangeOnly?.roles.range == null) fail(`${d.model} GATE types 1,2: range expected (a gate with no ratio is still drawn)`);  }
}

// ── 6. TREMOLO: tremolo vs panner ─────────────────────────────────────────
function tremoloModes(): void {
  for (const d of DEVICES) {
    const visual = (variant: string) => byKey(withLayout(d.model, 'TREMOLO', variantPages(d.layouts, 'TREMOLO', variant)), 'lfo');
    const panner = visual('1');
    eq(panner?.mode, 'panner', `${d.model} TREMOLO panner mode`);
    eq(panner?.title, 'Panner LFO', `${d.model} panner title`);
    if (panner?.roles.width == null || panner.roles.center == null || panner.roles.depth != null) fail(`${d.model} panner: width+center, no depth`);
    const trem = byKey(withLayout(d.model, 'TREMOLO', d.layouts.TREMOLO!.variants.find((v) => v.value === '3')!.pages), 'lfo');
    eq(trem?.mode, 'tremolo', `${d.model} TREMOLO type 3 mode`);
    if (trem?.roles.depth == null) fail(`${d.model} tremolo: depth expected`);
  }
}

// ── 7. CONTROLLERS → lfo1 / lfo2 / adsr1 / adsr2 ─────────────────────────
function controllers(): void {
  for (const d of DEVICES) {
    const vs = blockVisuals(d.model, 'CONTROLLERS');
    eq(vs.map((v) => `${v.key}:${v.kind}:${v.title}`).join('|'), 'lfo1:lfo:LFO 1|lfo2:lfo:LFO 2|adsr1:adsr:ADSR 1|adsr2:adsr:ADSR 2', `${d.model} CONTROLLERS visuals`);
    const [l1, l2, a1, a2] = vs;
    eq(l1!.roles.rate, idOf(d.catalog, 'CONTROLLERS', 'CONTROLLERS_LFO1FREQ'), `${d.model} lfo1 rate`);
    eq(l2!.roles.rate, idOf(d.catalog, 'CONTROLLERS', 'CONTROLLERS_LFO2FREQ'), `${d.model} lfo2 rate`);
    if (l1!.roles.rate === l2!.roles.rate) fail(`${d.model} lfo1/lfo2 must not share a rate param`);
    eq(rolesOf(l1), 'depth,duty,hicut,phase,quantize,rate,run,shape,skew,tempo', `${d.model} lfo1 roles`);
    eq(rolesOf(a1), 'attack,curve,decay,mode,release,sustainLevel,sustainTime,threshold', `${d.model} adsr1 roles`);
    eq(a2!.roles.attack, idOf(d.catalog, 'CONTROLLERS', 'CONTROLLERS_ADSR2ATTACK'), `${d.model} adsr2 attack`);
    // the shipped layout (every page of the single variant) keeps all four
    eq(withLayout(d.model, 'CONTROLLERS', d.layouts.CONTROLLERS!.variants[0]!.pages).length, 4, `${d.model} CONTROLLERS layout keeps all four`);
  }
}

// ── 8. DELAY: a shipped layout narrows the echo; without one it still resolves ────────────────
function delayWithoutLayout(): void {
  for (const d of DEVICES) {
    const layout = d.layouts.DELAY;
    const echo = byKey(blockVisuals(d.model, 'DELAY'), 'echo');
    eq(echo?.kind, 'echo', `${d.model} DELAY echo offered`);
    eq(echo?.title, 'Echo train', `${d.model} DELAY title`);
    eq(rolesOf(echo), 'feedback,feedbackR,masterFeedback,routing,spread,tempo,tempoR,time,timeR,timeRatio', `${d.model} DELAY roles`);
    // the source ships a Delay layout on FM3/FM9/III now (AM4 has none): its Time/FB variant keeps the
    // echo, narrowing the roles through the ids the page shows
    if (layout) {
      const timed = layout.variants.find((v) => v.pages.some((p) => p.name === 'Time/FB'));
      if (!timed) fail(`${d.model}: DELAY layout without a Time/FB variant`);
      if (byKey(withLayout(d.model, 'DELAY', timed.pages), 'echo')?.roles.time == null) fail(`${d.model} DELAY Time/FB variant: echo without time`);
    }
  }
}

// ── 9. other families resolve on every device ─────────────────────────────
function otherFamilies(): void {
  for (const d of DEVICES) {
    const cab = byKey(blockVisuals(d.model, 'CABINET'), 'cabAlign');
    eq(`${rolesOf(cab)}:${cab?.roles.delay1},${cab?.roles.delay2}`, 'delay1,delay2:16,17', `${d.model} cab align roles + ids`);
    eq(byKey(blockVisuals(d.model, 'WAH'), 'response')?.mode, 'wah', `${d.model} WAH response mode`);
    eq(byKey(blockVisuals(d.model, 'FILTER'), 'response')?.mode, 'filter', `${d.model} FILTER response mode`);
    for (const fam of ['CHORUS', 'FLANGER', 'PHASER']) eq(byKey(blockVisuals(d.model, fam), 'lfo')?.mode, 'mod', `${d.model} ${fam} lfo`);
    // a comb-filter type (no FREQ on its pages, but its cut knobs) gets no response; all-pass does
    const comb = d.layouts.FILTER!.variants.find((v) => v.value === '12,13');
    if (!comb) fail(`${d.model}: no FILTER comb variant '12,13'`);
    eq(byKey(withLayout(d.model, 'FILTER', comb.pages), 'response'), undefined, `${d.model} comb filter → no response`);
    eq(byKey(withLayout(d.model, 'FILTER', comb.pages), 'lfo'), undefined, `${d.model} comb filter → no LFO (its pages show no LFO control)`);
    // envelope / touch-wah types: neither; auto-wah: its LFO but no static response
    const env = d.layouts.FILTER!.variants.find((v) => v.value === '15,17');
    const auto = d.layouts.FILTER!.variants.find((v) => v.value === '16');
    if (!env || !auto) fail(`${d.model}: FILTER envelope '15,17' / auto-wah '16' variants expected`);
    eq(withLayout(d.model, 'FILTER', env.pages).length, 0, `${d.model} envelope filter → no visual`);
    eq(withLayout(d.model, 'FILTER', auto.pages).map((v) => v.key).join(','), 'lfo', `${d.model} auto-wah → LFO only`);
    const allPass = d.layouts.FILTER!.variants.find((v) => v.value === '14');
    if (!allPass) fail(`${d.model}: no FILTER all-pass variant '14'`);
    eq(byKey(withLayout(d.model, 'FILTER', allPass.pages), 'response')?.roles.freq, idOf(d.catalog, 'FILTER', 'FILTER_FREQ'), `${d.model} all-pass filter → response with freq`);
  }
}

// ── 10. graph-slot normalisation of the layout tokens ─────────────────────
function slotTokens(): void {
  const cases: Array<[string, string, string | undefined, GraphSlotKey | null, string[]?]> = [
    ['COMP', 'graph_comp_studio', 'Basic', 'dynamics'],
    ['COMP', 'graph_eq', 'Sidechain', 'sidechainEq'],
    ['REVERB', 'graph_eq', 'EQ', 'reverbEq'],
    ['REVERB', 'graph_reverb', 'EQ', 'reverbEq'],
    ['FLANGER', 'graph_lfo', 'Basic', 'lfo'],
    ['FLANGER', 'graph_lfo', 'Expert 1', 'lfo'],
    ['PHASER', 'graph_lfo', 'Basic', 'lfo'],
    ['PHASER', 'graph_phaser', 'LFO', 'lfo'],
    ['TREMOLO', 'graph_trem', 'Tremolo', 'lfo'],
    ['TREMOLO', 'graph_trem', 'Panner', 'lfo'],
    ['FILTER', 'graph_filter', 'Filter', 'response'],
    ['FILTER', 'graph_filter', 'LFO', 'lfo'],
    ['FILTER', 'graph_filter', 'Modulation', 'lfo'],
    ['DYNDIST', 'graph_filter', 'Config', 'response'],
    ['DISTORT', 'graph4', 'Input EQ', null],
    ['DISTORT', 'graph4', 'Speaker', null],
    ['PLEX', 'graph4', 'Filter', 'response'],
    ['MULTITAP', 'graph3', 'EQ', 'response'],
    ['PEQ', 'graph_peq', 'PEQ', 'eq'],
    ['GLOBAL', 'graph_peq', 'Out 1 EQ', 'eq'],
    ['MEGATAP', 'graph_megatap', 'Tap Control', null],
    ['MOD', 'graph_modifier', 'Modifier', null],
    ['RTA', 'graph_rta', 'RTA', null],
    ['TONEMATCH', 'graph_eqMatch', 'Capture', null],
    ['CABINET', 'graph_cab', 'Align', 'cabAlign'],
    ['CABINET', 'graph_cabZoom', 'Align', 'cabAlign'],
    ['CABINET', 'graph_cab_mm', 'Align', 'cabAlign'],
    ['CABINET', 'graph_cabZoom_mm', 'Align', 'cabAlign'],
    ['CONTROLLERS', 'graph_lfo', 'LFO 1 + 2', 'lfo1', ['CONTROLLERS_LFO1TYPE', 'CONTROLLERS_LFO1RUN', null as unknown as string]],
    ['CONTROLLERS', 'graph_lfo', 'LFO 1 + 2', 'lfo2', ['CONTROLLERS_LFO2TYPE', 'CONTROLLERS_LFO2RUN']],
    ['CONTROLLERS', 'graph_lfo', 'LFO 1 + 2', null, []], // both instances on the page, no row hint → ambiguous
    ['CONTROLLERS', 'graph_adsr', 'ADSR 1', 'adsr1', ['CONTROLLERS_ADSR1SOURCE']],
    ['CONTROLLERS', 'graph_adsr_marker', 'ADSR 2', 'adsr2', []], // page name alone is unambiguous
    ['COMP', 'knobCompact', 'Basic', null],
    ['COMP', '', 'Basic', null],
  ];
  for (const [family, token, page, want, row] of cases) {
    eq(graphSlotKey(family, token, { page, rowParamNames: row }), want, `${family} ${token} on '${page}'`);
  }
}

// ── 11. stamping over every shipped layout ────────────────────────────────
function stampAllLayouts(): void {
  const validKeys = new Set<string>([...VISUAL_KEYS, 'eq']);
  for (const d of DEVICES) {
    let stamped = 0;
    for (const [family, block] of Object.entries(d.layouts)) {
      for (const v of block.variants) {
        const before = JSON.stringify(v.pages);
        const out = stampGraphKeys(family, v.pages);
        eq(JSON.stringify(v.pages), before, `${d.model} ${family}/${v.name}: source layout not mutated`);
        eq(out.length, v.pages.length, `${d.model} ${family}/${v.name}: page count`);
        out.forEach((page, i) => {
          const src = v.pages[i]!;
          let graphs = 0;
          const controls = [...page.rows.flatMap((r) => r.controls), ...(page.pageControls ?? [])];
          for (const c of controls) {
            if (c.widget === 'graph') graphs++;
            if (c.graphKey == null) continue;
            if (c.widget !== 'graph') fail(`${d.model} ${family}: a non-graph control got a graphKey`);
            if (!validKeys.has(c.graphKey)) fail(`${d.model} ${family}: bad key ${c.graphKey}`);
            const defs = (BLOCK_VISUAL_DEFS[family] ?? []).some((x) => x.key === c.graphKey);
            const ampEq = family === 'DISTORT' && (c.graphKey === 'inputEq' || c.graphKey === 'outputEq');
            const pageVisual = c.graphKey === graphSlotKey(family, c.rawWidget, { page: page.name });
            if (c.graphKey !== 'eq' && !defs && !ampEq && !pageVisual) {
              fail(`${d.model} ${family}: key ${c.graphKey} has no definition in the family`);
            }
            stamped++;
          }
          if (graphs === 0 && page !== src) fail(`${d.model} ${family}/${page.name}: a page without graphs must keep its identity`);
        });
      }
    }
    if (stamped === 0) fail(`${d.model}: nothing stamped`);
    // CONTROLLERS: the current LFO page stamps lfo1 + lfo2, the ADSR pages adsr1 / adsr2
    const ctl = stampGraphKeys('CONTROLLERS', d.layouts.CONTROLLERS!.variants[0]!.pages);
    const keysOn = (re: RegExp) => [...new Set(ctl.filter((p) => re.test(p.name)).flatMap((p) => p.rows.flatMap((r) => r.controls.map((c) => c.graphKey).filter(Boolean))))].sort().join(',');
    eq(keysOn(/^LFO/), 'lfo1,lfo2', `${d.model} CONTROLLERS LFO page keys`);
    eq(keysOn(/^ADSR 1$/), 'adsr1', `${d.model} CONTROLLERS ADSR 1 page keys`);
    eq(keysOn(/^ADSR 2$/), 'adsr2', `${d.model} CONTROLLERS ADSR 2 page keys`);
    // COMP Studio FF: dynamics on Basic and its filter response on Sidechain.
    const comp = stampGraphKeys('COMP', variantPages(d.layouts, 'COMP', 'Studio FF'));
    const compKeys = comp.flatMap((p) => p.rows.flatMap((r) => r.controls.filter((c) => c.widget === 'graph').map((c) => `${p.name}:${c.graphKey ?? '-'}`)));
    eq(compKeys.join(','), 'Basic:dynamics,Sidechain:sidechainEq', `${d.model} COMP Studio FF slots`);
    const compVisuals = resolveBlockVisuals(d.catalog.COMP, 'COMP', null, { layoutParamIds: layoutParamIds(comp), pages: comp });
    eq(byKey(compVisuals, 'sidechainEq')?.roles.filterType, idOf(d.catalog, 'COMP', 'COMP_EQTYPE'),
      `${d.model} Sidechain EQ binds its own filter selector`);
    const triChorus = d.layouts.CHORUS?.variants.find((v) => v.value === '15');
    if (!triChorus) fail(`${d.model}: missing Stereo Tri-Chorus layout`);
    const chorus = stampGraphKeys('CHORUS', triChorus.pages);
    const anchored = chorus.filter((p) => p.pageControls?.some((c) => c.graphKey === 'lfo'));
    eq(anchored.length, 1, `${d.model} Chorus LFO has one fallback slot`);
    eq(anchored[0]!.rows.some((r) => r.controls.some((c) => c.paramName === 'CHORUS_RATE')), true,
      `${d.model} Chorus LFO next to its rate control`);
  }
}

// ── 12. layoutParamIds skips cross-block refs and decorative controls ─────
function presentIds(): void {
  const pages: EditorLayoutPage[] = [
    {
      name: 'P',
      rows: [
        {
          section: 'parameters',
          controls: [
            { label: 'Rate', paramName: 'X_RATE', paramId: 3, widget: 'knob', rawWidget: 'knob' },
            { label: '', paramName: null, paramId: null, widget: 'graph', rawWidget: 'graph_lfo' },
            {
              label: 'Metronome', paramName: 'GLOBAL_METRONOME', paramId: 77, widget: 'knob', rawWidget: 'knob',
              crossBlock: { effect: 'ID_GLOBAL', family: 'GLOBAL', paramName: 'GLOBAL_METRONOME', paramId: 77 },
            },
          ],
        },
      ],
      pageControls: [{ label: 'Depth', paramName: 'X_DEPTH', paramId: 5, widget: 'knob', rawWidget: 'knob' }],
    },
  ];
  eq([...layoutParamIds(pages)].join(','), '3,5', 'own row and page-level param ids');
}

// ── 13. device gating ─────────────────────────────────────────────────────
function deviceGating(): void {
  eq(gen3VisualModel(0x11), 'fm3', 'model byte 0x11');
  eq(gen3VisualModel(0x10), 'axe3', 'model byte 0x10');
  eq(gen3VisualModel(0x12), 'fm9', 'model byte 0x12');
  eq(gen3VisualModel(0x14), null, 'VP4 byte has no visuals');
  eq(gen3VisualModel(0x15), null, 'AM4 byte has no visuals');
  eq(gen3VisualModel('vp4'), null, 'VP4 key');
  eq(gen3VisualModel('toString'), null, 'prototype keys are not models');
  eq(hasBlockVisuals('fm9'), true, 'hasBlockVisuals fm9');
  eq(blockVisuals('vp4', 'COMP').length, 0, 'VP4 → none');
  eq(blockVisuals(0x15, 'COMP').length, 0, 'AM4 → none');
}

// ── 14. AMP Input / Output EQ (served bands, never fixed ids) ──────────
function ampEq(): void {
  for (const d of DEVICES) {
    const block = d.layouts.DISTORT;
    if (!block) fail(`${d.model}: no DISTORT layout`);
    let input: BlockVisual | undefined;
    let output: BlockVisual | undefined;
    for (const v of block.variants) {
      const pages = stampGraphKeys('DISTORT', v.pages);
      const served = resolveBlockVisuals(d.catalog.DISTORT, 'DISTORT', null, { pages });
      if (!input) {
        input = byKey(served, 'inputEq');
        if (input) {
          const page = pages.find((p) => /^input\s*eq$/i.test(p.name));
          if (!page) fail(`${d.model}: no Input EQ page`);
          const keys = [...page.rows.flatMap((r) => r.controls), ...(page.pageControls ?? [])]
            .map((c) => c.graphKey).filter(Boolean);
          eq(keys.join(','), 'inputEq', `${d.model}: Input EQ page slot`);
        }
      }
      if (!output) {
        output = byKey(served, 'outputEq');
        if (output) {
          for (const p of pages) {
            const on = [...p.rows.flatMap((r) => r.controls), ...(p.pageControls ?? [])].some((c) => c.graphKey === 'outputEq');
            if (on && !/^\s*output\s*eq\s*$/i.test(p.name)) fail(`${d.model} ${v.name}/${p.name}: outputEq slot on a page that is not the Output EQ`);
          }
        }
      }
    }
    if (!input) fail(`${d.model}: no Amp Input EQ visual`);
    if (!output) fail(`${d.model}: no Amp Output EQ visual`);
    eq(input.kind, 'eq', `${d.model} inputEq kind`);
    eq(input.mode, 'parametric', `${d.model} inputEq mode`);
    const ib = input.bands ?? [];
    eq(ib.map((b) => b.key).join(','), 'peak,lowCut,highCut', `${d.model} inputEq bands`);
    eq(ib[0]!.freq, idOf(d.catalog, 'DISTORT', 'DISTORT_INEQFREQ'), `${d.model} inputEq peak freq`);
    eq(ib[0]!.gain, idOf(d.catalog, 'DISTORT', 'DISTORT_INEQGAIN'), `${d.model} inputEq peak gain`);
    eq(ib[0]!.q, idOf(d.catalog, 'DISTORT', 'DISTORT_INEQQ'), `${d.model} inputEq peak q`);
    eq(ib[0]!.type, idOf(d.catalog, 'DISTORT', 'DISTORT_INEQTYPE'), `${d.model} inputEq peak type`);
    eq(ib[1]!.shape, 'lowcut', `${d.model} inputEq low cut`);
    eq(ib[1]!.freq, idOf(d.catalog, 'DISTORT', 'DISTORT_HPFREQ'), `${d.model} inputEq low-cut freq`);
    eq(ib[2]!.shape, 'highcut', `${d.model} inputEq high cut`);
    eq(ib[2]!.freq, idOf(d.catalog, 'DISTORT', 'DISTORT_HICUT'), `${d.model} inputEq high-cut freq`);

    eq(output.kind, 'eq', `${d.model} outputEq kind`);
    eq(output.mode, 'graphic', `${d.model} outputEq mode`);
    const ob = output.bands ?? [];
    eq(ob.length, 8, `${d.model}: the Output EQ draws its 8-band page`);
    eq(ob.map((b) => b.centerHz).join(','), '62,125,250,500,1000,2000,4000,8000', `${d.model} outputEq centers`);
    for (const b of ob) {
      if (b.shape !== 'bell') fail(`${d.model}: outputEq band ${b.key} is not a bell`);
      if (idOf(d.catalog, 'DISTORT', b.key) !== b.gain) fail(`${d.model}: outputEq band ${b.key} uses another id`);
    }
    const namedPage = block.variants.flatMap((v) => v.pages).find((p) =>
      /^output\s*eq$/i.test(p.name) && p.rows.some((r) => r.controls.some((c) => c.label === 'Low Mid' && /^DISTORT_EQ\d+$/.test(c.paramName ?? '')))
    );
    if (namedPage) {
      const pages = stampGraphKeys('DISTORT', [namedPage]);
      const named = byKey(resolveBlockVisuals(d.catalog.DISTORT, 'DISTORT', null, { pages }), 'outputEq');
      eq(named?.bands?.find((b) => b.label === 'Low Mid')?.centerHz, undefined, `${d.model} no fabricated frequency`);
      eq(named?.bands?.some((b) => b.label === 'Low Mid' && b.gain != null), true, `${d.model} named gain fader`);
      eq(pages[0]!.pageControls?.some((c) => c.graphKey === 'outputEq'), true, `${d.model} named Output EQ slot`);
    }
  }
}

export function runVisualsTests(): void {
  symbolsResolveEverywhere();
  idsAreDeviceOwn();
  requiredRoles();
  compVariants();
  layoutNarrowing();
  gateVariants();
  tremoloModes();
  controllers();
  delayWithoutLayout();
  otherFamilies();
  slotTokens();
  stampAllLayouts();
  presentIds();
  deviceGating();
  ampEq();
}
