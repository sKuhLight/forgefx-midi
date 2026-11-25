/**
 * Block visuals bound to each gen-3 grid device's OWN catalog.
 *
 * `visuals.ts` (package root) holds the role tables keyed by catalog symbol; this module resolves
 * them against the FM3, FM9 or Axe-Fx III catalog by name, so every served paramId is the device's
 * own (the three catalogs share symbols but not ids). VP4 and the non-gen-3 devices have no
 * visuals.
 */
import {
  resolveBlockVisuals,
  type BlockVisual,
  type ResolveVisualsOptions,
  type VisualCatalogParam,
} from '../../visuals.js';
import { FM3_PARAMS_BY_FAMILY } from '../../gen3/fm3/index.js';
import { FM9_PARAMS_BY_FAMILY } from '../../gen3/fm9/index.js';
import { PARAMS_BY_FAMILY as AXE3_PARAMS_BY_FAMILY } from '../../gen3/axe-fx-iii/index.js';

/** Gen-3 grid devices with block visuals, by profile key. */
export type Gen3VisualModel = 'axe3' | 'fm3' | 'fm9';

type Catalog = Readonly<Record<string, readonly VisualCatalogParam[]>>;

const CATALOGS: Readonly<Record<Gen3VisualModel, Catalog>> = {
  axe3: AXE3_PARAMS_BY_FAMILY as unknown as Catalog,
  fm3: FM3_PARAMS_BY_FAMILY as unknown as Catalog,
  fm9: FM9_PARAMS_BY_FAMILY as unknown as Catalog,
};

/** SysEx model byte → visual model key (0x10 Axe-Fx III, 0x11 FM3, 0x12 FM9). */
const MODEL_BY_BYTE: Readonly<Record<number, Gen3VisualModel>> = { 0x10: 'axe3', 0x11: 'fm3', 0x12: 'fm9' };

/** Normalise a model key or SysEx model byte; null when the device has no block visuals. */
export function gen3VisualModel(model: Gen3VisualModel | number | string): Gen3VisualModel | null {
  if (typeof model === 'number') return MODEL_BY_BYTE[model] ?? null;
  return Object.prototype.hasOwnProperty.call(CATALOGS, model) ? (model as Gen3VisualModel) : null;
}

/** True when `model` (key or model byte) has block visuals. */
export function hasBlockVisuals(model: Gen3VisualModel | number | string): boolean {
  return gen3VisualModel(model) != null;
}

/**
 * The visuals a block `family` offers on `model`, with every role resolved to that device's own
 * paramId. `presentParamIds` (optional) restricts roles to the params present for the block (e.g.
 * the ids a server serves); without it every catalog param counts — which is how a block with no
 * layout (DELAY) still gets its visual. `opts.layoutParamIds` strictly narrows every visual to the
 * current layout variant's controls (see `resolveBlockVisuals`).
 * Unknown model/family → `[]`.
 */
export function blockVisuals(
  model: Gen3VisualModel | number | string,
  family: string,
  presentParamIds?: Iterable<number> | null,
  opts: ResolveVisualsOptions = {},
): BlockVisual[] {
  const key = gen3VisualModel(model);
  if (!key) return [];
  return resolveBlockVisuals(CATALOGS[key][family], family, presentParamIds, opts);
}
