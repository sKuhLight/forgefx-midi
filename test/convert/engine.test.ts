/**
 * P2 conversion-engine goldens.
 *
 * Exercises `convertPreset()` against real gen-3 preset-dump fixtures (lifted
 * via the reference adapter) plus synthetic IR built to isolate a single
 * pipeline stage. Each case asserts both the shape of the target IR and the
 * emitted event log.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGen3PresetDump } from '../../src/devices/gen3/presetBody.js';
import { liftGen3Preset } from '../../src/convert/adapters/gen3.js';
import { convertPreset } from '../../src/convert/engine.js';
import { severityOf, type ConversionEvent } from '../../src/convert/events.js';
import { conceptKeyForLocal } from '../../src/convert/conceptLookup.js';
import type {
  ConverterPreset,
  ConverterBlock,
  ConverterGridPosition,
  ConverterSlotPosition,
} from '../../src/convert/ir.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN3_ROOT = join(HERE, '..', 'gen3');

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[convert/engine] ${msg}`);
}

function isGrid(p: ConverterBlock['position']): p is ConverterGridPosition {
  return p !== undefined && 'row' in p;
}
function isSlot(p: ConverterBlock['position']): p is ConverterSlotPosition {
  return p !== undefined && 'slot' in p;
}

function tally(events: readonly ConversionEvent[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const e of events) m[e.kind] = (m[e.kind] ?? 0) + 1;
  return m;
}
function lossCount(events: readonly ConversionEvent[]): number {
  return events.filter((e) => severityOf(e) === 'loss').length;
}

function liftFixture(rel: string, device: 'fm3' | 'axe-fx-iii' | 'fm9', modelByte: number): ConverterPreset {
  const bytes = new Uint8Array(readFileSync(join(GEN3_ROOT, rel)));
  return liftGen3Preset(decodeGen3PresetDump(bytes, modelByte), device);
}

/** Longest source series chain (ties → first), filtered to a survivor set. */
function longestChain(preset: ConverterPreset): string[] {
  return [...preset.routing.seriesChains].sort((a, b) => b.length - a.length)[0] ?? [];
}

// ── Synthetic IR builders ─────────────────────────────────────────────

let synthUid = 0;
function ampBlockAm4(): ConverterBlock {
  const names = ['gain', 'bass', 'mid', 'treble', 'master', 'level'];
  return {
    key: 'amp1',
    family: 'amp',
    instance: 1,
    typeName: 'USA MK IIC+',
    params: names.map((n) => ({
      nativeName: n,
      conceptKey: conceptKeyForLocal('am4', 'amp', n),
      value: 5,
      displayValue: '5',
    })),
    liftedFrom: 'full-decode',
  };
}

/** A synthetic gen-3-shaped preset with the given families, one instance each. */
function synthGen3(families: Array<{ family: ConverterBlock['family']; key: string; type?: string }>): ConverterPreset {
  synthUid += 1;
  const blocks: ConverterBlock[] = families.map((f, i) => ({
    key: f.key,
    family: f.family,
    instance: 1,
    typeName: f.type,
    params: [],
    position: { row: 0, col: i },
    liftedFrom: 'full-decode',
  }));
  return {
    sourceDevice: 'axe-fx-iii',
    name: `synth-${synthUid}`,
    sceneNames: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'],
    sceneCount: 8,
    blocks,
    routing: {
      gridCells: blocks.map((b) => ({
        row: 0,
        col: (b.position as ConverterGridPosition).col,
        name: b.key,
        blockKey: b.key,
        isShunt: false,
      })),
      seriesChains: [blocks.map((b) => b.key)],
    },
    decodeDepth: 'full',
  };
}

// ── Cases ──────────────────────────────────────────────────────────────

export interface EngineCaseResult {
  label: string;
  line: string;
}
const RESULTS: EngineCaseResult[] = [];

/** 1. iii → fm3 downsize: grid re-placed, series order preserved, no loss. */
function caseIiiToFm3(): void {
  const src = liftFixture('axe-fx-iii/fixtures/devs-gift-of-tone.syx', 'axe-fx-iii', 0x10);
  const { target, events } = convertPreset(src, 'fm3');

  assert(tally(events)['block-dropped'] === undefined, 'iii->fm3: unexpected block-dropped (all families present)');
  assert(target.blocks.length === src.blocks.length, `iii->fm3: block count ${target.blocks.length} != ${src.blocks.length}`);
  assert(lossCount(events) === 0, `iii->fm3: expected 0 loss events, got ${lossCount(events)}`);

  // Shared gen-3 roster: types transfer VERBATIM — zero type events.
  assert(tally(events)['type-substituted'] === undefined, 'iii->fm3: type-substituted on shared-roster pair');
  assert(tally(events)['type-unresolved'] === undefined, 'iii->fm3: type-unresolved on shared-roster pair');
  for (const sb of src.blocks) {
    const tb = target.blocks.find((b) => b.key === sb.key)!;
    assert(tb.typeName === sb.typeName, `iii->fm3: ${sb.key} typeName changed (${sb.typeName} -> ${tb.typeName})`);
    assert(tb.typeValue === sb.typeValue, `iii->fm3: ${sb.key} typeValue changed`);
  }

  // Every placed block sits within the fm3 4x12 grid.
  for (const b of target.blocks) {
    assert(isGrid(b.position), `iii->fm3: block ${b.key} not grid-placed`);
    const p = b.position as ConverterGridPosition;
    assert(p.row >= 0 && p.row < 4 && p.col >= 0 && p.col < 12, `iii->fm3: ${b.key} out of 4x12 at ${p.row},${p.col}`);
  }

  // The main (longest) source chain is preserved verbatim as a target chain.
  const main = longestChain(src);
  const preserved = target.routing.seriesChains.some(
    (ch) => ch.length === main.length && ch.every((k, i) => k === main[i]),
  );
  assert(preserved, `iii->fm3: main chain order not preserved (${main.join('>')})`);
  assert(tally(events)['routing-simplified'] === 1, 'iii->fm3: expected one routing-simplified event');

  RESULTS.push({
    label: 'iii->fm3',
    line: `${src.blocks.length} in, ${target.blocks.length} placed, events=${JSON.stringify(tally(events))}, loss=0`,
  });
}

/** 2. fm3 → iii upsize: lossless — verbatim types AND params, zero events. */
function caseFm3ToIii(): void {
  const src = liftFixture('fm3/fixtures/preset-42.syx', 'fm3', 0x11);
  const { target, events } = convertPreset(src, 'axe-fx-iii');

  assert(lossCount(events) === 0, `fm3->iii: expected 0 loss events, got ${lossCount(events)}`);
  assert(target.blocks.length === src.blocks.length, 'fm3->iii: block count changed on upsize');

  // Shared gen-3 roster: types transfer VERBATIM — zero type events.
  assert(tally(events)['type-substituted'] === undefined, 'fm3->iii: type-substituted on shared-roster pair');
  assert(tally(events)['type-unresolved'] === undefined, 'fm3->iii: type-unresolved on shared-roster pair');

  // Same-vocabulary conversion → types + params pass through verbatim.
  const srcAmp = src.blocks.find((b) => b.family === 'amp')!;
  const tgtAmp = target.blocks.find((b) => b.family === 'amp')!;
  assert(tgtAmp.typeName === srcAmp.typeName, `fm3->iii: amp typeName changed (${srcAmp.typeName} -> ${tgtAmp.typeName})`);
  assert(tgtAmp.typeValue === srcAmp.typeValue, 'fm3->iii: amp typeValue changed');
  assert(
    JSON.stringify(tgtAmp.params) === JSON.stringify(srcAmp.params),
    'fm3->iii: amp params were not passed through unchanged',
  );

  // Upsize keeps original grid positions.
  assert((target.routing.gridCells?.length ?? 0) > 0, 'fm3->iii: expected grid cells preserved');

  RESULTS.push({
    label: 'fm3->iii',
    line: `${src.blocks.length} in, ${target.blocks.length} placed, events=${JSON.stringify(tally(events))}, loss=0, types verbatim`,
  });
}

/** 3. gen3 → am4: amp lineage, family drops, scene 8→4, instancing. */
function caseGen3ToAm4(): void {
  const src = liftFixture('fm3/fixtures/preset-42.syx', 'fm3', 0x11);
  const { target, events } = convertPreset(src, 'am4');

  // amp maps with confidence better than fallback.
  const ampSub = events.find((e) => e.kind === 'type-substituted' && e.family === 'amp');
  assert(ampSub !== undefined && ampSub.kind === 'type-substituted', 'gen3->am4: no amp type-substituted event');
  if (ampSub && ampSub.kind === 'type-substituted') {
    assert(ampSub.confidence !== 'fallback', `gen3->am4: amp resolved only via fallback`);
  }
  // scene collapse 8 -> 4.
  const sc = events.find((e) => e.kind === 'scene-collapsed');
  assert(sc !== undefined && sc.kind === 'scene-collapsed' && sc.sourceScenes === 8 && sc.targetScenes === 4, 'gen3->am4: scene 8->4 not collapsed');
  assert(target.sceneCount === 4, `gen3->am4: target sceneCount ${target.sceneCount} != 4`);
  // families am4 lacks are dropped.
  assert(tally(events)['block-dropped'] !== undefined, 'gen3->am4: expected family-missing drops');

  // Instancing: a second delay instance is dropped with instance-limit.
  const inst = synthGen3([
    { family: 'amp', key: 'amp1', type: 'USA MK IIC+' },
    { family: 'delay', key: 'delay1', type: 'Digital Mono' },
    { family: 'delay', key: 'delay2', type: 'Digital Stereo' },
  ]);
  const { target: it, events: ie } = convertPreset(inst, 'am4');
  const instDrop = ie.find((e) => e.kind === 'block-dropped' && e.blockKey === 'delay2');
  assert(
    instDrop !== undefined && instDrop.kind === 'block-dropped' && instDrop.reason === 'instance-limit',
    'gen3->am4: duplicate delay not dropped with instance-limit',
  );
  assert(it.blocks.some((b) => b.key === 'delay1'), 'gen3->am4: first delay instance not kept');
  assert(!it.blocks.some((b) => b.key === 'delay2'), 'gen3->am4: second delay instance survived');

  RESULTS.push({
    label: 'gen3->am4',
    line: `${src.blocks.length} in, ${target.blocks.length} placed, events=${JSON.stringify(tally(events))}; instancing: delay2 dropped=${instDrop?.kind === 'block-dropped' ? instDrop.reason : '?'}`,
  });
}

/** 4. gen3 → vp4: amp family-missing, chain(4) priority selection, pitch survives. */
function caseGen3ToVp4(): void {
  const src = synthGen3([
    { family: 'amp', key: 'amp1', type: 'USA MK IIC+' },
    { family: 'drive', key: 'drive1', type: 'TS808' },
    { family: 'delay', key: 'delay1', type: 'Digital Mono' },
    { family: 'reverb', key: 'reverb1', type: 'Large Hall' },
    { family: 'pitch', key: 'pitch1', type: 'Whammy' },
    { family: 'chorus', key: 'chorus1', type: 'Chorus' },
    { family: 'phaser', key: 'phaser1', type: 'Phaser' },
  ]);
  const { target, events } = convertPreset(src, 'vp4');

  // amp has no home on the VP4.
  const ampDrop = events.find((e) => e.kind === 'block-dropped' && e.blockKey === 'amp1');
  assert(ampDrop !== undefined && ampDrop.kind === 'block-dropped' && ampDrop.reason === 'family-missing', 'gen3->vp4: amp not dropped family-missing');
  // chain(4) capacity: exactly 4 blocks placed, chosen by priority.
  assert(target.blocks.length === 4, `gen3->vp4: expected 4 placed, got ${target.blocks.length}`);
  assert(target.blocks.some((b) => b.family === 'pitch'), 'gen3->vp4: pitch did not survive');
  // The two lowest-priority (chorus, phaser) overflow capacity.
  const capDrops = events.filter((e) => e.kind === 'block-dropped' && e.reason === 'capacity-exceeded').map((e) => (e.kind === 'block-dropped' ? e.blockKey : ''));
  assert(capDrops.includes('chorus1') && capDrops.includes('phaser1'), `gen3->vp4: expected chorus1+phaser1 capacity drops, got ${capDrops.join(',')}`);
  // All placed on the 4-slot chain.
  for (const b of target.blocks) assert(isSlot(b.position), `gen3->vp4: ${b.key} not slot-placed`);

  RESULTS.push({
    label: 'gen3->vp4',
    line: `${src.blocks.length} in, ${target.blocks.length} placed (chain 4), amp dropped=family-missing, cap-dropped=${capDrops.join('+')}, events=${JSON.stringify(tally(events))}`,
  });
}

/** 5. am4(partial) → fm3: source-partial caveat; amp converts with params. */
function caseAm4ToFm3(): void {
  const src: ConverterPreset = {
    sourceDevice: 'am4',
    name: 'am4-partial',
    sceneNames: ['A', 'B', 'C', 'D'],
    sceneCount: 4,
    blocks: [ampBlockAm4()],
    routing: { seriesChains: [['amp1']] },
    decodeDepth: 'partial',
    meta: { notes: ['amp-only'] },
  };
  const { target, events } = convertPreset(src, 'fm3');

  const partial = events.find((e) => e.kind === 'source-partial');
  assert(partial !== undefined && partial.kind === 'source-partial' && partial.decodeDepth === 'partial', 'am4->fm3: no source-partial event');
  const amp = target.blocks.find((b) => b.family === 'amp');
  assert(amp !== undefined, 'am4->fm3: amp block missing');
  assert((amp!.params.length ?? 0) > 0, 'am4->fm3: amp lost all params');
  // Cross-vocabulary: params were remapped to gen-3 native names (e.g. gain→drive).
  assert(amp!.params.some((p) => p.nativeName === 'drive'), 'am4->fm3: amp gain not remapped to gen-3 "drive"');
  assert(amp!.params.every((p) => p.value >= 0 && p.value <= 10), 'am4->fm3: amp knob out of gen-3 0..10 range');

  RESULTS.push({
    label: 'am4->fm3',
    line: `1 in, ${target.blocks.length} placed, params=${amp!.params.length}, events=${JSON.stringify(tally(events))}`,
  });
}

/** 6. Determinism: identical input twice → deep-equal result. */
function caseDeterminism(): void {
  const src = liftFixture('axe-fx-iii/fixtures/devs-gift-of-tone.syx', 'axe-fx-iii', 0x10);
  const a = convertPreset(src, 'am4');
  const b = convertPreset(src, 'am4');
  assert(JSON.stringify(a) === JSON.stringify(b), 'determinism: two conversions differ');
  RESULTS.push({ label: 'determinism', line: 'iii->am4 x2 deep-equal OK' });
}

/** 7. Event integrity: every source block is placed OR in exactly one block-loss event. */
function caseEventIntegrity(): void {
  const src = liftFixture('axe-fx-iii/fixtures/devs-gift-of-tone.syx', 'axe-fx-iii', 0x10);
  const { target, events } = convertPreset(src, 'am4');

  const placed = new Set(target.blocks.map((b) => b.key));
  const lossByKey = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'block-dropped' || e.kind === 'block-unplaced') {
      lossByKey.set(e.blockKey, (lossByKey.get(e.blockKey) ?? 0) + 1);
    }
  }
  for (const b of src.blocks) {
    const isPlaced = placed.has(b.key);
    const lossN = lossByKey.get(b.key) ?? 0;
    assert(
      (isPlaced && lossN === 0) || (!isPlaced && lossN === 1),
      `event-integrity: block ${b.key} placed=${isPlaced} lossEvents=${lossN}`,
    );
  }
  // Every loss event key is a real source block.
  const srcKeys = new Set(src.blocks.map((b) => b.key));
  for (const k of lossByKey.keys()) assert(srcKeys.has(k), `event-integrity: loss event for unknown key ${k}`);

  RESULTS.push({ label: 'event-integrity', line: `${src.blocks.length} source blocks all traceable (placed or single loss event)` });
}

/**
 * 8. Shared-roster roster-miss: on a same-roster pair the verbatim pass-through
 * yields to matchModel when the target's roster verifiably LACKS the model.
 * The FM3/FM9 generated rosters carry no III-only model today (checked against
 * the shipped read rosters), so the absent model is synthetic — the mechanism
 * under test (modelOnDevice='absent' → matchModel path) is the same.
 */
function caseSharedRosterMiss(): void {
  const src = synthGen3([
    { family: 'amp', key: 'amp1', type: 'Totally Fictional Prototype 9000' },
    { family: 'delay', key: 'delay1', type: 'Digital Mono' },
  ]);
  const { target, events } = convertPreset(src, 'fm3');

  // The absent amp model went through matchModel (a type event, not verbatim).
  const ampEvents = events.filter(
    (e) => (e.kind === 'type-substituted' || e.kind === 'type-unresolved') && e.blockKey === 'amp1',
  );
  assert(ampEvents.length === 1, `roster-miss: expected 1 amp type event, got ${ampEvents.length}`);
  const ampEv = ampEvents[0];
  if (ampEv.kind === 'type-substituted') {
    assert(ampEv.confidence !== 'exact', 'roster-miss: absent model cannot match exact');
    const tgtAmp = target.blocks.find((b) => b.key === 'amp1')!;
    assert(tgtAmp.typeName !== 'Totally Fictional Prototype 9000', 'roster-miss: absent model kept verbatim');
  }
  // The present delay model still passes through verbatim with zero events.
  const delayEvents = events.filter(
    (e) => (e.kind === 'type-substituted' || e.kind === 'type-unresolved') && e.blockKey === 'delay1',
  );
  assert(delayEvents.length === 0, 'roster-miss: present model emitted type events');
  const tgtDelay = target.blocks.find((b) => b.key === 'delay1')!;
  assert(tgtDelay.typeName === 'Digital Mono', 'roster-miss: present model typeName changed');

  RESULTS.push({
    label: 'shared-roster-miss',
    line: `absent amp -> ${ampEv.kind}${ampEv.kind === 'type-substituted' ? `(${ampEv.confidence})` : ''}, present delay verbatim, events=${JSON.stringify(tally(events))}`,
  });
}

export const ENGINE_CASE_COUNT = 8;

export function runEngineTests(): void {
  RESULTS.length = 0;
  caseIiiToFm3();
  caseFm3ToIii();
  caseGen3ToAm4();
  caseGen3ToVp4();
  caseAm4ToFm3();
  caseDeterminism();
  caseEventIntegrity();
  caseSharedRosterMiss();
  assert(RESULTS.length === ENGINE_CASE_COUNT, `engine: expected ${ENGINE_CASE_COUNT} cases, ran ${RESULTS.length}`);
  if (process.env.CONVERT_ENGINE_VERBOSE) {
    for (const r of RESULTS) console.log(`  [engine] ${r.label}: ${r.line}`);
  }
}
