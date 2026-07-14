/**
 * Converter family-taxonomy goldens.
 *
 * Asserts (1) every device block-table entry resolves to a family (no
 * unmapped natives — the taxonomy is derived from the source tables, so a
 * miss means a new block spelling with no alias), (2) family presence sets
 * match a dozen known cross-device facts, and (3) device topologies are what
 * the converter expects.
 */
import {
  CONVERTER_FAMILIES,
  CONVERTER_DEVICE_IDS,
  UNMAPPED_NATIVES,
  deviceNativeFamilies,
  familyPresence,
  deviceTopology,
  isConverterFamily,
  resolveFamily,
  type ConverterDeviceId,
  type ConverterFamily,
} from '../../src/convert/families.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[convert/families] ${msg}`);
}

const has = (d: ConverterDeviceId, f: ConverterFamily): boolean => familyPresence(d).has(f);

/** Known cross-device facts (spot checks). Each returns true when it holds. */
const FACTS: ReadonlyArray<readonly [string, () => boolean]> = [
  // amp is on every real amp-modeler; NOT on the VP4 pedalboard.
  ['amp on axe-fx-iii', () => has('axe-fx-iii', 'amp')],
  ['amp on fm9', () => has('fm9', 'amp')],
  ['amp on fm3', () => has('fm3', 'amp')],
  ['amp on am4', () => has('am4', 'amp')],
  ['amp on axe-fx-ii', () => has('axe-fx-ii', 'amp')],
  ['amp on axe-fx-gen1', () => has('axe-fx-gen1', 'amp')],
  ['amp NOT on vp4', () => !has('vp4', 'amp')],
  // pitch IS on the VP4.
  ['pitch on vp4', () => has('vp4', 'pitch')],
  ['pitch on axe-fx-iii', () => has('axe-fx-iii', 'pitch')],
  // cab: on the modelers with a cab block; the AM4 has an integrated cab (no
  // standalone cab family), the VP4 has none.
  ['cab on axe-fx-iii', () => has('axe-fx-iii', 'cab')],
  ['cab on axe-fx-ii', () => has('axe-fx-ii', 'cab')],
  ['cab NOT on am4', () => !has('am4', 'cab')],
  ['cab NOT on vp4', () => !has('vp4', 'cab')],
  // III-only blocks are absent on FM9/FM3.
  ['tonematch on axe-fx-iii', () => has('axe-fx-iii', 'tonematch')],
  ['tonematch NOT on fm9', () => !has('fm9', 'tonematch')],
  ['tonematch NOT on fm3', () => !has('fm3', 'tonematch')],
  ['vocoder III-only (not fm3)', () => has('axe-fx-iii', 'vocoder') && !has('fm3', 'vocoder')],
  ['irplayer III-only (not fm9)', () => has('axe-fx-iii', 'irplayer') && !has('fm9', 'irplayer')],
  // Crossover is III + FM9 but not FM3.
  ['crossover on fm9', () => has('fm9', 'crossover')],
  ['crossover NOT on fm3', () => !has('fm3', 'crossover')],
  // Modern gen-3 additions are III-only.
  ['nam III-only', () => has('axe-fx-iii', 'nam') && !has('fm3', 'nam')],
  // Shared effects everywhere (incl. VP4).
  ['drive on vp4', () => has('vp4', 'drive')],
  ['reverb on vp4', () => has('vp4', 'reverb')],
  ['looper on vp4', () => has('vp4', 'looper')],
  ['delay on axe-fx-gen1', () => has('axe-fx-gen1', 'delay')],
  // Multiband compressor family present on the III.
  ['multicomp on axe-fx-iii', () => has('axe-fx-iii', 'multicomp')],
  // Routing primitives.
  ['shunt on fm3', () => has('fm3', 'shunt')],
  ['send on axe-fx-iii', () => has('axe-fx-iii', 'send')],
  // Normalization / alias resolution across naming conventions.
  ['resolveFamily("Graphic EQ 1")=geq', () => resolveFamily('Graphic EQ 1') === 'geq'],
  ['resolveFamily("Vol/Pan 2")=volpan', () => resolveFamily('Vol/Pan 2') === 'volpan'],
  ['resolveFamily("vol_pan")=volpan', () => resolveFamily('vol_pan') === 'volpan'],
  ['resolveFamily("Ten-Tap Delay")=tentap', () => resolveFamily('Ten-Tap Delay') === 'tentap'],
  ['resolveFamily("FX Loop")=fxloop', () => resolveFamily('FX Loop') === 'fxloop'],
  ['resolveFamily("Multi Delay 1")=multitap', () => resolveFamily('Multi Delay 1') === 'multitap'],
  ['resolveFamily("Rotary Speaker 1")=rotary', () => resolveFamily('Rotary Speaker 1') === 'rotary'],
];

/** Spot-check assertions + one per real block table (no unmapped natives). */
export const FAMILIES_CASE_COUNT = FACTS.length + 4;

export function runFamiliesTests(): void {
  // 1. No unmapped natives — the whole taxonomy must derive cleanly.
  assert(
    UNMAPPED_NATIVES.length === 0,
    `unmapped device natives: ${JSON.stringify(UNMAPPED_NATIVES)}`,
  );

  // 2. Every device's every block-table entry maps to a valid family.
  for (const device of CONVERTER_DEVICE_IDS) {
    for (const e of deviceNativeFamilies(device)) {
      assert(
        e.family !== undefined && isConverterFamily(e.family),
        `${device} native "${e.native}" did not map to a known family (got ${String(e.family)})`,
      );
    }
  }

  // 3. Family vocabulary is unique and every presence entry is a member.
  assert(
    new Set(CONVERTER_FAMILIES).size === CONVERTER_FAMILIES.length,
    'CONVERTER_FAMILIES has duplicate entries',
  );
  for (const device of CONVERTER_DEVICE_IDS) {
    for (const f of familyPresence(device)) {
      assert(isConverterFamily(f), `${device} presence has non-family ${f}`);
    }
  }

  // 4. Topologies are what the converter expects.
  const iii = deviceTopology('axe-fx-iii');
  assert(iii.kind === 'grid' && iii.rows === 6 && iii.cols === 14, 'axe-fx-iii topology');
  const fm3 = deviceTopology('fm3');
  assert(fm3.kind === 'grid' && fm3.rows === 4 && fm3.cols === 12, 'fm3 topology');
  const am4 = deviceTopology('am4');
  assert(am4.kind === 'slots' && am4.instancing === 'single-per-family', 'am4 topology');
  const vp4 = deviceTopology('vp4');
  assert(vp4.kind === 'chain' && vp4.slots === 4, 'vp4 topology');

  // 5. Known cross-device facts.
  for (const [desc, fn] of FACTS) {
    assert(fn(), `fact failed: ${desc}`);
  }
}
