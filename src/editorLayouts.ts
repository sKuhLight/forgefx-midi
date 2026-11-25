/**
 * Editor-layout catalog v2 — shared, pure-TypeScript schema.
 *
 * Describes the block-editor UI layouts (pages/tabs → rows → controls) that
 * each Fractal desktop editor (Axe-Edit III / FM9-Edit / FM3-Edit / AM4-Edit)
 * uses to lay out an effect's parameters. Consumed by the per-device
 * `*.generated.ts` layout data files (`<DEV>_LAYOUTS`).
 *
 * This module is DATA-SHAPE ONLY: pure types, one widget-normalisation table
 * and the pure cross-block token helpers (`parseCrossToken`,
 * `crossBlockEffectId`). No imports, browser-safe (no `node:*`).
 *
 * Provenance of the data files: each editor ships a "config" XML
 * (`__block_layout.xml`, `__amp_layout*.xml`) whose document order is the
 * on-screen order (controls left→right per row, rows top→bottom, pages in
 * tab order). The generator (`scripts/gen-editor-layouts.ts`) parses those
 * and joins every control's editor symbol (`parameterName`) against the
 * device's own parameter catalog to resolve a wire `paramId`.
 */
import type { GraphSlotKey } from './visuals.js';

/**
 * Normalised widget kind. The editor XML uses ~90 fine-grained `type` values
 * (`knobCompact`, `dropdown1p5Tight`, `btnIgnoreScene`, …); each maps onto one
 * of these coarse kinds for rendering decisions, while the exact original
 * string is preserved on `EditorLayoutControl.rawWidget`.
 */
export type EditorWidgetKind =
  | 'knob'
  | 'toggle'
  | 'slider'
  | 'dropdown'
  | 'graph'
  | 'spacer'
  | 'button'
  | 'meter'
  | 'label'
  | 'readout'
  | 'unknown';

/** Optional firmware gate (inclusive lower / exclusive upper), as `"maj,min"`. */
export interface EditorFwRange {
  /** Applies for firmware >= this version (editor `version_gtet`). */
  gtet?: string;
  /** Applies for firmware < this version (editor `version_lt`). */
  lt?: string;
}

/** Fine placement hints the editor specifies for a control. */
export interface EditorControlPlacement {
  /** Zero-based layout column within its row, when specified. */
  col?: number;
  /** Horizontal pixel nudge from the grid slot. */
  offsetX?: number;
  /** Vertical pixel nudge from the grid slot. */
  offsetY?: number;
  /** Absolute `"x,y"` pixel position (overrides the grid) when specified. */
  positionExact?: string;
}

/**
 * A control whose owning effect differs from the page it renders on — e.g. the
 * global metronome shown on a block's Tempo page, or a modifier/foot-controller
 * reference. `effect` is the editor's cross-reference token (e.g. `ID_GLOBAL`).
 */
export interface EditorCrossBlockRef {
  /** Editor cross-effect token, e.g. `'ID_GLOBAL'`, `'ID_MODIFIER1'`. */
  effect: string;
  /** Resolved catalog family of the referenced parameter, or null. */
  family: string | null;
  /** The referenced parameter's editor symbol. */
  paramName: string | null;
  /** Resolved wire paramId of the referenced parameter, or null. */
  paramId: number | null;
  /**
   * Wire effectId of the block that owns the referenced parameter. SERVED BY
   * THE HOST, NEVER GENERATED: the layout data files never carry it (the
   * owning instance depends on the connected device and its profile). A host
   * fills it at serve time, e.g. via the device's cross-block resolver
   * (`fm3CrossBlockEffectId` / `fm9CrossBlockEffectId` /
   * `axe3CrossBlockEffectId`). `null` or absent means "no addressable owner"
   * (modifier / preset-level tokens, unknown family, instance beyond the
   * device): the control stays display-only.
   */
  effectId?: number | null;
}

/** An editor cross-effect token split into its symbol and 1-based instance. */
export interface EditorCrossToken {
  /** Token symbol without the `ID_` prefix and instance digits, e.g. `'OUTPUT'`, `'PRESET_FC'`. */
  symbol: string;
  /** 1-based instance from the trailing digits; 1 when the token has none. */
  instance: number;
}

/**
 * Split an editor cross-effect token (`'ID_<SYMBOL>[<n>]'`) into its symbol
 * and instance: `'ID_OUTPUT2'` → `{ symbol: 'OUTPUT', instance: 2 }`,
 * `'ID_GLOBAL'` → `{ symbol: 'GLOBAL', instance: 1 }`, `'ID_PRESET_FC'` →
 * `{ symbol: 'PRESET_FC', instance: 1 }`. Returns null for anything that is
 * not such a token (missing `ID_` prefix, lowercase, empty symbol, instance 0).
 *
 * The symbol is the editor's own name and need not equal the catalog family
 * (`FOOTCONTROLLER` is family `FC`, `MODIFIER` is `MOD`); the owning family is
 * the `family` the generator resolved from the referenced parameter.
 */
export function parseCrossToken(token: string): EditorCrossToken | null {
  const m = /^ID_([A-Z][A-Z0-9_]*?)(\d+)?$/.exec(token);
  if (!m || m[1].endsWith('_')) return null; // `ID_X_2`: no symbol/instance split
  const instance = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isSafeInteger(instance) || instance < 1) return null;
  return { symbol: m[1], instance };
}

/**
 * Families a cross-block reference never addresses by effect id: modifier
 * slots (`ID_MODIFIER<n>`, family `MOD`) are not blocks, and `ID_PRESET_FC`
 * (family `PRESET`) is preset-level data with no effect id.
 */
const CROSS_BLOCK_UNADDRESSED: ReadonlySet<string> = new Set(['MOD', 'PRESET']);

/** The part of a cross-block reference the effect-id resolvers read. */
export type CrossBlockRefKey = Pick<EditorCrossBlockRef, 'effect' | 'family'>;

/** A device's family symbol → first-instance effect id table (`null`: no id of its own). */
export type FamilyFirstEffectIds = Readonly<Record<string, number | null>>;

/**
 * Number of consecutive effect ids reserved from `firstEffectId` on, or
 * undefined when unknown (e.g. `gen3RosterSpan` over the shared gen-3 roster).
 */
export type CrossBlockSpanLookup = (firstEffectId: number) => number | undefined;

/**
 * Resolve the owning effect id of a cross-block reference against ONE
 * device's family → first-effectId table: `firstId(family) + instance - 1`.
 *
 * Device-neutral building block, for hosts that resolve families through
 * their own runtime table (catalog plus block-map families); the device-bound
 * resolvers (`fm3CrossBlockEffectId`, `fm9CrossBlockEffectId`,
 * `axe3CrossBlockEffectId`) pass the device's static table and the shared
 * gen-3 roster span. `instanceCount` is the CONNECTED device's instance count
 * for the referenced family (the host's per-device instance limits; 1 for
 * singletons such as GLOBAL or FC); an instance beyond it resolves to null.
 *
 * `reservedSpan` caps the instance by the id span reserved for the family, so
 * an oversized `instanceCount` cannot run into the next family's ids. Without
 * it the CALLER guarantees `instanceCount` never exceeds that span.
 *
 * Returns null as well for an unparseable token, a null / unknown family, a
 * family without an effect id, and `MOD` / `PRESET`. Resolving an id does not
 * make the target writable: GLOBAL (effect id 1) is persistent device setup,
 * so a host keeps its write guards in place.
 */
export function crossBlockEffectId(
  ref: CrossBlockRefKey,
  firstEffectIds: FamilyFirstEffectIds,
  instanceCount: number,
  reservedSpan?: CrossBlockSpanLookup,
): number | null {
  const tok = parseCrossToken(ref.effect);
  if (!tok || !ref.family || CROSS_BLOCK_UNADDRESSED.has(ref.family)) return null;
  if (!Object.prototype.hasOwnProperty.call(firstEffectIds, ref.family)) return null;
  const first = firstEffectIds[ref.family];
  if (first === null || first === undefined) return null;
  if (!Number.isSafeInteger(instanceCount) || tok.instance > instanceCount) return null;
  const span = reservedSpan?.(first);
  if (span !== undefined && tok.instance > span) return null;
  return first + tok.instance - 1;
}

/** One control on an editor page. */
export interface EditorLayoutControl {
  /** Editor caption (HTML entities decoded; may contain `\n`). '' if none. */
  label: string;
  /** Editor parameter symbol, or null for decorative controls (spacer/label/graph). */
  paramName: string | null;
  /** Resolved wire paramId (join vs the device catalog by name), or null. */
  paramId: number | null;
  /** Normalised widget kind. */
  widget: EditorWidgetKind;
  /** Original editor `type` string (e.g. `'knobCompact'`), preserved verbatim. */
  rawWidget: string;
  /** Fine placement hints, when any are present. */
  placement?: EditorControlPlacement;
  /** Cross-block reference, when this control belongs to another effect. */
  crossBlock?: EditorCrossBlockRef;
  /** Per-control firmware gate, when present. */
  fw?: EditorFwRange;
  /**
   * Graph slots only: the normalised visual key this slot is for (see `graphSlotKey` /
   * `stampGraphKeys` in `visuals.ts`). Absent in the generated layout data; a server stamps it
   * on the layouts it serves. Absent = the slot has no visual. A stamped key may still have NO
   * served visual (the current variant lacks the visual's required params, or the key is `'eq'`);
   * a client treats such a slot as a gap.
   */
  graphKey?: GraphSlotKey;
}

/** One row of controls (editor order). */
export interface EditorLayoutRow {
  /** Which page section the row belongs to. */
  section: 'parameters' | 'mixer';
  /** Controls in this row, left→right editor order. */
  controls: EditorLayoutControl[];
}

/** One editor page (tab) of a block variant. */
export interface EditorLayoutPage {
  /** Page/tab name as shown in the editor (e.g. 'Basic', 'Authentic'). */
  name: string;
  /** Editor page number, when specified. */
  pageNum?: number;
  /** Rows in editor (top→bottom) order. Empty only on a page whose controls are all page-level. */
  rows: EditorLayoutRow[];
  /**
   * Controls the editor places directly on the page, outside its row sections
   * (section titles, separators, page-wide selectors and switches), in editor
   * document order. Same shape as a row control; most carry
   * `placement.positionExact`. Decorative entries are included verbatim. A
   * parameter of another family without a cross-block reference keeps its
   * `paramName`, but its `paramId` is null: that id is not one of this block's.
   * Absent when the page has none.
   */
  pageControls?: EditorLayoutControl[];
  /** Firmware gate for the whole page, when present. */
  fw?: EditorFwRange;
  /**
   * Block-type / amp-model selector value(s) that activate this page, as the
   * editor's comma-joined list (e.g. amp pages keyed by `DISTORT_TYPE`). Only
   * set where the editor gates a page by a selector value. An empty list (`''`)
   * is the editor's catch-all for its tab: it applies to every selector value no
   * explicitly-valued sibling page on the same tab names on the catch-all's
   * firmware (the generator folds it that way when it splits a page-level
   * selector into per-type variants).
   */
  value?: string;
  /** The selector parameter whose `value` gates this page, when present. */
  selectorParamName?: string;
}

/**
 * One block-type variant of a block's layout. The `value` is the block-type
 * selector value(s) that select this variant (comma-joined as in the editor
 * XML), or null when the block has a single unconditional layout.
 */
export interface EditorLayoutVariant {
  /** Editor variant display name (e.g. 'Analog', '10 Band', 'Amp GTE 6.00'). */
  name: string;
  /** Block-type selector value(s) selecting this variant, or null. */
  value: string | null;
  /**
   * The selector parameter `value` refers to, when the generator folded a
   * page-level type selector into per-type variants (e.g. `'DELAY_TYPE'`, which
   * is not the block's model selector `DELAY_MODEL`). Also set on such a
   * block's fallback variant (`value: null`), which catches every value of that
   * selector no other variant names. Absent on variants the editor itself keys
   * (their selector is implied) and on unconditional ones.
   */
  selectorParamName?: string;
  /** Firmware gate for the whole variant, when present. */
  fw?: EditorFwRange;
  /**
   * True for the variant pinned to the device's current firmware ceiling.
   * Used for firmware-versioned layouts (the Amp block): every historical
   * variant is kept, exactly one is flagged as the shipped/current one.
   */
  pinned?: boolean;
  /** Pages (tabs) in editor display order. */
  pages: EditorLayoutPage[];
}

/** A block's full editor layout: its block-type variants. */
export interface EditorBlockLayout {
  /** Editor display name of the block (e.g. 'Reverb', 'Amp', 'Foot Controller'). */
  editorName: string;
  /** Catalog family symbol — the key into `<DEV>_LAYOUTS` and the param catalog. */
  family: string;
  /** Block-type variants in editor order. */
  variants: EditorLayoutVariant[];
}

/** A device's editor layouts, keyed by catalog family symbol. */
export type DeviceEditorLayouts = Readonly<Record<string, EditorBlockLayout>>;

/**
 * Map an editor `type` string to a coarse {@link EditorWidgetKind}. Prefix
 * based so firmware-specific variants (`knobCompact`, `dropdown1p5Tight`,
 * `btnIgnoreScene`, `meterGainVert`, …) collapse onto their base kind.
 */
export function normalizeWidget(rawType: string | null | undefined): EditorWidgetKind {
  const t = (rawType ?? '').toLowerCase();
  if (!t) return 'unknown';
  if (t.startsWith('knob')) return 'knob';
  if (t.startsWith('toggle')) return 'toggle';
  if (t.startsWith('slider')) return 'slider';
  if (t.startsWith('dropdown')) return 'dropdown';
  if (t.startsWith('graph')) return 'graph';
  if (t === 'spacer' || t.startsWith('spacer') || t.startsWith('seperator') || t.startsWith('separator')) return 'spacer';
  if (t.startsWith('btn') || t === 'button') return 'button';
  if (t.startsWith('meter')) return 'meter';
  if (t.startsWith('readout')) return 'readout';
  if (t.includes('label')) return 'label';
  return 'unknown';
}

/** All widget kinds, for validation. */
export const EDITOR_WIDGET_KINDS: readonly EditorWidgetKind[] = [
  'knob', 'toggle', 'slider', 'dropdown', 'graph', 'spacer',
  'button', 'meter', 'label', 'readout', 'unknown',
];
