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
import { targetParamId, targetParamIdByName } from '../../src/convert/targetRanges.js';
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

  // Same-vocabulary conversion → types pass through VERBATIM, and every param's
  // VALUE state (nativeName / value / normalized / conceptKey) is preserved 1:1
  // and in order. The one field that is re-addressed is `paramId`: it is a
  // device address, and gen-3 ids are device-specific, so a fm3→iii conversion
  // must carry the TARGET (III) id — NOT the fm3 id it was lifted with. Each
  // param's III id resolves CONCEPT-FIRST (`targetParamId`), then via the
  // NAME-JOIN fallback (`targetParamIdByName`) for params the concept registry
  // doesn't cover; params that resolve by neither carry no id (author skips them).
  const srcAmp = src.blocks.find((b) => b.family === 'amp')!;
  const tgtAmp = target.blocks.find((b) => b.family === 'amp')!;
  assert(tgtAmp.typeName === srcAmp.typeName, `fm3->iii: amp typeName changed (${srcAmp.typeName} -> ${tgtAmp.typeName})`);
  assert(tgtAmp.typeValue === srcAmp.typeValue, 'fm3->iii: amp typeValue changed');
  assert(tgtAmp.params.length === srcAmp.params.length, `fm3->iii: amp param count changed (${srcAmp.params.length} -> ${tgtAmp.params.length})`);
  let reAddressed = 0;
  let nameJoined = 0;
  for (let i = 0; i < srcAmp.params.length; i++) {
    const sp = srcAmp.params[i];
    const tp = tgtAmp.params[i];
    assert(tp.nativeName === sp.nativeName, `fm3->iii: amp param ${i} nativeName changed`);
    assert(tp.value === sp.value, `fm3->iii: amp param ${sp.nativeName} value changed`);
    assert(tp.normalized === sp.normalized, `fm3->iii: amp param ${sp.nativeName} normalized changed`);
    assert(tp.conceptKey === sp.conceptKey, `fm3->iii: amp param ${sp.nativeName} conceptKey changed`);
    const conceptId = targetParamId('axe-fx-iii', 'amp', sp.conceptKey);
    const wantId = conceptId ?? targetParamIdByName('axe-fx-iii', 'amp', sp.sharedName);
    assert(tp.paramId === (wantId ?? undefined), `fm3->iii: amp param ${sp.nativeName} paramId not re-addressed to III (want ${wantId}, got ${tp.paramId})`);
    if (wantId != null && wantId !== sp.paramId) reAddressed += 1;
    if (conceptId == null && wantId != null) nameJoined += 1;
  }
  // The amp carries concept knobs (drive/bass/mid/treble/master/...) whose III id
  // genuinely differs from the fm3 id, so the re-addressing must have changed some.
  assert(reAddressed > 0, 'fm3->iii: expected some amp paramIds re-addressed from fm3 to III ids');
  // The name-join fallback must have addressed amp params the concept registry
  // does not cover (the whole point of widening coverage).
  assert(nameJoined > 0, 'fm3->iii: expected some amp paramIds resolved via the name-join fallback');

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

  // Integrated cab: AM4's amp bundles the cab, so a source cab folds INTO the amp (block-merged),
  // it is NOT dropped as family-missing, and it is not a standalone block on the target.
  const withCab = synthGen3([
    { family: 'amp', key: 'amp1', type: 'USA MK IIC+' },
    { family: 'cab', key: 'cab1', type: '4x12 USA' },
    { family: 'drive', key: 'drive1', type: 'TS808' },
  ]);
  const { target: ct, events: ce } = convertPreset(withCab, 'am4');
  const merged = ce.find((e) => e.kind === 'block-merged' && e.blockKey === 'cab1');
  assert(merged !== undefined && merged.kind === 'block-merged' && merged.intoFamily === 'amp' && merged.intoBlockKey === 'amp1', 'gen3->am4: cab not merged into the amp block');
  assert(!ce.some((e) => e.kind === 'block-dropped' && e.blockKey === 'cab1'), 'gen3->am4: cab wrongly dropped instead of merged');
  assert(!ct.blocks.some((b) => b.key === 'cab1'), 'gen3->am4: cab left as a standalone block');
  assert(ct.blocks.some((b) => b.key === 'amp1'), 'gen3->am4: amp missing after cab merge');

  RESULTS.push({
    label: 'gen3->am4',
    line: `${src.blocks.length} in, ${target.blocks.length} candidates, events=${JSON.stringify(tally(events))}; instancing: delay2 dropped=${instDrop?.kind === 'block-dropped' ? instDrop.reason : '?'}`,
  });
}

/** 4. gen3 → vp4: amp family-missing; every convertible block is kept as an UNPLACED tray candidate
 *  (the user fills the 4-slot chain in the editor — no pre-emptive capacity drop). */
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
  // Every remaining convertible block is kept as a candidate — the user picks which fill the 4 slots.
  assert(target.blocks.length === 6, `gen3->vp4: expected 6 candidates, got ${target.blocks.length}`);
  assert(target.blocks.some((b) => b.family === 'pitch'), 'gen3->vp4: pitch did not survive');
  // Nothing is dropped for capacity — slot/chain targets are filled interactively, not pre-trimmed.
  const capDrops = events.filter((e) => e.kind === 'block-dropped' && e.reason === 'capacity-exceeded');
  assert(capDrops.length === 0, `gen3->vp4: unexpected capacity drops (${capDrops.length}) — slot targets are user-filled`);
  // Left UNPLACED for the tray (not auto-slot-placed).
  for (const b of target.blocks) assert(!isSlot(b.position), `gen3->vp4: ${b.key} should be an unplaced candidate, not slot-placed`);

  RESULTS.push({
    label: 'gen3->vp4',
    line: `${src.blocks.length} in, ${target.blocks.length} candidates (chain 4, user-filled), amp dropped=family-missing, capacity drops=0, events=${JSON.stringify(tally(events))}`,
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

/** 7. Event integrity: every source block has exactly ONE disposition — kept in target.blocks, folded
 *  into a host (block-merged), or removed via a single loss event (block-dropped/block-unplaced). */
function caseEventIntegrity(): void {
  const src = liftFixture('axe-fx-iii/fixtures/devs-gift-of-tone.syx', 'axe-fx-iii', 0x10);
  const { target, events } = convertPreset(src, 'am4');

  const placed = new Set(target.blocks.map((b) => b.key));
  const merged = new Set(events.filter((e) => e.kind === 'block-merged').map((e) => (e as { blockKey: string }).blockKey));
  const lossByKey = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'block-dropped' || e.kind === 'block-unplaced') {
      lossByKey.set(e.blockKey, (lossByKey.get(e.blockKey) ?? 0) + 1);
    }
  }
  for (const b of src.blocks) {
    const dispositions = (placed.has(b.key) ? 1 : 0) + (merged.has(b.key) ? 1 : 0) + (lossByKey.get(b.key) ?? 0);
    assert(
      dispositions === 1,
      `event-integrity: block ${b.key} placed=${placed.has(b.key)} merged=${merged.has(b.key)} lossEvents=${lossByKey.get(b.key) ?? 0}`,
    );
  }
  // Every loss/merge event key is a real source block.
  const srcKeys = new Set(src.blocks.map((b) => b.key));
  for (const k of lossByKey.keys()) assert(srcKeys.has(k), `event-integrity: loss event for unknown key ${k}`);
  for (const k of merged) assert(srcKeys.has(k), `event-integrity: merge event for unknown key ${k}`);

  RESULTS.push({ label: 'event-integrity', line: `${src.blocks.length} source blocks all traceable (placed / merged / single loss event)` });
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

/**
 * 9. Target-paramId resolver reproduces FM3 ids (requirement guard for the
 * FM3→FM3 no-regression invariant). For a REAL fm3 preset lift, every param the
 * lift annotated with a conceptKey must resolve — via the target-side resolver,
 * for the fm3 target — back to the EXACT paramId the lift decoded. This is why
 * the FM3→FM3 export stays byte-identical: the concept→fm3-paramId round-trip is
 * the identity on fm3.
 */
function caseResolverReproducesFm3Ids(): void {
  const src = liftFixture('fm3/fixtures/preset-42.syx', 'fm3', 0x11);
  let checked = 0;
  for (const b of src.blocks) {
    for (const p of b.params) {
      if (p.conceptKey === undefined) continue;
      const tid = targetParamId('fm3', b.family, p.conceptKey);
      assert(
        tid === p.paramId,
        `resolver-fm3: ${b.family}.${p.nativeName} (${p.conceptKey}) resolved to ${tid}, lifted paramId ${p.paramId}`,
      );
      checked += 1;
    }
  }
  assert(checked > 0, 'resolver-fm3: no concept-mapped fm3 params to check (fixture regressed?)');
  RESULTS.push({ label: 'resolver-fm3-ids', line: `${checked} concept params reproduce their fm3 paramId exactly` });
}

/**
 * 10. FM9→FM3 and III→FM3 carry FM3 paramIds (the core fix + the name-join
 * WIDENING). A non-fm3 gen-3 source used to pass its params through verbatim,
 * keeping the SOURCE device's paramId — a foreign address the fm3 author had to
 * refuse; only the ~few dozen CONCEPT-keyed knobs got a real fm3 id. Now every
 * param that carries an id carries the TARGET (fm3) id, resolved CONCEPT-FIRST
 * then via the CONTINUOUS NAME-JOIN fallback — lifting coverage from a few dozen
 * to hundreds, while enum/type/roster selectors still carry NO id (never a
 * foreign ordinal). Asserts the substantial jump + spot-checks continuous
 * non-concept params (EQ bands / mod depths) landed with fm3 ids.
 */
function caseCrossGen3ToFm3ParamIds(): void {
  const spotConcept: Array<{ family: ConverterBlock['family']; conceptKey: string }> = [
    { family: 'amp', conceptKey: 'amp.preamp_gain' },
    { family: 'amp', conceptKey: 'amp.power_amp_master' },
    { family: 'drive', conceptKey: 'drive.gain' },
    { family: 'reverb', conceptKey: 'reverb.mix' },
  ];
  // Continuous params NOT covered by any concept key — recovered ONLY by the
  // name-join. Each must land the fm3 id its shared symbol resolves to.
  const spotNameJoin: Array<{ family: ConverterBlock['family']; sharedName: string }> = [
    { family: 'amp', sharedName: 'DISTORT_EQ1' }, // amp graphic-EQ band
    { family: 'amp', sharedName: 'DISTORT_EQ5' },
    { family: 'peq', sharedName: 'PEQ_GAIN1' }, // parametric-EQ band gain
    { family: 'peq', sharedName: 'PEQ_FREQ1' },
    { family: 'delay', sharedName: 'DELAY_DEPTH1' }, // modulation depth
  ];

  for (const [rel, device, model] of [
    ['fm9/fixtures/devs-gift-of-tone.syx', 'fm9', 0x12],
    ['axe-fx-iii/fixtures/devs-gift-of-tone.syx', 'axe-fx-iii', 0x10],
  ] as const) {
    const src = liftFixture(rel, device, model);
    const { target } = convertPreset(src, 'fm3');

    // INVARIANT: any param that carries an id carries the fm3 id — from the concept
    // resolver OR the name-join, never the source device's id; a param that resolves
    // by NEITHER path carries no id (the fm3 author skips it, no foreign address).
    let withId = 0;
    let viaNameJoin = 0;
    let viaConcept = 0;
    const familiesWithId = new Set<string>();
    for (const b of target.blocks) {
      for (const p of b.params) {
        const conceptId = targetParamId('fm3', b.family, p.conceptKey);
        const nameId = targetParamIdByName('fm3', b.family, p.sharedName);
        const wantId = conceptId ?? nameId;
        if (p.paramId !== undefined) {
          assert(wantId !== null && p.paramId === wantId, `${device}->fm3: ${b.family}.${p.nativeName} paramId ${p.paramId} is not the fm3 id ${wantId}`);
          withId += 1;
          familiesWithId.add(b.family);
          if (conceptId != null) viaConcept += 1; else viaNameJoin += 1;
        } else {
          assert(wantId === null, `${device}->fm3: ${b.family}.${p.nativeName} dropped its id but fm3 resolves it (${wantId})`);
        }
      }
    }
    // The WIDENING: the name-join must lift coverage well past the old concept-only
    // count, across many families.
    assert(withId > 150, `${device}->fm3: expected >150 params to carry fm3 ids after name-join, got ${withId}`);
    assert(viaNameJoin > 100, `${device}->fm3: expected >100 params addressed via the name-join fallback, got ${viaNameJoin}`);
    assert(familiesWithId.size >= 5, `${device}->fm3: expected >=5 families with written ids, got ${familiesWithId.size}`);

    // Spot-check the named CONCEPT families resolve on the converted blocks.
    let conceptHits = 0;
    for (const { family, conceptKey } of spotConcept) {
      const blk = target.blocks.find((b) => b.family === family);
      if (!blk) continue;
      const wantId = targetParamId('fm3', family, conceptKey);
      if (wantId === null) continue;
      const p = blk.params.find((q) => q.conceptKey === conceptKey);
      if (p) {
        assert(p.paramId === wantId, `${device}->fm3: ${conceptKey} paramId ${p.paramId} != fm3 id ${wantId}`);
        conceptHits += 1;
      }
    }
    assert(conceptHits > 0, `${device}->fm3: no spot-check concept params landed`);

    // Spot-check the NAME-JOINED continuous params (EQ bands / mod depth) landed
    // the fm3 id their shared symbol resolves to — the coverage the fix adds.
    let nameJoinHits = 0;
    for (const { family, sharedName } of spotNameJoin) {
      const blk = target.blocks.find((b) => b.family === family);
      if (!blk) continue;
      const wantId = targetParamIdByName('fm3', family, sharedName);
      if (wantId === null) continue;
      const p = blk.params.find((q) => q.sharedName === sharedName);
      if (p) {
        assert(p.conceptKey === undefined, `${device}->fm3: ${sharedName} unexpectedly has a concept key (should be name-joined)`);
        assert(p.paramId === wantId, `${device}->fm3: name-joined ${sharedName} paramId ${p.paramId} != fm3 id ${wantId}`);
        nameJoinHits += 1;
      }
    }
    assert(nameJoinHits > 0, `${device}->fm3: no spot-check name-joined continuous params landed`);

    RESULTS.push({ label: `${device}->fm3-paramids`, line: `${withId} params carry fm3 ids (${viaConcept} concept + ${viaNameJoin} name-join) across ${familiesWithId.size} families; spot concept=${conceptHits}, name-join=${nameJoinHits}` });
  }
}

/**
 * 11. Name-join SAFETY: enum / type / roster selectors are NEVER name-joined
 * (their ordinals differ across devices), so a cross-gen-3→fm3 conversion must
 * leave them WITHOUT an id even though a raw full-name match exists on fm3. Also
 * proves FM3→FM3 is untouched by the whole re-addressing pass (byte-identity
 * guard): every param keeps its lifted fm3 id and value verbatim.
 */
function caseNameJoinSafetyAndFm3Identity(): void {
  // Direct resolver guards: enum + type/roster selectors on real fm3 families
  // resolve to null via the name-join, even though the symbol exists on fm3.
  const selectors = ['CABINET_TYPE1', 'DISTORT_BIASTYPE'];
  for (const s of selectors) {
    const fam: ConverterBlock['family'] = s.startsWith('CABINET') ? 'cab' : 'amp';
    assert(targetParamIdByName('fm3', fam, s) === null, `name-join safety: selector ${s} must not resolve (ordinals differ across devices)`);
  }
  // A continuous EQ band DOES resolve (positive control), proving the null above
  // is the selector gate, not a blanket miss.
  assert(targetParamIdByName('fm3', 'amp', 'DISTORT_EQ1') !== null, 'name-join: continuous DISTORT_EQ1 should resolve');
  // Unknown / cross-vocab (no shared name) → null.
  assert(targetParamIdByName('fm3', 'amp', undefined) === null, 'name-join: absent sharedName → null');
  assert(targetParamIdByName('am4', 'amp', 'DISTORT_DRIVE') === null, 'name-join: non-gen3 target → null');

  // FM3→FM3 IDENTITY: the source==target short-circuit means step 4b never runs,
  // so every param keeps its lifted fm3 paramId + value + normalized 1:1.
  const src = liftFixture('fm3/fixtures/preset-42.syx', 'fm3', 0x11);
  const { target } = convertPreset(src, 'fm3');
  let checked = 0;
  for (const sb of src.blocks) {
    const tb = target.blocks.find((b) => b.key === sb.key)!;
    assert(tb.params.length === sb.params.length, `fm3-identity: ${sb.key} param count changed`);
    for (let i = 0; i < sb.params.length; i++) {
      const sp = sb.params[i];
      const tp = tb.params[i];
      assert(tp.paramId === sp.paramId, `fm3-identity: ${sb.key}.${sp.nativeName} paramId changed (${sp.paramId} -> ${tp.paramId})`);
      assert(tp.value === sp.value, `fm3-identity: ${sb.key}.${sp.nativeName} value changed`);
      assert(tp.normalized === sp.normalized, `fm3-identity: ${sb.key}.${sp.nativeName} normalized changed`);
      checked += 1;
    }
  }
  assert(checked > 0, 'fm3-identity: no params checked (fixture regressed?)');
  RESULTS.push({ label: 'name-join-safety+fm3-identity', line: `${selectors.length} selectors refused, ${checked} fm3->fm3 params byte-identical` });
}

export const ENGINE_CASE_COUNT = 12;

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
  caseResolverReproducesFm3Ids();
  caseCrossGen3ToFm3ParamIds();
  caseNameJoinSafetyAndFm3Identity();
  assert(RESULTS.length === ENGINE_CASE_COUNT, `engine: expected ${ENGINE_CASE_COUNT} cases, ran ${RESULTS.length}`);
  if (process.env.CONVERT_ENGINE_VERBOSE) {
    for (const r of RESULTS) console.log(`  [engine] ${r.label}: ${r.line}`);
  }
}
