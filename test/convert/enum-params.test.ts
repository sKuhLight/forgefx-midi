/**
 * Enum params through the converter.
 *
 * - Lossless (same-vocabulary gen-3) lift carries `kind: 'enum'`, the ordinal span and the label
 *   list, so an editor renders a selector instead of a 0..65534 knob.
 *
 * Synthetic input only: a hand-built FM3 body with one delay block, and hand-built IR presets.
 */
import { liftGen3Preset } from '../../src/convert/adapters/gen3.js';
import { convertPreset } from '../../src/convert/engine.js';
import { conceptKeyForLocal } from '../../src/convert/conceptLookup.js';
import { targetParamId } from '../../src/convert/targetRanges.js';
import type { ConverterBlock, ConverterFamily, ConverterParam, ConverterPreset } from '../../src/convert/ir.js';
import { FM3_BODY_LAYOUT, valueToRaw } from '../../src/devices/gen3/blockParams.js';
import { FM3_ENUM_OVERRIDES } from '../../src/gen3/fm3/index.js';

export const ENUM_PARAMS_CASE_COUNT = 3;

const WIRE_MAX = 65534;
const FM3_DELAY_EID = 70; // 'Delay 1' in the shared gen-3 effect id space
const DELAY_TYPE_ID = 7; // FM3 DELAY_TYPE: 8-entry enum
const DELAY_TIME_ID = 8; // FM3 DELAY_TIME: continuous
/** The device's own label list for DELAY_TYPE (what the body decoder labels with). */
const DELAY_TYPE_LABELS: readonly string[] = FM3_ENUM_OVERRIDES.DELAY!['7']!;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[convert/enum-params] ${msg}`);
}

/** A synthetic FM3 body holding one delay block header + the given raw u16 params. */
function synthFm3DelayBody(raw: Readonly<Record<number, number>>): Uint8Array {
  const header = FM3_BODY_LAYOUT.paramRegionFloor + 16;
  const body = new Uint8Array(header + FM3_BODY_LAYOUT.paramArrayBase + 2 * 200);
  body[header] = FM3_DELAY_EID & 0xff;
  body[header + 1] = FM3_DELAY_EID >> 8; // the following 8 bytes stay zero: the block header signature
  for (const [pid, value] of Object.entries(raw)) {
    const off = header + FM3_BODY_LAYOUT.paramArrayBase + 2 * Number(pid);
    body[off] = value & 0xff;
    body[off + 1] = (value >> 8) & 0xff;
  }
  return body;
}

function liftFm3Delay(raw: Readonly<Record<number, number>>): ConverterPreset {
  return liftGen3Preset(
    {
      grid: [{ effect_id: FM3_DELAY_EID, row: 0, col: 0, route_flag: 0, name: 'Delay 1' }],
      blocks: [],
      decompressed_body: synthFm3DelayBody(raw),
    },
    'fm3',
  );
}

function paramByName(preset: ConverterPreset, nativeName: string): ConverterParam {
  const p = preset.blocks.find((b) => b.family === 'delay')?.params.find((q) => q.nativeName === nativeName);
  assert(p !== undefined, `delay param ${nativeName} missing`);
  return p!;
}

/** A one-block IR preset from `sourceDevice` with a single param. */
function synthPreset(
  sourceDevice: ConverterPreset['sourceDevice'],
  family: ConverterFamily,
  nativeName: string,
  value: number,
): ConverterPreset {
  const block: ConverterBlock = {
    key: `${family}1`,
    family,
    instance: 1,
    params: [{ nativeName, conceptKey: conceptKeyForLocal(sourceDevice, family, nativeName), value, displayValue: String(value) }],
    liftedFrom: 'full-decode',
  };
  return {
    sourceDevice,
    name: 'synthetic',
    sceneNames: ['A', 'B', 'C', 'D'],
    sceneCount: 4,
    blocks: [block],
    routing: { seriesChains: [[block.key]] },
    decodeDepth: 'partial',
  };
}

/** 1. Same-vocabulary lift: enum params carry kind, span and labels; floats stay plain. */
function caseLosslessLift(): void {
  const src = liftFm3Delay({ [DELAY_TYPE_ID]: 2, [DELAY_TIME_ID]: 30000 });

  const type = paramByName(src, 'type');
  assert(type.kind === 'enum', `lifted delay type: kind ${type.kind}`);
  assert(type.value === 2, `lifted delay type: value ${type.value}`);
  assert(type.min === 0 && type.max === 7, `lifted delay type: span ${type.min}..${type.max} (want 0..7)`);
  assert(
    type.enumOptions?.length === 8 && type.enumOptions.every((l, i) => l === DELAY_TYPE_LABELS[i]),
    `lifted delay type: options ${JSON.stringify(type.enumOptions)}`,
  );
  assert(type.displayValue === DELAY_TYPE_LABELS[2], `lifted delay type: displayValue ${type.displayValue}`);
  assert(type.normalized === 2 / WIRE_MAX, `lifted delay type: normalized ${type.normalized}`);
  assert(valueToRaw(type) === 2, `lifted delay type: valueToRaw ${valueToRaw(type)} != 2`);

  const time = paramByName(src, 'time');
  assert(time.kind === 'float', `lifted delay time: kind ${time.kind}`);
  assert(time.enumOptions === undefined && time.min === undefined, 'lifted float must not carry an enum span or options');
  assert(time.normalized === 30000 / WIRE_MAX, `lifted delay time: normalized ${time.normalized}`);
}

/** 2. Cross-device lossless (FM3 → FM9): the enum keeps its ordinal, gets the TARGET's id and labels. */
function caseLosslessCrossDevice(): void {
  const src = liftFm3Delay({ [DELAY_TYPE_ID]: 2 });
  const { target } = convertPreset(src, 'fm9');
  const type = paramByName(target, 'type');
  assert(type.kind === 'enum', `fm3->fm9 delay type: kind ${type.kind}`);
  const wantId = targetParamId('fm9', 'delay', type.conceptKey);
  assert(wantId !== null && type.paramId === wantId, `fm3->fm9 delay type: paramId ${type.paramId} != fm9 id ${wantId}`);
  assert(type.value === 2 && type.normalized === 2 / WIRE_MAX, `fm3->fm9 delay type: ordinal changed (${type.value}, ${type.normalized})`);
  assert(type.enumOptions !== undefined && type.enumOptions.length >= 3, 'fm3->fm9 delay type: target enum options missing');
  assert(type.min === 0 && type.max === type.enumOptions!.length - 1, `fm3->fm9 delay type: span ${type.min}..${type.max}`);
  assert(valueToRaw(type) === 2, `fm3->fm9 delay type: valueToRaw ${valueToRaw(type)} != 2`);
}

/** 3. A non-gen-3 target keeps its own convention: kind + labels, `normalized` = position in 0..N-1. */
function caseAm4Target(): void {
  const src = synthPreset('fm3', 'delay', 'type', 2);
  const { target } = convertPreset(src, 'am4');
  const type = paramByName(target, 'type');
  assert(type.kind === 'enum', `fm3->am4 delay type: kind ${type.kind}`);
  assert(type.value === 2, `fm3->am4 delay type: ordinal ${type.value}`);
  assert(type.enumOptions !== undefined && type.enumOptions.length === (type.max ?? -2) + 1, 'fm3->am4 delay type: options match the 0..N-1 span');
  assert(type.normalized === 2 / type.max!, `fm3->am4 delay type: normalized ${type.normalized} (AM4 keeps position in range)`);
}

export function runEnumParamsTests(): void {
  caseLosslessLift();
  caseLosslessCrossDevice();
  caseAm4Target();
}
