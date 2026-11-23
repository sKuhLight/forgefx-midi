/**
 * Per-block state params of the gen-3 family: **Scene Ignore** and **Bypass Mode**.
 *
 * Both are ordinary per-block enum params, named `<FAMILY>_SCENEIGNORE` (OFF / ON)
 * and `<FAMILY>_BYPASSMODE` (THRU / MUTE / MUTE IN / MUTE OUT / MUTE FX IN /
 * MUTE FX OUT — each block offers its own 2–5 of these). They live in the
 * block's channel-blocked param body, so both are PER CHANNEL: a block with
 * Scene Ignore ON on its active channel keeps its state on scene changes
 * (footswitches can still bypass it or change its channel), and Bypass Mode
 * only acts while the block is bypassed.
 *
 * The param ids differ per device AND per family (the FM9 places Scene Ignore
 * in a shared block header, so its DISTORT / DELAY / REVERB use id 6, while
 * the FM3 uses 137 / 83 / 51 and the Axe-Fx III 135 / 83 / 60). They are
 * therefore always resolved BY NAME in the device's own catalog — never
 * reused across model bytes.
 *
 * Minimum firmware: Scene Ignore arrived in a firmware update (FM3 5.03, FM9
 * 2.03, Axe-Fx III 19.05); a few families gained it later (RINGMOD on FM3
 * 11.01 / FM9 10.01 / III 29.02, MULTIPLEXER on the III 19.06). These gates
 * match the per-control firmware gates of this package's block layout data
 * (`*_LAYOUTS`; test/gen3/block-state pins the table to them). Bypass Mode carries no gate.
 *
 * Writable models: Axe-Fx III (0x10), FM3 (0x11), FM9 (0x12). The VP4 catalog
 * names Scene Ignore on four families, but VP4 discrete writes are not decoded
 * (its writer refuses them), so the VP4 resolves to nothing here; the AM4 and
 * the earlier generations have no such params.
 *
 * Which bypass modes silence the block: {@link isMutingBypassMode} (core
 * routing, shared with the audibility walker's MUTING_BYPASS_MODES).
 */
import { FM3_PARAMS_BY_FAMILY } from '../../gen3/fm3/params.js';
import { FM9_PARAMS_BY_FAMILY } from '../../gen3/fm9/params.js';
import { PARAMS_BY_FAMILY as AXE3_PARAMS_BY_FAMILY } from '../../gen3/axe-fx-iii/params.js';
import type { Param } from '../../gen3/types.js';

export { MUTING_BYPASS_MODES, isMutingBypassMode, mutingBypassOrdinals } from '../../core/routing/audibility.js';

/** A firmware version as the device reports it (major.minor, minor 0..99: 5.03 → { major: 5, minor: 3 }). */
export interface BlockStateFirmware {
  major: number;
  minor: number;
}

/** One resolved block-state param: its wire id in THIS device's catalog, plus its firmware gate. */
export interface BlockStateParam {
  /** Wire paramId in the device's own catalog (fn 0x01 SET/GET, the active channel). */
  paramId: number;
  /** Catalog symbol, e.g. `'DISTORT_SCENEIGNORE'`. */
  name: string;
  /** The param exists from this firmware on; absent = no known gate. */
  minFw?: BlockStateFirmware;
}

/** The block-state params a block family has on a model (a key is absent when the family lacks it). */
export interface BlockStateParams {
  sceneIgnore?: BlockStateParam;
  bypassMode?: BlockStateParam;
}

const MODEL_AXE_FX_III = 0x10;
const MODEL_FM3 = 0x11;
const MODEL_FM9 = 0x12;

/** The catalogs of the models whose block-state params are writable (see the module note on the VP4). */
const CATALOGS: Readonly<Record<number, Readonly<Record<string, readonly Param[]>>>> = {
  [MODEL_AXE_FX_III]: AXE3_PARAMS_BY_FAMILY,
  [MODEL_FM3]: FM3_PARAMS_BY_FAMILY,
  [MODEL_FM9]: FM9_PARAMS_BY_FAMILY,
};

const fw = (major: number, minor: number): BlockStateFirmware => ({ major, minor });

/** Scene Ignore firmware gate per model: the model-wide release, plus the families that gained it later. */
const SCENE_IGNORE_MIN_FW: Readonly<Record<number, { all: BlockStateFirmware; byFamily: Readonly<Record<string, BlockStateFirmware>> }>> = {
  [MODEL_AXE_FX_III]: { all: fw(19, 5), byFamily: { RINGMOD: fw(29, 2), MULTIPLEXER: fw(19, 6) } },
  [MODEL_FM3]: { all: fw(5, 3), byFamily: { RINGMOD: fw(11, 1) } },
  [MODEL_FM9]: { all: fw(2, 3), byFamily: { RINGMOD: fw(10, 1) } },
};

/** The models {@link blockStateParams} resolves (Axe-Fx III, FM3, FM9). */
export const BLOCK_STATE_MODELS: readonly number[] = [MODEL_AXE_FX_III, MODEL_FM3, MODEL_FM9];

/** True when the model has writable block-state params (Axe-Fx III / FM3 / FM9). */
export function hasBlockStateParams(modelId: number): boolean {
  return modelId in CATALOGS;
}

/**
 * The Scene Ignore and Bypass Mode params of one block family on one model, looked up by name
 * (`<FAMILY>_SCENEIGNORE` / `<FAMILY>_BYPASSMODE`) in that model's own catalog. Returns `{}` for a
 * model without writable block-state params (VP4, AM4, gen-1/2) and for an unknown family; a key is
 * absent when the family lacks that param (e.g. the VOLUME block has a bypass mode but no Scene Ignore).
 */
export function blockStateParams(modelId: number, family: string): BlockStateParams {
  const catalog = CATALOGS[modelId];
  if (!catalog) return {};
  const fam = family.toUpperCase();
  const rows = catalog[fam];
  if (!rows) return {};
  const out: BlockStateParams = {};
  const si = rows.find((p) => p.name === `${fam}_SCENEIGNORE`);
  if (si) {
    const gate = SCENE_IGNORE_MIN_FW[modelId];
    const minFw = gate ? (gate.byFamily[fam] ?? gate.all) : undefined;
    out.sceneIgnore = { paramId: si.paramId, name: si.name, ...(minFw ? { minFw: { ...minFw } } : {}) };
  }
  const bm = rows.find((p) => p.name === `${fam}_BYPASSMODE`);
  if (bm) out.bypassMode = { paramId: bm.paramId, name: bm.name };
  return out;
}

/** Is `firmware` at or above `min`? An unknown firmware (null) is not below any gate (returns true). */
export function firmwareAtLeast(firmware: BlockStateFirmware | null | undefined, min: BlockStateFirmware | undefined): boolean {
  if (!min || !firmware) return true;
  if (!Number.isFinite(firmware.major) || !Number.isFinite(firmware.minor)) return true;
  if (firmware.major !== min.major) return firmware.major > min.major;
  return firmware.minor >= min.minor;
}

/** Display form of a firmware gate: `{ major: 5, minor: 3 }` → `'5.03'`. */
export function formatBlockStateFirmware(v: BlockStateFirmware): string {
  return `${v.major}.${String(v.minor).padStart(2, '0')}`;
}
