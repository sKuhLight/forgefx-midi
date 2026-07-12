/**
 * Editor-layout catalog v2 — shared, pure-TypeScript schema.
 *
 * Describes the block-editor UI layouts (pages/tabs → rows → controls) that
 * each Fractal desktop editor (Axe-Edit III / FM9-Edit / FM3-Edit / AM4-Edit)
 * uses to lay out an effect's parameters. Consumed by the per-device
 * `*.generated.ts` layout data files (`<DEV>_LAYOUTS`).
 *
 * This module is DATA-SHAPE ONLY: pure types plus one widget-normalisation
 * table. No runtime dependencies, browser-safe (no `node:*` imports).
 *
 * Provenance of the data files: each editor embeds a JUCE "config" XML
 * (`__block_layout.xml`, `__amp_layout*.xml`) whose document order is the
 * on-screen order (controls left→right per row, rows top→bottom, pages in
 * tab order). The generator (`scripts/gen-editor-layouts.ts`) parses those
 * and joins every control's editor symbol (`parameterName`) against the
 * device's own parameter catalog to resolve a wire `paramId`.
 */

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
  /** Rows in editor (top→bottom) order. */
  rows: EditorLayoutRow[];
  /** Firmware gate for the whole page, when present. */
  fw?: EditorFwRange;
  /**
   * Block-type / amp-model selector value(s) that activate this page, as the
   * editor's comma-joined list (e.g. amp pages keyed by `DISTORT_TYPE`). Only
   * set where the editor gates a page by a selector value.
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
