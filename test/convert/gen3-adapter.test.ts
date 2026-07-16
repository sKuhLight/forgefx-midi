/**
 * gen-3 → IR adapter goldens.
 *
 * Re-decodes the real FM3 / Axe-Fx III / FM9 preset-dump fixtures (shared with
 * the block-param suites) and lifts each into the IR, asserting structural
 * invariants: block/grid counts, valid families, concept-key annotation on
 * known amp params, series-chain column ordering + key consistency, and
 * scene-name carry-through.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGen3PresetDump } from '../../src/devices/gen3/presetBody.js';
import { liftGen3Preset } from '../../src/convert/adapters/gen3.js';
import { convertPreset } from '../../src/convert/engine.js';
import { isConverterFamily, type Gen3DeviceId } from '../../src/convert/families.js';
import type { ConverterBlock, ConverterGridPosition } from '../../src/convert/ir.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN3_ROOT = join(HERE, '..', 'gen3');

interface Fixture {
  path: string;
  device: Gen3DeviceId;
  modelByte: number;
  label: string;
}

function collectFixtures(): Fixture[] {
  const out: Fixture[] = [];
  const fm3Dir = join(GEN3_ROOT, 'fm3', 'fixtures');
  for (const f of readdirSync(fm3Dir)) {
    const m = /^preset-(\d+)\.syx$/.exec(f);
    if (m) out.push({ path: join(fm3Dir, f), device: 'fm3', modelByte: 0x11, label: `fm3/${f}` });
  }
  const iiiGift = join(GEN3_ROOT, 'axe-fx-iii', 'fixtures', 'devs-gift-of-tone.syx');
  out.push({ path: iiiGift, device: 'axe-fx-iii', modelByte: 0x10, label: 'axe-fx-iii/devs-gift-of-tone' });
  const fm9Gift = join(GEN3_ROOT, 'fm9', 'fixtures', 'devs-gift-of-tone.syx');
  out.push({ path: fm9Gift, device: 'fm9', modelByte: 0x12, label: 'fm9/devs-gift-of-tone' });
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const FIXTURES = collectFixtures();
export const GEN3_ADAPTER_CASE_COUNT = FIXTURES.length;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[convert/gen3-adapter] ${msg}`);
}

function isGridPos(p: ConverterBlock['position']): p is ConverterGridPosition {
  return p !== undefined && 'col' in p;
}

export function runGen3AdapterTests(): void {
  assert(FIXTURES.length > 0, 'no gen-3 fixtures found');

  for (const fx of FIXTURES) {
    const bytes = new Uint8Array(readFileSync(fx.path));
    const decoded = decodeGen3PresetDump(bytes, fx.modelByte);
    assert(decoded.crc_valid, `${fx.label}: fixture CRC invalid`);
    const ir = liftGen3Preset(decoded, fx.device);

    // Depth + identity.
    assert(ir.decodeDepth === 'full', `${fx.label}: expected full decodeDepth`);
    assert(ir.sourceDevice === fx.device, `${fx.label}: sourceDevice`);
    assert(ir.blocks.length > 0, `${fx.label}: no blocks lifted`);
    assert((ir.routing.gridCells?.length ?? 0) > 0, `${fx.label}: no grid cells`);

    // Scenes carried (gen-3 = 8).
    assert(ir.sceneCount === 8, `${fx.label}: sceneCount ${ir.sceneCount} != 8`);
    assert(
      Array.isArray(ir.sceneNames) && ir.sceneNames!.length === 8,
      `${fx.label}: expected 8 scene names`,
    );

    // Every block has a valid family + a unique key; keys are family+instance.
    const keys = new Set<string>();
    for (const b of ir.blocks) {
      assert(isConverterFamily(b.family), `${fx.label}: bad family ${b.family}`);
      assert(!keys.has(b.key), `${fx.label}: duplicate block key ${b.key}`);
      keys.add(b.key);
      assert(b.key === `${b.family}${b.instance}`, `${fx.label}: key/instance mismatch ${b.key}`);
    }

    // Series chains reference only real block keys, and run left→right by
    // grid column (shunts are dropped, so column order is non-decreasing).
    const colOf = new Map<string, number>();
    for (const b of ir.blocks) if (isGridPos(b.position)) colOf.set(b.key, b.position.col);
    assert(ir.routing.seriesChains.length > 0, `${fx.label}: no series chains`);
    for (const chain of ir.routing.seriesChains) {
      let prevCol = -1;
      for (const key of chain) {
        assert(keys.has(key), `${fx.label}: chain references unknown key ${key}`);
        const col = colOf.get(key);
        if (col !== undefined) {
          assert(col >= prevCol, `${fx.label}: chain column order regressed at ${key}`);
          prevCol = col;
        }
      }
    }

    // Shunts never appear as blocks, but do appear in grid cells.
    for (const b of ir.blocks) assert(b.family !== ('shunt' as never), `${fx.label}: shunt lifted as block`);
  }

  // Specific golden: FM3 "Supertweed" (preset-42) — amp params carry concept
  // keys, and the amp channel/scene state is present.
  const supertweed = FIXTURES.find((f) => f.label === 'fm3/preset-42.syx');
  assert(supertweed !== undefined, 'fm3/preset-42.syx fixture missing');
  const st = liftGen3Preset(decodeGen3PresetDump(new Uint8Array(readFileSync(supertweed!.path)), 0x11), 'fm3');
  assert(st.name === 'Supertweed', `preset-42 name ${st.name}`);
  const amp = st.blocks.find((b) => b.family === 'amp');
  assert(amp !== undefined, 'preset-42 has no amp block');
  assert(amp!.typeName !== undefined, 'preset-42 amp has no type name');
  const gain = amp!.params.find((p) => p.nativeName === 'drive');
  assert(gain?.conceptKey === 'amp.preamp_gain', `preset-42 amp gain conceptKey ${gain?.conceptKey}`);
  const bass = amp!.params.find((p) => p.nativeName === 'bass');
  assert(bass?.conceptKey === 'amp.bass', `preset-42 amp bass conceptKey ${bass?.conceptKey}`);
  assert((amp!.channels?.count ?? 0) >= 1, 'preset-42 amp has no channel state');
  assert(Array.isArray(amp!.bypassPerScene) && amp!.bypassPerScene!.length === 8, 'preset-42 amp bypass-per-scene');

  // Full-fidelity param carry (paramId + normalized), across NON-AMP blocks too
  // — the fix that lets same-generation authoring write param VALUES, not just
  // structure. Assert every lifted param on a non-amp calibrated block carries a
  // finite paramId and a 0..1 `normalized`, and that the amp does as well.
  const nonAmp = st.blocks.filter((b) => b.family !== 'amp' && b.params.length > 0);
  assert(nonAmp.length >= 2, `preset-42 expected >=2 non-amp blocks with params, got ${nonAmp.length}`);
  for (const b of [amp!, ...nonAmp]) {
    for (const p of b.params) {
      assert(Number.isInteger(p.paramId), `preset-42 ${b.key} param ${p.nativeName} missing integer paramId`);
      assert(
        typeof p.normalized === 'number' && p.normalized! >= 0 && p.normalized! <= 1,
        `preset-42 ${b.key} param ${p.nativeName} normalized out of 0..1 (${p.normalized})`,
      );
    }
  }
  // A concrete non-amp block carries real params (e.g. reverb time / delay).
  const reverb = st.blocks.find((b) => b.family === 'reverb');
  assert(reverb !== undefined && reverb.params.length > 0, 'preset-42 reverb block has no params');

  // Same-generation convert (fm3 → fm3) preserves paramId + normalized VERBATIM
  // (shared roster / vocabulary → lossless pass-through). This is the invariant
  // the FM3 authoring encoder relies on to write params by id.
  const { target, events } = convertPreset(st, 'fm3');
  assert(
    !events.some((e) => e.kind === 'param-dropped' || e.kind === 'param-clamped'),
    'preset-42 fm3->fm3 must not drop/clamp params (lossless same-generation pass-through)',
  );
  for (const sb of st.blocks) {
    const tb = target.blocks.find((b) => b.key === sb.key);
    if (!tb) continue;
    assert(tb.params.length === sb.params.length, `fm3->fm3 ${sb.key} param count changed`);
    for (let i = 0; i < sb.params.length; i++) {
      assert(tb.params[i].paramId === sb.params[i].paramId, `fm3->fm3 ${sb.key} param ${i} paramId changed`);
      assert(tb.params[i].normalized === sb.params[i].normalized, `fm3->fm3 ${sb.key} param ${i} normalized changed`);
    }
  }
}
