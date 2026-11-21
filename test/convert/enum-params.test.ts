/**
 * Enum params through the converter.
 *
 * - Lossless (same-vocabulary gen-3) lift carries `kind: 'enum'`, the ordinal span and the label
 *   list, so an editor renders a selector instead of a 0..65534 knob.
 * - The mapped path writes the exact ordinal: a gen-3 target's `normalized` is `ordinal / 65534`
 *   (what `valueToRaw` turns back into the ordinal), not the position within `0..N-1`.
 * - A block's TYPE / MODEL selector never travels as a param (it would overwrite the lineage-matched
 *   type with an ordinal from the source's roster); the type comes from typeName / typeValue.
 *
 * Synthetic input only: a hand-built FM3 body with one delay block, and hand-built IR presets.
 */
import { liftGen3Preset } from '../../src/convert/adapters/gen3.js';
import { convertPreset } from '../../src/convert/engine.js';
import { conceptKeyForLocal } from '../../src/convert/conceptLookup.js';
import { resolveEnumCountByParamId, resolveEnumOptionsByParamId, targetParamId } from '../../src/convert/targetRanges.js';
import type { ConverterBlock, ConverterFamily, ConverterParam, ConverterPreset } from '../../src/convert/ir.js';
import { FM3_BODY_LAYOUT, valueToRaw } from '../../src/devices/gen3/blockParams.js';
import { FM3_ENUM_OVERRIDES } from '../../src/gen3/fm3/index.js';

export const ENUM_PARAMS_CASE_COUNT = 8;

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

/** 3. Mapped path to a gen-3 target writes the exact ordinal for enum params. */
function caseMappedOrdinals(): void {
  // delay tempo (79 notes) and amp bright (2): the enum params that map between AM4 and gen-3.
  const cases: Array<{ family: ConverterFamily; name: string; value: number; count: number }> = [
    { family: 'delay', name: 'tempo', value: 1, count: 79 },
    { family: 'delay', name: 'tempo', value: 5, count: 79 },
    { family: 'delay', name: 'tempo', value: 78, count: 79 },
    { family: 'amp', name: 'bright', value: 1, count: 2 },
  ];
  for (const { family, name, value, count } of cases) {
    const { target } = convertPreset(synthPreset('am4', family, name, value), 'fm3');
    const p = target.blocks.find((b) => b.family === family)?.params.find((q) => q.nativeName === name);
    assert(p !== undefined && p.kind === 'enum', `am4->fm3 ${family}.${name}: kind ${p?.kind}`);
    assert(p!.value === value, `am4->fm3 ${family}.${name}: value ${p!.value} != ${value}`);
    assert(p!.min === 0 && p!.max === count - 1, `am4->fm3 ${family}.${name}: span ${p!.min}..${p!.max}`);
    assert(p!.normalized === value / WIRE_MAX, `am4->fm3 ${family}.${name}: normalized ${p!.normalized} (want ordinal / 65534)`);
    assert(valueToRaw(p!) === value, `am4->fm3 ${family}.${name}: valueToRaw ${valueToRaw(p!)} != ${value}`);
    assert(p!.displayValue === p!.enumOptions?.[value], `am4->fm3 ${family}.${name}: displayValue ${p!.displayValue} is not its option label`);
  }
}

/** 4. Ordinals are integers inside 0..N-1: a fractional source value rounds, an out-of-range one clamps; both are reported. */
function caseOrdinalRoundingAndClamp(): void {
  const clampEvents = (r: ReturnType<typeof convertPreset>) => r.events.filter((e) => e.kind === 'param-clamped');
  const tempo = (value: number) => convertPreset(synthPreset('am4', 'delay', 'tempo', value), 'fm3');

  const rounded = tempo(2.4);
  assert(paramByName(rounded.target, 'tempo').value === 2, 'fractional ordinal 2.4 must round to 2');
  const roundEvent = clampEvents(rounded)[0];
  assert(
    roundEvent !== undefined && roundEvent.kind === 'param-clamped' && roundEvent.sourceValue === 2.4 && roundEvent.targetValue === 2,
    `rounding 2.4 to 2 must be reported against the unrounded source value, got ${JSON.stringify(roundEvent)}`,
  );
  assert(clampEvents(tempo(2)).length === 0, 'an exact integer ordinal needs no event');

  const clamped = tempo(99);
  const p = paramByName(clamped.target, 'tempo');
  assert(p.value === 78 && valueToRaw(p) === 78, `out-of-range ordinal must clamp to the last option, got ${p.value}`);
  assert(clampEvents(clamped).length === 1, 'clamping an out-of-range ordinal must be reported once');

  // A continuous param is unaffected: kind float, no rounding, linear position as before.
  const mix = paramByName(convertPreset(synthPreset('am4', 'delay', 'mix', 37.5), 'fm3').target, 'mix');
  assert(mix.kind === 'float' && mix.value === 37.5 && mix.normalized === 0.375, `delay mix: ${JSON.stringify(mix)}`);
}

/** 5. A non-gen-3 target keeps its own convention: kind + labels, `normalized` = position in 0..N-1. */
function caseAm4Target(): void {
  const { target } = convertPreset(synthPreset('fm3', 'delay', 'tempo', 5), 'am4');
  const tempo = paramByName(target, 'tempo');
  assert(tempo.kind === 'enum', `fm3->am4 delay tempo: kind ${tempo.kind}`);
  assert(tempo.value === 5, `fm3->am4 delay tempo: ordinal ${tempo.value}`);
  assert(tempo.enumOptions !== undefined && tempo.enumOptions.length === (tempo.max ?? -2) + 1, 'fm3->am4 delay tempo: options match the 0..N-1 span');
  assert(tempo.normalized === 5 / tempo.max!, `fm3->am4 delay tempo: normalized ${tempo.normalized} (AM4 keeps position in range)`);
}

/** 6. The block type selector is never a param; the lineage-matched typeValue survives. */
function caseTypeSelectorsDropped(): void {
  const families: ConverterFamily[] = ['amp', 'drive', 'reverb', 'delay', 'chorus', 'flanger', 'phaser', 'tremolo', 'wah', 'filter', 'compressor', 'gate', 'geq'];
  let checked = 0;
  for (const family of families) {
    const { target } = convertPreset(synthPreset('am4', family, 'type', 1), 'fm3');
    const block = target.blocks.find((b) => b.family === family);
    if (block === undefined) continue; // family absent on this target
    assert(
      !block.params.some((q) => q.nativeName === 'type' || q.nativeName === 'model'),
      `am4->fm3 ${family}: the type selector leaked through as a param: ${JSON.stringify(block.params)}`,
    );
    checked += 1;
  }
  assert(checked >= 8, `only ${checked} families reached the target`);

  // AM4 "delay type" is the delay MODEL; FM3's DELAY_TYPE (7) is the routing config and DELAY_MODEL
  // (6) is the model selector. Neither may be written from an AM4 model ordinal.
  const delay = convertPreset(synthPreset('am4', 'delay', 'type', 2), 'fm3').target.blocks.find((b) => b.family === 'delay')!;
  assert(!delay.params.some((q) => q.paramId === 6 || q.paramId === 7), `am4->fm3 delay type reached FM3 ${JSON.stringify(delay.params)}`);

  // The type itself still comes from the lineage match, and a type param next to it changes nothing.
  const withType = synthPreset('am4', 'delay', 'type', 2);
  withType.blocks[0]!.typeName = 'Digital Mono';
  const withoutType = synthPreset('am4', 'delay', 'tempo', 5);
  withoutType.blocks[0]!.typeName = 'Digital Mono';
  const a = convertPreset(withType, 'fm3').target.blocks.find((b) => b.family === 'delay')!;
  const b = convertPreset(withoutType, 'fm3').target.blocks.find((x) => x.family === 'delay')!;
  assert(a.typeName !== undefined && a.typeValue !== undefined, `lineage-matched type missing: ${a.typeName}/${a.typeValue}`);
  assert(a.typeName === b.typeName && a.typeValue === b.typeValue, 'a type param must not change the lineage-matched type');

  // And the other direction: FM3's routing config (DELAY_TYPE) has no AM4 column, so it is dropped, not mapped onto the AM4 model.
  const back = convertPreset(synthPreset('fm3', 'delay', 'type', 2), 'am4');
  assert(!back.target.blocks.find((x) => x.family === 'delay')!.params.some((q) => q.nativeName === 'type'), 'fm3 delay config must not become the AM4 delay model');
  assert(back.events.some((e) => e.kind === 'param-dropped' && e.nativeName === 'type'), 'dropping the routing config must be reported');
}

/** 7. Lossless re-address: the target's span and labels replace the source's, an ordinal beyond the span clamps. */
function caseLosslessReaddress(): void {
  const labels79 = Array.from({ length: 79 }, (_, i) => `src ${i}`);
  const tempoPreset = (value: number): ConverterPreset => ({
    sourceDevice: 'fm9',
    name: 'synthetic',
    sceneNames: ['A'],
    sceneCount: 1,
    blocks: [
      {
        key: 'delay1',
        family: 'delay',
        instance: 1,
        params: [
          {
            paramId: 19,
            nativeName: 'tempo',
            conceptKey: 'delay.tempo',
            kind: 'enum',
            value,
            min: 0,
            max: 200,
            normalized: value / WIRE_MAX,
            displayValue: `src ${value}`,
            enumOptions: labels79,
          },
        ],
        liftedFrom: 'full-decode',
      },
    ],
    routing: { seriesChains: [['delay1']] },
    decodeDepth: 'full',
  });

  const inSpan = convertPreset(tempoPreset(5), 'fm3');
  const t = paramByName(inSpan.target, 'tempo');
  assert(t.paramId === targetParamId('fm3', 'delay', 'delay.tempo'), `fm9->fm3 tempo: paramId ${t.paramId}`);
  assert(t.min === 0 && t.max === 78, `fm9->fm3 tempo: span ${t.min}..${t.max} (the target's 79 notes)`);
  assert(t.enumOptions !== undefined && t.enumOptions.join('|') !== labels79.join('|'), 'fm9->fm3 tempo: source labels must be replaced by the target\'s');
  assert(t.displayValue === t.enumOptions![5], `fm9->fm3 tempo: displayValue ${t.displayValue}`);
  assert(!inSpan.events.some((e) => e.kind === 'param-clamped'), 'an in-span ordinal needs no event');

  const beyond = convertPreset(tempoPreset(100), 'fm3');
  const c = paramByName(beyond.target, 'tempo');
  assert(c.value === 78 && c.normalized === 78 / WIRE_MAX && valueToRaw(c) === 78, `fm9->fm3 tempo 100: clamped to ${c.value}`);
  const ev = beyond.events.find((e) => e.kind === 'param-clamped');
  assert(
    ev !== undefined && ev.kind === 'param-clamped' && ev.sourceValue === 100 && ev.targetValue === 78 && ev.targetMax === 78,
    `an ordinal beyond the target span must be reported, got ${JSON.stringify(ev)}`,
  );

  // The count of an enum is available without its labels (what bounds the span when no clean list exists).
  const id = targetParamId('fm3', 'delay', 'delay.tempo')!;
  assert(resolveEnumCountByParamId('fm3', 'delay', id) === resolveEnumOptionsByParamId('fm3', 'delay', id)?.length, 'enum count by paramId matches the option count');
  assert(resolveEnumCountByParamId('fm3', 'delay', 8) === undefined, 'a continuous param (delay time) has no enum count');
}

/** 8. Delay routing config maps between the Axe-Fx II (CONFIG) and gen-3 (DELAY_TYPE): ordinals 0..6 line up. */
function caseDelayConfigAcrossGenerations(): void {
  const toGen3 = convertPreset(synthPreset('axe-fx-ii', 'delay', 'config', 2), 'fm3');
  const type = paramByName(toGen3.target, 'type');
  assert(type.paramId === DELAY_TYPE_ID && type.kind === 'enum', `ii->fm3 delay config: ${JSON.stringify(type)}`);
  assert(type.value === 2 && valueToRaw(type) === 2, `ii->fm3 delay config: ordinal ${type.value} / raw ${valueToRaw(type)}`);
  assert(type.displayValue === DELAY_TYPE_LABELS[2], `ii->fm3 delay config: displayValue ${type.displayValue}`);

  const toGen2 = convertPreset(synthPreset('fm3', 'delay', 'type', 2), 'axe-fx-ii');
  const config = paramByName(toGen2.target, 'config');
  assert(config.value === 2, `fm3->ii delay config: ordinal ${config.value}`);
  assert(!toGen2.events.some((e) => e.kind === 'param-dropped' && e.nativeName === 'type'), 'fm3->ii delay config must not be dropped');
}

export function runEnumParamsTests(): void {
  caseLosslessLift();
  caseLosslessCrossDevice();
  caseMappedOrdinals();
  caseOrdinalRoundingAndClamp();
  caseAm4Target();
  caseTypeSelectorsDropped();
  caseLosslessReaddress();
  caseDelayConfigAcrossGenerations();
}
