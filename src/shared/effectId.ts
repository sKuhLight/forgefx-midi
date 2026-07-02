/**
 * Cross-device effect-ID resolver.
 *
 * Resolves a block reference ("Reverb 1", "Amp", "Drive 2") to the
 * numeric block identifier the device's wire protocol uses, dispatching
 * by model byte. This is the "new gear is a descriptor" payoff at the
 * block layer: one resolver, every Fractal model byte, so a caller that
 * says "Reverb 1" gets the right wire id whether it is talking to an
 * AM4, an Axe-Fx II, or any gen-3 unit.
 *
 * The number returned is the device's own block identifier, and the
 * SEMANTICS differ by family (this is deliberate, not a leak):
 *
 *   - **AM4 (0x15)** returns the block's `pidLow`, the 14-bit address
 *     the AM4 writes (as a float32) into a slot register to place the
 *     block. The AM4 has ONE instance per block type, so any instance
 *     above 1 is rejected.
 *   - **Axe-Fx II (0x07)** returns the 14-bit `effectId` used in
 *     GET/SET_BLOCK_PARAMETER_VALUE. Instances are distinct ids that
 *     share a parameter table (Amp 1 = 106, Amp 2 = 107).
 *   - **gen-3 (III 0x10 / FM3 0x11 / FM9 0x12 / VP4 0x14)** returns the
 *     effect id `firstId + (instance - 1)`. The whole gen-3 family
 *     shares one block roster, so this resolves identically across the
 *     four model bytes. (VP4 hosts a subset of the roster; the device
 *     descriptor gates availability, and this resolver only maps name to
 *     id.)
 *
 * Because the identifier is per-family, never join an id from one model
 * byte onto another. The resolver is the single place that knows which
 * table a model byte uses.
 */

import {
  resolveBlockType as am4ResolveBlockType,
} from '../am4/blockTypes.js';
import {
  resolveBlock as axeFxIIResolveBlock,
  IDS_BY_GROUP as AXE_FX_II_IDS_BY_GROUP,
} from '../gen2/axe-fx-ii/blockTypes.js';
import {
  resolveEffectId as gen3ResolveEffectId,
} from '../gen3/axe-fx-iii/blockTypes.js';

/** Model bytes the resolver understands, keyed by short device slug. */
export const FRACTAL_MODEL_BYTES = {
  am4: 0x15,
  axeFxII: 0x07,
  axeFxIII: 0x10,
  fm3: 0x11,
  fm9: 0x12,
  vp4: 0x14,
} as const;

/** Model bytes whose blocks share the gen-3 (Axe-Fx III) roster. */
const GEN3_MODEL_BYTES: ReadonlySet<number> = new Set([0x10, 0x11, 0x12, 0x14]);

/**
 * Split a block reference like `"Reverb 1"` into its base name and a
 * 1-based instance. An explicit `instance` argument wins over a trailing
 * number in the name; if neither is present the instance defaults to 1.
 */
function splitBlockRef(
  name: string,
  instance?: number,
): { baseName: string; instance: number } {
  const m = name.match(/^(.+?)\s*(\d+)?\s*$/);
  const baseName = m?.[1]?.trim() ?? name.trim();
  const trailing = m?.[2] ? Number.parseInt(m[2], 10) : undefined;
  return { baseName, instance: instance ?? trailing ?? 1 };
}

/**
 * Resolve a block name (with optional instance) to its device-native
 * block identifier for the given model byte. Throws with a clear
 * message on an unknown model byte, an unknown block, or an
 * out-of-range instance.
 *
 * @param modelByte device model byte (e.g. `0x15` AM4, `0x07` Axe-Fx II,
 *   `0x10` Axe-Fx III, `0x11` FM3, `0x12` FM9, `0x14` VP4)
 * @param name block reference, e.g. `"Reverb 1"`, `"Amp"`, `"Drive 2"`,
 *   or the AM4 lowercase form `"reverb"`. A trailing instance number is
 *   honored when `instance` is not given.
 * @param instance 1-based instance (defaults to 1, or to the trailing
 *   number parsed from `name`)
 */
export function resolveEffectId(
  modelByte: number,
  name: string,
  instance?: number,
): number {
  const { baseName, instance: resolvedInstance } = splitBlockRef(name, instance);

  // ── AM4 (single instance per block; returns pidLow) ──────────────
  if (modelByte === FRACTAL_MODEL_BYTES.am4) {
    const wire = am4ResolveBlockType(baseName.toLowerCase());
    if (wire === undefined) {
      throw new Error(
        `Unknown AM4 block "${baseName}". Try a lowercase block name ` +
          `like "amp", "reverb", "delay", "drive".`,
      );
    }
    if (resolvedInstance !== 1) {
      throw new Error(
        `AM4 "${baseName}" has a single instance; instance ${resolvedInstance} ` +
          `is not addressable (the AM4 hosts one of each block type).`,
      );
    }
    return wire;
  }

  // ── Axe-Fx II (distinct effectId per instance) ───────────────────
  if (modelByte === FRACTAL_MODEL_BYTES.axeFxII) {
    // Numbered display name first ("Reverb 1"), then the bare name for
    // singletons that carry no instance number ("Formant", "Enhancer").
    const numbered = axeFxIIResolveBlock(`${baseName} ${resolvedInstance}`);
    if (numbered) return numbered.id;
    if (resolvedInstance === 1) {
      const singleton = axeFxIIResolveBlock(baseName);
      if (singleton) return singleton.id;
    }
    // Group-code form ("AMP", "REV") indexed by instance.
    const byGroup = AXE_FX_II_IDS_BY_GROUP[baseName.toUpperCase()];
    if (byGroup) {
      const id = byGroup[resolvedInstance - 1];
      if (id !== undefined) return id;
      throw new Error(
        `Axe-Fx II "${baseName}" instance ${resolvedInstance} out of range ` +
          `(1..${byGroup.length}).`,
      );
    }
    throw new Error(
      `Unknown Axe-Fx II block "${name}". Try a name like "Reverb 1", ` +
        `"Amp 2", or a group code like "REV".`,
    );
  }

  // ── gen-3 family (III / FM3 / FM9 / VP4), shared roster ──────────
  if (GEN3_MODEL_BYTES.has(modelByte)) {
    return gen3ResolveEffectId(baseName, resolvedInstance);
  }

  throw new Error(
    `Unknown Fractal model byte 0x${modelByte.toString(16)}. Supported: ` +
      `0x15 (AM4), 0x07 (Axe-Fx II), 0x10 (Axe-Fx III), 0x11 (FM3), ` +
      `0x12 (FM9), 0x14 (VP4).`,
  );
}
