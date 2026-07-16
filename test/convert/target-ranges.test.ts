/**
 * Target param-catalog fidelity (offline convert editor).
 *
 * Asserts the P2 engine now attaches REAL display ranges (and, where clean,
 * ordered enum options) to mapped params — the metadata the offline convert
 * editor needs to render true knobs + dropdowns instead of coarse/empty ones.
 * Covers the two resolver entry points directly AND one end-to-end conversion.
 */

import {
  resolveTargetRange,
  resolveTargetEnumOptions,
} from '../../src/convert/targetRanges.js';
import { convertPreset } from '../../src/convert/engine.js';
import type { ConverterPreset } from '../../src/convert/ir.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`target-ranges: ${msg}`);
}

export const TARGET_RANGES_CASE_COUNT = 14;

export function runTargetRangesTests(): void {
  // ── gen-3 ranges: broadened beyond amp knobs to the device-true tables ──
  const drive = resolveTargetRange('fm3', 'amp', 'drive');
  assert(drive?.min === 0 && drive.max === 10, `fm3 amp drive expected 0..10, got ${JSON.stringify(drive)}`);

  const hicut = resolveTargetRange('fm3', 'amp', 'hicut');
  assert(hicut?.min === 200 && hicut.max === 20000, `fm3 amp hicut expected 200..20000, got ${JSON.stringify(hicut)}`);
  assert(hicut?.unit === 'Hz', `fm3 amp hicut expected unit Hz, got ${hicut?.unit}`);

  // A non-amp family now carries a real range (previously → undefined).
  const cabLevel = resolveTargetRange('fm3', 'cab', 'level');
  assert(cabLevel?.min === -80 && cabLevel.max === 20, `fm3 cab level expected -80..20, got ${JSON.stringify(cabLevel)}`);

  // III device-true table, distinct from FM3 (paramIds differ across models).
  const feed = resolveTargetRange('axe-fx-iii', 'delay', 'feed');
  assert(feed !== undefined && feed.min < feed.max, `iii delay feed expected a real range, got ${JSON.stringify(feed)}`);

  // ── AM4 ranges (KNOWN_PARAMS) still resolve, now with unit/log where present ──
  const am4Bass = resolveTargetRange('am4', 'amp', 'bass');
  assert(am4Bass?.min === 0 && am4Bass.max === 10, `am4 amp bass expected 0..10, got ${JSON.stringify(am4Bass)}`);

  // ── Honest coverage: no invented ranges where there is no data ──
  assert(
    resolveTargetRange('vp4', 'reverb', 'mix') === undefined,
    'vp4 has no device-true range table and no inferred pair → must stay undefined',
  );
  assert(
    resolveTargetRange('axe-fx-ii', 'amp', 'bass') === undefined,
    'gen-2 has no range coverage → must stay undefined (param-unverified)',
  );

  // ── Enum options ──
  // AM4: dense enumValues → ordered option labels.
  const am4AmpType = resolveTargetEnumOptions('am4', 'amp', 'type');
  assert(
    Array.isArray(am4AmpType) && am4AmpType.length === 250,
    `am4 amp type expected 250 options, got ${am4AmpType?.length}`,
  );
  assert(am4AmpType?.[0] === '1959SLP Normal', `am4 amp type[0] expected '1959SLP Normal', got ${am4AmpType?.[0]}`);

  // gen-3: device-true enum row + dense overlay labels → ordered options.
  const inputSel = resolveTargetEnumOptions('fm3', 'amp', 'inputselect');
  assert(
    Array.isArray(inputSel) && inputSel.length === 3 && inputSel[0] === 'L+R',
    `fm3 amp inputselect expected 3 options starting L+R, got ${JSON.stringify(inputSel)}`,
  );

  // A continuous (float) param yields no enum options.
  assert(
    resolveTargetEnumOptions('fm3', 'amp', 'drive') === undefined,
    'fm3 amp drive is float → no enum options',
  );

  // ── End-to-end: a converted (non-lossless) param carries the range ──
  const src: ConverterPreset = {
    sourceDevice: 'am4',
    name: 'probe',
    sceneCount: 4,
    blocks: [
      {
        key: 'amp1',
        family: 'amp',
        instance: 1,
        typeName: undefined,
        params: [
          { nativeName: 'bass', conceptKey: 'amp.bass', value: 7, displayValue: '7' },
        ],
      },
    ],
    routing: { seriesChains: [] },
    decodeDepth: 'full',
  };
  const { target } = convertPreset(src, 'fm3');
  const ampBlock = target.blocks.find((b) => b.family === 'amp');
  const bassParam = ampBlock?.params.find((p) => p.nativeName === 'bass');
  assert(bassParam !== undefined, 'am4->fm3: mapped amp bass param missing');
  assert(
    bassParam!.min === 0 && bassParam!.max === 10,
    `am4->fm3: bass param expected min/max 0..10, got ${JSON.stringify({ min: bassParam!.min, max: bassParam!.max })}`,
  );
  assert(
    typeof bassParam!.normalized === 'number',
    'am4->fm3: bass param expected a normalized value',
  );
}
