/**
 * Block visuals — which read-only display ("graph") a gen-3 block can show, and which of the
 * block's own parameters feed it.
 *
 * A visual is a small descriptor `{ key, kind, title, mode?, roles }`. `roles` maps a ROLE (a
 * named input of the display math, e.g. `threshold`, `rate`) to the wire `paramId` of the device's
 * own catalog parameter that plays it. A client draws the visual from the values it already holds
 * for those paramIds; it never needs a catalog symbol. Everything here is pure data + pure
 * functions (no catalog import, browser-safe); `blockVisuals()` in `devices/gen3` binds it to each
 * device's catalog.
 *
 * Design rules:
 *   - Role tables are keyed by catalog SYMBOL (e.g. `COMP_THRESH`) and resolved by NAME against the
 *     device's own catalog, because paramIds differ per device (FM3 / FM9 / Axe-Fx III). Never
 *     hard-code a paramId here.
 *   - A visual is offered only when one of its `requires` groups resolves completely; optional roles
 *     are simply left out when missing. A caller may pass the paramIds present for the block
 *     (e.g. the ids it serves); roles whose param is not present are dropped before that check
 *     (monitor roles excepted: a read-only monitor is a block property, not a variant control).
 *   - A caller may also pass the paramIds the block's CURRENT layout variant shows; roles are then
 *     strictly narrowed to them (monitors excepted): a sustain-only compressor type shows SUSTAIN but
 *     no THRESH → gain reduction only; a comb-filter type shows neither FREQ nor LFO controls →
 *     neither visual. (A server that knows a variant merely adds pages to a default variant passes
 *     the union of both.)
 *   - The tables only say WHICH parameter feeds WHICH input. The display math (curve laws, LFO
 *     shapes, filter prototypes, ...) is the client's own and uses standard public formulas; nothing
 *     in this module encodes a measured or fitted curve.
 *
 * Role semantics per kind (values are the parameter's own display values):
 *   dynamics/compressor  threshold (dB), ratio, knee (enum label), level (dB), mix (%),
 *                        autoMakeup (enum OFF/ON), threshold2 (dB, variants without a ratio),
 *                        sustain (variants without threshold/ratio), gainReduction (read-only
 *                        monitor). A transfer curve is only meaningful when BOTH `threshold` and
 *                        `ratio` resolve (see DYNAMICS_CURVE_ROLES); otherwise the visual is a
 *                        gain-reduction display (title 'Gain reduction').
 *   dynamics/gate        threshold (dB), ratio, range (dB attenuation floor), knee, level, mix,
 *                        gainReduction (monitor). Some gate types have a range but no ratio.
 *   lfo                  rate (Hz), tempo (tempo-division enum, 'NONE' = free rate), shape (LFO
 *                        type enum), depth, duty (%), skew (beta/shape %), phase (deg, stereo
 *                        offset), hicut (Hz), quantize (enum, 'OFF' or 2..32), run (enum, a
 *                        STOP/OFF label means not running); tremolo mode adds nothing, panner mode
 *                        uses width (%) and center (%) instead of depth.
 *   response/filter      freq (Hz), q, gain (dB), order (enum), lowCut / highCut (Hz); the filter
 *                        TYPE comes from the block's type label, not from a role.
 *   response/wah         freqStart / freqStop (Hz), q, control (0..10), taper (enum).
 *   decay                time (s), predelay (ms), earlyLevel (dB).
 *   echo                 time (ms), tempo (division enum), feedback (%), masterFeedback (%),
 *                        routing (MONO/STEREO/PING-PONG/... enum), timeRatio (%), timeR (ms),
 *                        tempoR (division enum), feedbackR (%), spread.
 *   adsr                 attack / decay / sustainTime / release (ms), sustainLevel (%),
 *                        threshold (dB), curve (EXPONENTIAL/LINEAR enum), mode (ONCE/LOOP/SUST).
 *   cabAlign             delay1, delay2 (the two aligned slots' delay, in the param's own display
 *                        unit; the client chooses the axis span itself).
 */
import type { EditorLayoutPage } from './editorLayouts.js';

/** Visual families the client knows how to draw. */
export type VisualKind = 'dynamics' | 'lfo' | 'response' | 'decay' | 'echo' | 'adsr' | 'cabAlign' | 'eq';

/** Stable visual keys (unique per block). The client prefixes them, e.g. `graph:dynamics`. */
export type VisualKey =
  | 'dynamics'
  | 'lfo'
  | 'lfo1'
  | 'lfo2'
  | 'response'
  | 'decay'
  | 'echo'
  | 'adsr1'
  | 'adsr2'
  | 'cabAlign'
  | 'inputEq'
  | 'outputEq'
  | 'reverbEq'
  | 'sidechainEq'
  /** A block's own EQ (PEQ / GEQ): the graph slot graph_peq / the family's page carries it. */
  | 'eq';

/**
 * Normalised key of a layout graph slot: a {@link VisualKey}, or `'eq'` for the parametric-EQ
 * slots a client renders with its own EQ display (no served visual backs it).
 */
export type GraphSlotKey = VisualKey | 'eq';

/** Sub-variant of a kind that changes the display law. */
export type VisualMode = 'compressor' | 'gate' | 'mod' | 'tremolo' | 'panner' | 'filter' | 'wah' | 'parametric' | 'graphic';

/** Every role name a visual may carry (see the module header for per-kind semantics). */
export type VisualRole =
  // dynamics
  | 'threshold'
  | 'ratio'
  | 'knee'
  | 'level'
  | 'mix'
  | 'autoMakeup'
  | 'threshold2'
  | 'sustain'
  | 'range'
  | 'gainReduction'
  // lfo
  | 'rate'
  | 'tempo'
  | 'shape'
  | 'depth'
  | 'duty'
  | 'skew'
  | 'phase'
  | 'hicut'
  | 'quantize'
  | 'run'
  | 'width'
  | 'center'
  // response
  | 'freq'
  | 'filterType'
  | 'q'
  | 'gain'
  | 'order'
  | 'lowCut'
  | 'highCut'
  | 'freqStart'
  | 'freqStop'
  | 'control'
  | 'taper'
  // decay / echo
  | 'time'
  | 'predelay'
  | 'earlyLevel'
  | 'feedback'
  | 'masterFeedback'
  | 'routing'
  | 'timeRatio'
  | 'timeR'
  | 'tempoR'
  | 'feedbackR'
  | 'spread'
  // adsr
  | 'attack'
  | 'decay'
  | 'sustainTime'
  | 'release'
  | 'sustainLevel'
  | 'curve'
  | 'mode'
  // cabAlign
  | 'delay1'
  | 'delay2';

/** A resolved visual for one block on one device (the wire shape a server serves). */
export interface VisualEqBand {
  key: string;
  /** The selected layout's band caption, including non-frequency positions such as "Low Mid". */
  label?: string;
  gain?: number;
  freq?: number;
  q?: number;
  type?: number;
  centerHz?: number;
  shape?: 'bell' | 'lowshelf' | 'highshelf' | 'lowcut' | 'highcut';
}

export interface BlockVisual {
  key: VisualKey;
  kind: VisualKind;
  /** Short human title, e.g. 'Compressor curve', 'LFO 1'. */
  title: string;
  /** Sub-variant of the kind, where the display law depends on it. */
  mode?: VisualMode;
  /** role → wire paramId in THIS device's id space. Only resolved (and present) roles appear. */
  roles: Partial<Record<VisualRole, number>>;
  bands?: VisualEqBand[];
}

/** Title/mode override applied when its condition holds (first matching rule wins). */
export interface VisualRefinement {
  /** Every one of these roles must have resolved. */
  has?: readonly VisualRole[];
  /** At least one of these roles must be missing. */
  lacksAny?: readonly VisualRole[];
  title?: string;
  mode?: VisualMode;
}

/** One visual a block family can offer: the role table, keyed by catalog symbol. */
export interface VisualDef {
  key: VisualKey;
  kind: VisualKind;
  title: string;
  mode?: VisualMode;
  /** role → catalog parameter symbol (resolved by name against the device's catalog). */
  roles: Readonly<Partial<Record<VisualRole, string>>>;
  /** Read-only monitor roles (resolved by name like `roles`, never filtered by variant presence). */
  monitorRoles?: Readonly<Partial<Record<VisualRole, string>>>;
  /** Any-of groups: the visual is offered iff at least one group resolves completely. */
  requires: readonly (readonly VisualRole[])[];
  /** Title/mode refinements by which roles resolved. */
  refine?: readonly VisualRefinement[];
}

/** The two roles a compressor/gate transfer curve needs; without both only gain reduction is shown. */
export const DYNAMICS_CURVE_ROLES: readonly VisualRole[] = ['threshold', 'ratio'];

export const VISUAL_KINDS: readonly VisualKind[] = ['dynamics', 'lfo', 'response', 'decay', 'echo', 'adsr', 'cabAlign', 'eq'];
export const VISUAL_KEYS: readonly VisualKey[] = [
  'dynamics', 'lfo', 'lfo1', 'lfo2', 'response', 'decay', 'echo', 'adsr1', 'adsr2', 'cabAlign', 'inputEq', 'outputEq', 'reverbEq', 'sidechainEq',
];

/** A CONTROLLERS LFO (n = 1 | 2). */
function controllersLfo(n: 1 | 2): VisualDef {
  const p = `CONTROLLERS_LFO${n}`;
  return {
    key: n === 1 ? 'lfo1' : 'lfo2',
    kind: 'lfo',
    mode: 'mod',
    title: `LFO ${n}`,
    roles: {
      rate: `${p}FREQ`,
      tempo: `${p}TEMPO`,
      shape: `${p}TYPE`,
      depth: `${p}DEPTH`,
      duty: `${p}DUTY`,
      skew: `${p}BETA`,
      phase: `${p}PHASE`,
      hicut: `${p}HICUT`,
      quantize: `${p}QUANTIZE`,
      run: `${p}RUN`,
    },
    requires: [['rate']],
  };
}

/** A CONTROLLERS ADSR envelope (n = 1 | 2). */
function controllersAdsr(n: 1 | 2): VisualDef {
  const p = `CONTROLLERS_ADSR${n}`;
  return {
    key: n === 1 ? 'adsr1' : 'adsr2',
    kind: 'adsr',
    title: `ADSR ${n}`,
    roles: {
      attack: `${p}ATTACK`,
      decay: `${p}DECAY`,
      sustainTime: `${p}SUSTAIN`,
      release: `${p}RELEASE`,
      sustainLevel: `${p}LEVEL`,
      threshold: `${p}THRESH`,
      curve: `${p}_TYPE`,
      mode: `${p}MODE`,
    },
    requires: [['attack', 'decay', 'sustainTime', 'release']],
  };
}

/** A simple modulation-block LFO (chorus / flanger / phaser). */
function blockLfo(title: string, roles: VisualDef['roles']): VisualDef {
  return { key: 'lfo', kind: 'lfo', mode: 'mod', title, roles, requires: [['rate']] };
}

/**
 * Role tables per catalog family. Shared by FM3 / FM9 / Axe-Fx III (the symbols are common; the
 * paramIds are not — resolve with {@link resolveBlockVisuals}).
 */
export const BLOCK_VISUAL_DEFS: Readonly<Record<string, readonly VisualDef[]>> = {
  COMP: [
    {
      key: 'dynamics',
      kind: 'dynamics',
      mode: 'compressor',
      title: 'Compressor curve',
      roles: {
        threshold: 'COMP_THRESH',
        ratio: 'COMP_RATIO',
        knee: 'COMP_KNEE',
        level: 'COMP_LEVEL',
        mix: 'COMP_MIX',
        autoMakeup: 'COMP_AUTO',
        threshold2: 'COMP_THRESH2',
        sustain: 'COMP_SUSTAIN',
      },
      monitorRoles: { gainReduction: 'COMP_GAINMONITOR' },
      // a full curve, or a gain-reduction display for the threshold2-only / sustain-only types
      requires: [['threshold', 'ratio'], ['threshold2'], ['sustain']],
      refine: [{ lacksAny: DYNAMICS_CURVE_ROLES, title: 'Gain reduction' }],
    },
  ],
  GATE: [
    {
      key: 'dynamics',
      kind: 'dynamics',
      mode: 'gate',
      title: 'Gate curve',
      roles: {
        threshold: 'GATE_THRESH',
        ratio: 'GATE_RATIO',
        range: 'GATE_RANGE',
        knee: 'GATE_KNEE',
        level: 'GATE_LEVEL',
        mix: 'GATE_MIX',
      },
      monitorRoles: { gainReduction: 'GATE_GAINMONITOR' },
      requires: [['threshold', 'ratio'], ['threshold', 'range']],
    },
  ],
  CHORUS: [
    blockLfo('Chorus LFO', {
      rate: 'CHORUS_RATE',
      tempo: 'CHORUS_TEMPO',
      shape: 'CHORUS_LFOTYPE',
      depth: 'CHORUS_DEPTH',
      phase: 'CHORUS_LFOPHASE',
    }),
  ],
  FLANGER: [
    blockLfo('Flanger LFO', {
      rate: 'FLANGER_RATE',
      tempo: 'FLANGER_TEMPO',
      shape: 'FLANGER_LFOTYPE',
      depth: 'FLANGER_DEPTH',
      phase: 'FLANGER_LFOPHASE',
      hicut: 'FLANGER_LFOFILTER',
      quantize: 'FLANGER_LFOQUANTIZE',
    }),
  ],
  PHASER: [
    blockLfo('Phaser LFO', {
      rate: 'PHASER_RATE',
      tempo: 'PHASER_TEMPO',
      shape: 'PHASER_LFOTYPE',
      skew: 'PHASER_LFOBETA',
      depth: 'PHASER_DEPTH',
      phase: 'PHASER_LFOPHASE',
      hicut: 'PHASER_LFOLPF',
      quantize: 'PHASER_LFOQUANTIZE',
    }),
  ],
  TREMOLO: [
    {
      key: 'lfo',
      kind: 'lfo',
      mode: 'tremolo',
      title: 'Tremolo LFO',
      roles: {
        rate: 'TREMOLO_RATE',
        tempo: 'TREMOLO_TEMPO',
        shape: 'TREMOLO_LFOTYPE',
        duty: 'TREMOLO_DUTY',
        skew: 'TREMOLO_BETA',
        depth: 'TREMOLO_DEPTH',
        phase: 'TREMOLO_PHASE',
        width: 'TREMOLO_WIDTH',
        center: 'TREMOLO_CENTER',
      },
      requires: [['rate']],
      // the panner type shows width/center instead of depth
      refine: [{ has: ['width'], lacksAny: ['depth'], mode: 'panner', title: 'Panner LFO' }],
    },
  ],
  FILTER: [
    {
      key: 'response',
      kind: 'response',
      mode: 'filter',
      title: 'Filter response',
      roles: {
        freq: 'FILTER_FREQ',
        q: 'FILTER_Q',
        gain: 'FILTER_GAIN',
        order: 'FILTER_ORDER',
        lowCut: 'FILTER_LOWCUT',
        highCut: 'FILTER_HICUT',
      },
      requires: [['freq']],
    },
    {
      key: 'lfo',
      kind: 'lfo',
      mode: 'mod',
      title: 'Filter LFO',
      roles: {
        rate: 'FILTER_LFOFREQ',
        tempo: 'FILTER_TEMPO',
        shape: 'FILTER_LFOTYPE',
        duty: 'FILTER_LFODUTY',
        quantize: 'FILTER_QUANTIZE',
        run: 'FILTER_LFOENABLE',
      },
      requires: [['rate']],
    },
  ],
  WAH: [
    {
      key: 'response',
      kind: 'response',
      mode: 'wah',
      title: 'Wah response',
      roles: {
        freqStart: 'WAH_FSTART',
        freqStop: 'WAH_FSTOP',
        q: 'WAH_Q',
        control: 'WAH_CONTROL',
        taper: 'WAH_TAPER',
      },
      requires: [['freqStart', 'freqStop']],
    },
  ],
  REVERB: [
    {
      key: 'decay',
      kind: 'decay',
      title: 'Reverb decay',
      roles: { time: 'REVERB_TIME', predelay: 'REVERB_PREDELAY', earlyLevel: 'REVERB_EARLYLEVEL' },
      requires: [['time']],
    },
  ],
  DELAY: [
    {
      key: 'echo',
      kind: 'echo',
      title: 'Echo train',
      roles: {
        time: 'DELAY_TIME',
        tempo: 'DELAY_TEMPO',
        feedback: 'DELAY_FEED',
        masterFeedback: 'DELAY_MSTRFDBK',
        routing: 'DELAY_TYPE',
        timeRatio: 'DELAY_RATIO',
        timeR: 'DELAY_TIMER',
        tempoR: 'DELAY_TEMPOR',
        feedbackR: 'DELAY_FEEDR',
        spread: 'DELAY_SPREAD',
      },
      requires: [['time']],
    },
  ],
  CONTROLLERS: [controllersLfo(1), controllersLfo(2), controllersAdsr(1), controllersAdsr(2)],
  CABINET: [
    {
      key: 'cabAlign',
      kind: 'cabAlign',
      title: 'Cab alignment',
      // CABINET_ZOOM is deliberately not a role: no gen-3 device serves it as a knob or selector (a
      // float row under the 'enum' unit), so the client fits the axis to the two delays itself.
      roles: { delay1: 'CABINET_DELAY1', delay2: 'CABINET_DELAY2' },
      requires: [['delay1', 'delay2']],
    },
  ],
};

/** These slots describe a static filter selected by a parameter, separate from the block's own type. */
const PAGE_FILTERS: Readonly<Record<string, { token: string; visual: VisualDef }>> = {
  COMP: {
    token: 'graph_eq',
    visual: {
      key: 'sidechainEq', kind: 'response', mode: 'filter', title: 'Sidechain EQ',
      roles: { filterType: 'COMP_EQTYPE', freq: 'COMP_FREQ', q: 'COMP_Q', gain: 'COMP_GAIN', lowCut: 'COMP_LOWCUT', highCut: 'COMP_HIGHCUT' },
      requires: [['filterType', 'freq']]
    }
  },
  MULTITAP: {
    token: 'graph3',
    visual: {
      key: 'response', kind: 'response', mode: 'filter', title: 'Multitap EQ',
      roles: { filterType: 'MULTITAP_FILTER_TYPE', freq: 'MULTITAP_FREQ', q: 'MULTITAP_Q', gain: 'MULTITAP_GAIN', lowCut: 'MULTITAP_LOWCUT', highCut: 'MULTITAP_HIGHCUT' },
      requires: [['filterType', 'freq']]
    }
  },
  PLEX: {
    token: 'graph4',
    visual: {
      key: 'response', kind: 'response', mode: 'filter', title: 'Plex filter',
      roles: { filterType: 'PLEX_FILTERTYPE', freq: 'PLEX_FILTERFREQ', q: 'PLEX_FILTERQ', gain: 'PLEX_FILTERGAIN' },
      requires: [['filterType', 'freq']]
    }
  },
  DYNDIST: {
    token: 'graph_filter',
    visual: {
      key: 'response', kind: 'response', mode: 'filter', title: 'Filter response',
      roles: { filterType: 'DYNDIST_BQTYPE', freq: 'DYNDIST_FREQ', q: 'DYNDIST_Q', gain: 'DYNDIST_GAIN' },
      requires: [['filterType', 'freq']]
    }
  }
};

function controlsOn(page: EditorLayoutPage): readonly EditorLayoutPage['rows'][number]['controls'][number][] {
  return [...page.rows.flatMap((r) => r.controls), ...(page.pageControls ?? [])];
}

/** The minimal catalog row shape the resolver needs. */
export interface VisualCatalogParam {
  readonly paramId: number;
  readonly name: string;
}

function toSet(ids: Iterable<number> | null | undefined): ReadonlySet<number> | null {
  if (ids == null) return null;
  return ids instanceof Set ? (ids as ReadonlySet<number>) : new Set(ids);
}

function refinementApplies(r: VisualRefinement, has: (role: VisualRole) => boolean): boolean {
  if (r.has && !r.has.every(has)) return false;
  if (r.lacksAny && r.lacksAny.length > 0 && r.lacksAny.every(has)) return false;
  return true;
}

/** Optional inputs of {@link resolveBlockVisuals} beyond the present set. */
export interface ResolveVisualsOptions {
  /**
   * The paramIds the block's CURRENT layout variant shows (see {@link layoutParamIds}). Every
   * (non-monitor) role must be among them, in addition to the present set: a role the variant does
   * not show is dropped, and a visual whose required roles it does not show is not offered.
   * Omitted/null = no layout (e.g. DELAY): no narrowing. A caller that knows a variant only adds pages
   * to a default one passes the union of both.
   */
  layoutParamIds?: Iterable<number> | null;
  /** Selected pages provide fixed EQ frequencies and variant-specific bands. */
  pages?: readonly EditorLayoutPage[];
}

/**
 * Resolve a family's visuals against ONE device's catalog rows for that family.
 *
 * @param params           the device's catalog rows for `family` (first row per name wins)
 * @param family           catalog family symbol, e.g. `'COMP'`
 * @param presentParamIds  optional: the paramIds present for the block (e.g. the ids a server
 *                         serves for it). Omitted/null = every catalog param counts as present.
 * @param opts             optional: the layout variant's paramIds, for per-visual narrowing.
 */
export function resolveBlockVisuals(
  params: readonly VisualCatalogParam[] | undefined,
  family: string,
  presentParamIds?: Iterable<number> | null,
  opts: ResolveVisualsOptions = {},
): BlockVisual[] {
  const pageFilter = PAGE_FILTERS[family];
  const defs = [...(BLOCK_VISUAL_DEFS[family] ?? [])];
  if (pageFilter && opts.pages?.some((p) => controlsOn(p).some((c) => c.graphKey === pageFilter.visual.key))) defs.push(pageFilter.visual);
  if (!params || params.length === 0) return [];
  const byName = new Map<string, number>();
  for (const p of params) if (!byName.has(p.name)) byName.set(p.name, p.paramId);
  const present = toSet(presentParamIds);
  const inLayout = toSet(opts.layoutParamIds);
  const out: BlockVisual[] = [];
  for (const def of defs) {
    const resolved: [VisualRole, number][] = [];
    for (const [role, symbol] of Object.entries(def.roles) as [VisualRole, string][]) {
      const id = byName.get(symbol);
      if (id != null) resolved.push([role, id]);
    }
    const roles: Partial<Record<VisualRole, number>> = {};
    for (const [role, id] of resolved) {
      if (present && !present.has(id)) continue;
      if (inLayout && !inLayout.has(id)) continue;
      roles[role] = id;
    }
    for (const [role, symbol] of Object.entries(def.monitorRoles ?? {}) as [VisualRole, string][]) {
      const id = byName.get(symbol);
      if (id != null) roles[role] = id;
    }
    const has = (role: VisualRole) => roles[role] != null;
    if (!def.requires.some((group) => group.every(has))) continue;
    let title = def.title;
    let mode = def.mode;
    const rule = def.refine?.find((r) => refinementApplies(r, has));
    if (rule) {
      title = rule.title ?? title;
      mode = rule.mode ?? mode;
    }
    out.push({ key: def.key, kind: def.kind, title, ...(mode ? { mode } : {}), roles });
  }
  if (family === 'DISTORT') out.push(...ampEqVisuals(byName, present, inLayout, opts.pages));
  if (family === 'REVERB' && opts.pages?.some((p) => controlsOn(p).some((c) => c.graphKey === 'reverbEq'))) {
    const id = (symbol: string) => {
      const resolved = byName.get(symbol);
      return resolved != null && (!present || present.has(resolved)) && (!inLayout || inLayout.has(resolved)) ? resolved : undefined;
    };
    const bands: VisualEqBand[] = [];
    for (const n of [1, 2]) {
      const freq = id(`REVERB_FREQ${n}`);
      const gain = id(`REVERB_GAIN${n}`);
      if (freq != null && gain != null) bands.push({ key: `peak${n}`, shape: 'bell', freq, gain, q: id(`REVERB_Q${n}`) });
    }
    const low = id('REVERB_LOWCUT');
    const high = id('REVERB_HICUT');
    if (low != null) bands.push({ key: 'lowCut', shape: 'lowcut', freq: low, q: id('REVERB_LOWQ') });
    if (high != null) bands.push({ key: 'highCut', shape: 'highcut', freq: high, q: id('REVERB_HIGHQ') });
    if (bands.length) out.push({ key: 'reverbEq', kind: 'eq', title: 'Reverb EQ', mode: 'parametric', roles: {}, bands });
  }
  // PEQ: five bell bands, their own freq / Q / gain / type params (a real parametric curve, so the band
  // knobs need not be read as faders)
  if (family === 'PEQ') {
    const id = (symbol: string) => {
      const resolved = byName.get(symbol);
      return resolved != null && (!present || present.has(resolved)) && (!inLayout || inLayout.has(resolved)) ? resolved : undefined;
    };
    const bands: VisualEqBand[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const freq = id(`PEQ_FREQ${n}`);
      const gain = id(`PEQ_GAIN${n}`);
      if (freq != null && gain != null) {
        bands.push({ key: `band${n}`, shape: 'bell', freq, gain, q: id(`PEQ_Q${n}`), type: id(`PEQ_TYPE${n}`) });
      }
    }
    if (bands.length) out.push({ key: 'eq', kind: 'eq', title: 'EQ', mode: 'parametric', roles: {}, bands });
  }
  // GEQ: ten graphic bands; the centres come from the selected graphic-EQ model on the device (the client
  // spaces them evenly, the type names the frequencies)
  if (family === 'GEQ') {
    const id = (symbol: string) => {
      const resolved = byName.get(symbol);
      return resolved != null && (!present || present.has(resolved)) && (!inLayout || inLayout.has(resolved)) ? resolved : undefined;
    };
    const bands: VisualEqBand[] = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const gain = id(`GEQ_GAIN${n}`);
      if (gain != null) bands.push({ key: `band${n}`, gain });
    }
    if (bands.length) out.push({ key: 'eq', kind: 'eq', title: 'EQ', mode: 'graphic', roles: {}, bands });
  }
  return out;
}

/** Families with at least one visual definition. */
export function visualFamilies(): string[] {
  return Object.keys(BLOCK_VISUAL_DEFS);
}

// ── layout graph slots ────────────────────────────────────────────────────

/** Where a graph slot sits, for tokens whose meaning depends on it (CONTROLLERS, FILTER). */
export interface GraphSlotContext {
  /** Name of the page the slot is on. */
  page?: string;
  /** Parameter symbols of the other controls in the same row (null for decorative ones). */
  rowParamNames?: readonly (string | null)[];
}

const MODULATION_PAGE = /^(lfo|modulation)\b/i;

/** CONTROLLERS LFO/ADSR slot → its instance (1 | 2) from the row's params, else an unambiguous page name. */
function controllersInstance(which: 'LFO' | 'ADSR', ctx: GraphSlotContext): 1 | 2 | null {
  const re = new RegExp(`^CONTROLLERS_${which}([12])`);
  for (const name of ctx.rowParamNames ?? []) {
    const m = name ? re.exec(name) : null;
    if (m) return m[1] === '1' ? 1 : 2;
  }
  const pm = ctx.page ? new RegExp(`${which}\\s*([12])\\b`, 'i').exec(ctx.page) : null;
  if (pm && !/\+/.test(ctx.page!)) return pm[1] === '1' ? 1 : 2;
  return null;
}

function familyHasVisual(family: string, key: VisualKey): boolean {
  return (BLOCK_VISUAL_DEFS[family] ?? []).some((d) => d.key === key);
}

/**
 * Normalise a layout graph slot's raw widget token to the visual key it should show, or null when
 * the slot has no visual in this library (yet). Tokens without a visual today: `graph_eq`
 * (sidechain / reverb EQ response), `graph_reverb` (on the reverb EQ page of older layouts, most
 * likely an EQ response — so the reverb decay visual has no slot and is library-only), `graph3` /
 * `graph4` (multitap / amp / plex response), `graph_megatap`, `graph_modifier`, `graph_rta`,
 * `graph_eqMatch*`. `graph_peq` maps to `'eq'`.
 *
 * A key names the visual the slot is FOR, not a promise that one is served: the block's current
 * variant may lack the visual's required params (a comb-filter type has a `response` slot but no
 * frequency), and `'eq'` never has a served visual. A client treats a key without a served visual
 * as an empty slot.
 */
export function graphSlotKey(
  family: string,
  rawWidget: string | null | undefined,
  ctx: GraphSlotContext = {},
): GraphSlotKey | null {
  const tok = (rawWidget ?? '').trim().toLowerCase();
  if (!tok.startsWith('graph')) return null;
  if (tok === 'graph_peq') return 'eq';
  const pageFilter = PAGE_FILTERS[family];
  if (pageFilter?.token === tok) return pageFilter.visual.key;
  if (family === 'REVERB' && (tok === 'graph_eq' || tok === 'graph_reverb')) return 'reverbEq';
  if (family === 'DISTORT' && tok === 'graph4' && ctx.rowParamNames?.some((n) => n?.startsWith('DISTORT_INEQ'))) return 'inputEq';
  let key: VisualKey | null = null;
  if (tok === 'graph_comp_studio') key = 'dynamics';
  else if (tok === 'graph_lfo' || tok === 'graph_phaser' || tok === 'graph_trem') {
    if (family === 'CONTROLLERS') {
      const n = controllersInstance('LFO', ctx);
      key = n === 1 ? 'lfo1' : n === 2 ? 'lfo2' : null;
    } else key = 'lfo';
  } else if (tok === 'graph_adsr' || tok === 'graph_adsr_marker') {
    const n = family === 'CONTROLLERS' ? controllersInstance('ADSR', ctx) : null;
    key = n === 1 ? 'adsr1' : n === 2 ? 'adsr2' : null;
  } else if (tok === 'graph_filter') key = ctx.page && MODULATION_PAGE.test(ctx.page) ? 'lfo' : 'response';
  else if (tok.startsWith('graph_cab')) key = 'cabAlign';
  return key && familyHasVisual(family, key) ? key : null;
}

/**
 * Stamp every graph slot of a (resolved) layout's pages with its normalised `graphKey`
 * ({@link graphSlotKey}). Copy-on-write: untouched pages/rows/controls keep their identity; slots
 * without a key are left as they are. Several slots may carry the same key (e.g. a block whose
 * pages each show the LFO); a client anchors the visual at the first one in page order.
 */
/** Fixed-frequency band labels of an Amp Output EQ page ("62", "1K", "6.6k Hz", "1600"). */
const isAmpOutputEqPage = (page: EditorLayoutPage): boolean => /^\s*output\s*eq\s*$/i.test(page.name);

export function stampGraphKeys(family: string, pages: readonly EditorLayoutPage[]): EditorLayoutPage[] {
  const stamped = pages.map((page) => {
    const stamp = (controls: EditorLayoutPage['rows'][number]['controls']) => {
      const rowParamNames = controls.map((c) => c.paramName);
      return controls.map((c) => {
        if (c.widget !== 'graph') return c;
        const key = graphSlotKey(family, c.rawWidget, { page: page.name, rowParamNames });
        return key && c.graphKey !== key ? { ...c, graphKey: key } : c;
      });
    };
    const rows = page.rows.map((row) => {
      const controls = stamp(row.controls);
      return controls.some((c, i) => c !== row.controls[i]) ? { ...row, controls } : row;
    });
    let pageControls = page.pageControls ? stamp(page.pageControls) : undefined;
    // The Amp's Output EQ page has faders but no graph slot. A fader bank also works on choices
    // that carry band names instead of frequencies.
    const hasBands = rows.some((r) => r.controls.some((c) => /^DISTORT_EQ\d+$/.test(c.paramName ?? '') && !c.crossBlock));
    if (family === 'DISTORT' && isAmpOutputEqPage(page) && hasBands &&
        ![...rows.flatMap((r) => r.controls), ...(pageControls ?? [])].some((c) => c.graphKey === 'outputEq')) {
      pageControls = [...(pageControls ?? []), { label: 'Output EQ', paramName: null, paramId: null, widget: 'graph', rawWidget: 'graph_eq', graphKey: 'outputEq' }];
    }
    const changed = rows.some((r, i) => r !== page.rows[i]) || pageControls?.some((c, i) => c !== page.pageControls?.[i]);
    return changed ? { ...page, rows, ...(pageControls ? { pageControls } : {}) } : page;
  });
  // Some models/variants do not have an explicit visual slot. Offer these displays on the page
  // with their inputs, without assuming page names or adding a second copy beside a real slot.
  const visual = family === 'CHORUS' || family === 'COMP' ? BLOCK_VISUAL_DEFS[family]?.[0] : undefined;
  if (!visual) return stamped;
  if (stamped.some((page) => controlsOn(page).some((c) => c.graphKey === visual.key))) return stamped;
  const index = stamped.findIndex((page) => {
    const names = new Set(controlsOn(page).filter((c) => c.paramId != null && !c.crossBlock).map((c) => c.paramName));
    return visual.requires.some((group) => group.every((role) => names.has(visual.roles[role] ?? null)));
  });
  if (index < 0) return stamped;
  const page = stamped[index]!;
  stamped[index] = {
    ...page,
    pageControls: [...(page.pageControls ?? []), {
      label: visual.title, paramName: null, paramId: null, widget: 'graph',
      rawWidget: family === 'CHORUS' ? 'graph_lfo' : 'graph_comp_studio',
      graphKey: visual.key
    }]
  };
  return stamped;
}

/**
 * The block's own paramIds that a resolved layout's pages show (cross-block references and
 * decorative controls excluded) — the natural `presentParamIds` for {@link resolveBlockVisuals}.
 */
export function layoutParamIds(pages: readonly EditorLayoutPage[]): Set<number> {
  const out = new Set<number>();
  for (const page of pages) {
    for (const c of controlsOn(page))
      if (c.paramId != null && !c.crossBlock) out.add(c.paramId);
  }
  return out;
}


/** Amp EQ bindings are resolved from symbols; fixed frequencies come from the selected layout. */
function ampEqVisuals(byName: ReadonlyMap<string, number>, present: ReadonlySet<number> | null, inLayout: ReadonlySet<number> | null, pages?: readonly EditorLayoutPage[]): BlockVisual[] {
  const id = (name: string): number | undefined => {
    const n = byName.get(name);
    return n != null && (!present || present.has(n)) && (!inLayout || inLayout.has(n)) ? n : undefined;
  };
  const out: BlockVisual[] = [];
  const freq = id('DISTORT_INEQFREQ'), gain = id('DISTORT_INEQGAIN');
  if (freq != null && gain != null) {
    const bands: VisualEqBand[] = [{ key: 'peak', freq, gain, q: id('DISTORT_INEQQ'), type: id('DISTORT_INEQTYPE') }];
    const low = id('DISTORT_HPFREQ'), high = id('DISTORT_HICUT');
    if (low != null) bands.push({ key: 'lowCut', freq: low, shape: 'lowcut' });
    if (high != null) bands.push({ key: 'highCut', freq: high, shape: 'highcut' });
    out.push({ key: 'inputEq', kind: 'eq', title: 'Input EQ', mode: 'parametric', roles: {}, bands });
  }
  let best: VisualEqBand[] = [];
  for (const page of pages ?? []) {
    if (!isAmpOutputEqPage(page)) continue;
    const bands: VisualEqBand[] = [];
    for (const row of page.rows) for (const ctl of row.controls) {
      if (!/^DISTORT_EQ\d+$/.test(ctl.paramName ?? '') || ctl.crossBlock) continue;
      const gain = id(ctl.paramName!);
      const match = /^\s*(\d+(?:\.\d+)?)\s*(k)?(?:hz)?\s*$/i.exec(ctl.label);
      const centerHz = match ? Number(match[1]) * (match[2] ? 1000 : 1) : undefined;
      if (gain != null && !bands.some((b) => b.gain === gain)) {
        bands.push({ key: ctl.paramName!, gain, label: ctl.label.trim(), ...(centerHz ? { centerHz, shape: 'bell' } : {}) });
      }
    }
    if (bands.length > best.length) best = bands;
  }
  if (best.length) out.push({ key: 'outputEq', kind: 'eq', title: 'Output EQ', mode: 'graphic', roles: {}, bands: best });
  return out;
}