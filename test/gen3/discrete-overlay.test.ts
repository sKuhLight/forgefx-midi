/**
 * Gen-3 discrete-ordinal classification overlay goldens.
 *
 * Params like CHORUS_VOICES, CABINET_TYPE1/2, REVERB_NUMSPRINGS, PITCH_NOTE*,
 * etc. are DISCRETE ORDINALS on the device (an integer index sent as
 * float32(ordinal), sub-action 09 00) even though our range/enum paths left
 * them classified continuous. The discrete-overlay (src/gen3/<device>/discreteOverlay.ts,
 * ported from upstream fractal-midi 0.6.1) reclassifies them at the catalog
 * boundary so the writer routes them DISCRETE instead of continuous (which
 * would send the WRONG wire value).
 *
 * This suite asserts, per device (III / FM9 / FM3):
 *   - every overlay symbol PRESENT in that device's catalog routes DISCRETE
 *     (`wire_kind === 'discrete'`), i.e. lands in the ordinal 09 00 path;
 *   - the representative CHORUS_VOICES param is reclassified discrete, reports
 *     `unit: 'enum'`, encodes an ordinal, and its device-true SET frame carries
 *     the discrete sub-action 09 00 (not the continuous 52 00);
 *   - a genuinely continuous knob is NOT swept into the discrete path (the
 *     overlay is additive, not a blanket reclassification).
 */
import { createModernFractalDescriptor } from '../../src/devices/gen3/factory.js';
import { AXE_FX_III_CONFIG } from '../../src/devices/gen3/configs/axe-fx-iii.js';
import { FM3_CONFIG } from '../../src/devices/gen3/configs/fm3.js';
import { FM9_CONFIG } from '../../src/devices/gen3/configs/fm9.js';
import {
  createModernFractalCodec,
  resolveEffectId,
  PARAMS_BY_FAMILY,
  III_ROUNDTRIP_DISCRETE,
} from '../../src/gen3/axe-fx-iii/index.js';
import { FM9_ROUNDTRIP_DISCRETE, FM9_PARAMS_BY_FAMILY } from '../../src/gen3/fm9/index.js';
import { FM3_FAMILY_JOIN_DISCRETE, FM3_PARAMS_BY_FAMILY } from '../../src/gen3/fm3/index.js';
import type { DeviceDescriptor, ParamSchema } from '../../src/core/protocol-generic/types.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[discrete-overlay] ${msg}`);
}

/** Every catalogued param on a descriptor keyed by its firmware symbol name. */
function paramsByFirmwareSymbol(desc: DeviceDescriptor): Map<string, ParamSchema> {
  const out = new Map<string, ParamSchema>();
  for (const block of Object.values(desc.blocks)) {
    for (const schema of Object.values(block.params)) {
      const name = schema.parameter_name;
      if (typeof name === 'string' && !out.has(name)) out.set(name, schema);
    }
  }
  return out;
}

/** Does a SysEx frame carry the two-byte sub-action right after fn=0x01? */
function hasSubAction(frame: readonly number[], a: number, b: number): boolean {
  // envelope: F0 00 01 74 <model> <fn=0x01> <subA> <subB> ...
  return frame[5] === 0x01 && frame[6] === a && frame[7] === b;
}

interface DeviceCase {
  readonly label: string;
  readonly desc: DeviceDescriptor;
  readonly modelByte: number;
  readonly overlay: Readonly<Record<string, number>>;
  readonly paramsByFamily: Readonly<Record<string, readonly { name: string; paramId: number }[]>>;
}

const DEVICES: readonly DeviceCase[] = [
  {
    label: 'Axe-Fx III',
    desc: createModernFractalDescriptor(AXE_FX_III_CONFIG),
    modelByte: 0x10,
    overlay: III_ROUNDTRIP_DISCRETE,
    paramsByFamily: PARAMS_BY_FAMILY,
  },
  {
    label: 'FM9',
    desc: createModernFractalDescriptor(FM9_CONFIG),
    modelByte: 0x12,
    overlay: FM9_ROUNDTRIP_DISCRETE,
    paramsByFamily: FM9_PARAMS_BY_FAMILY,
  },
  {
    label: 'FM3',
    desc: createModernFractalDescriptor(FM3_CONFIG),
    modelByte: 0x11,
    overlay: FM3_FAMILY_JOIN_DISCRETE,
    paramsByFamily: FM3_PARAMS_BY_FAMILY,
  },
];

const cases: Array<() => void> = [];

for (const dev of DEVICES) {
  // 1. Every overlay symbol present in the catalog routes DISCRETE.
  cases.push(() => {
    const catalog = paramsByFirmwareSymbol(dev.desc);
    let applied = 0;
    for (const [symbol] of Object.entries(dev.overlay)) {
      const schema = catalog.get(symbol);
      if (schema === undefined) continue; // absent from this device's catalog — skip silently
      applied += 1;
      assert(
        schema.wire_kind === 'discrete',
        `${dev.label}: overlay symbol ${symbol} routes '${schema.wire_kind}', expected 'discrete'`,
      );
    }
    assert(applied > 0, `${dev.label}: no overlay symbols matched the catalog (wiring broken?)`);
  });

  // 2. CHORUS_VOICES: the representative reclassified param.
  cases.push(() => {
    const schema = paramsByFirmwareSymbol(dev.desc).get('CHORUS_VOICES');
    assert(schema !== undefined, `${dev.label}: CHORUS_VOICES not in catalog`);
    assert(
      schema!.wire_kind === 'discrete',
      `${dev.label}: CHORUS_VOICES wire_kind='${schema!.wire_kind}', expected 'discrete'`,
    );
    assert(schema!.unit === 'enum', `${dev.label}: CHORUS_VOICES unit='${schema!.unit}', expected 'enum'`);
    // Ordinal encode: a valid ordinal passes through as the discrete-SET value.
    assert(schema!.encode(2) === 2, `${dev.label}: CHORUS_VOICES.encode(2) !== 2`);

    // The device-true SET frame for this param must be the DISCRETE builder
    // (sub 09 00), not the continuous one (sub 52 00) — that is what the writer
    // selects for wire_kind==='discrete'.
    const voices = (dev.paramsByFamily['CHORUS'] ?? []).find((p) => p.name === 'CHORUS_VOICES');
    assert(voices !== undefined, `${dev.label}: CHORUS_VOICES has no paramId`);
    const codec = createModernFractalCodec(dev.modelByte);
    const effectId = resolveEffectId('Chorus', 1);
    const discreteFrame = codec.buildSetParameter(effectId, voices!.paramId, 2);
    assert(
      hasSubAction(discreteFrame, 0x09, 0x00),
      `${dev.label}: CHORUS_VOICES discrete SET frame lacks sub-action 09 00`,
    );
    const continuousFrame = codec.buildSetParameterContinuous(effectId, voices!.paramId, 0.5);
    assert(
      hasSubAction(continuousFrame, 0x52, 0x00),
      `${dev.label}: continuous builder sanity — expected sub-action 52 00`,
    );
  });

  // 3. Regression: the overlay is additive — a genuinely continuous param that
  //    is NOT in the overlay must stay continuous.
  cases.push(() => {
    const catalog = paramsByFirmwareSymbol(dev.desc);
    let foundContinuous = false;
    for (const [symbol, schema] of catalog) {
      if (dev.overlay[symbol] !== undefined) continue;
      if (schema.wire_kind === 'continuous') {
        foundContinuous = true;
        break;
      }
    }
    assert(
      foundContinuous,
      `${dev.label}: no continuous param survived the overlay (over-reclassification?)`,
    );
  });
}

export const DISCRETE_OVERLAY_CASE_COUNT = cases.length;

export function runDiscreteOverlayTests(): void {
  for (const c of cases) c();
}
