/**
 * Concept-key coverage + correctness goldens.
 *
 * The load-bearing gate: EVERY device-local param name in the concept-key
 * registry must actually exist in that device's real param table. The verifier
 * below is built directly against the source tables (gen-3 PARAMS_BY_FAMILY,
 * gen-2 KNOWN_PARAMS, AM4 PARAM_NAMES + generated names) — so a typo or a
 * renamed param fails the build. Also checks that fm3/fm9/vp4 resolve onto the
 * shared gen-3 vocabulary column, and that resolveConceptKey round-trips.
 */
import {
  CONCEPT_KEYS,
  resolveConceptKey,
  listConceptKeysForDevice,
} from '../../src/core/protocol-generic/concept-keys.js';
import { PARAMS_BY_FAMILY } from '../../src/gen3/axe-fx-iii/params.js';
import { KNOWN_PARAMS as GEN2_KNOWN_PARAMS } from '../../src/gen2/axe-fx-ii/params.js';
import { KNOWN_PARAMS as AM4_KNOWN_PARAMS } from '../../src/am4/params.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[convert/concept-coverage] ${msg}`);
}

// ── Converter block/family → per-device block key ────────────────────
// The concept-key block portion is the converter block slug. Each device
// spells that block differently; these mirror the dispatcher's block aliases.

/** block → gen-3 catalog FAMILY (amp = DISTORT, drive-pedal = FUZZ, …). */
const GEN3_FAMILY: Readonly<Record<string, string>> = {
  amp: 'DISTORT',
  cab: 'CABINET',
  drive: 'FUZZ',
  compressor: 'COMP',
  gate: 'GATE',
  delay: 'DELAY',
  reverb: 'REVERB',
  chorus: 'CHORUS',
  flanger: 'FLANGER',
  phaser: 'PHASER',
  rotary: 'ROTARY',
  tremolo: 'TREMOLO',
  wah: 'WAH',
  pitch: 'PITCH',
  filter: 'FILTER',
  volpan: 'VOLUME',
  enhancer: 'ENHANCER',
  geq: 'GEQ',
  peq: 'PEQ',
};

/** block → Axe-Fx II KNOWN_PARAMS block slug. */
const GEN2_BLOCK: Readonly<Record<string, string>> = {
  amp: 'amp',
  cab: 'cab',
  drive: 'drive',
  compressor: 'compressor',
  gate: 'gateexpander',
  delay: 'delay',
  reverb: 'reverb',
  chorus: 'chorus',
  flanger: 'flanger',
  phaser: 'phaser',
  rotary: 'rotary',
  tremolo: 'pantrem',
  wah: 'wah',
  pitch: 'pitch',
  filter: 'filter',
  volpan: 'volpan',
  enhancer: 'enhancer',
  geq: 'graphiceq',
  peq: 'parametriceq',
};

/** block → AM4 PARAM_NAMES block key (cab/pitch have no AM4 block). */
const AM4_BLOCK: Readonly<Record<string, string>> = {
  amp: 'amp',
  drive: 'drive',
  compressor: 'compressor',
  gate: 'gate',
  delay: 'delay',
  reverb: 'reverb',
  chorus: 'chorus',
  flanger: 'flanger',
  phaser: 'phaser',
  rotary: 'rotary',
  tremolo: 'tremolo',
  wah: 'wah',
  filter: 'filter',
  volpan: 'volpan',
  enhancer: 'enhancer',
  geq: 'geq',
  peq: 'peq',
};

// ── Build the real-table lookups ─────────────────────────────────────

function stripFamily(family: string, name: string): string {
  const p = `${family}_`;
  return (name.startsWith(p) ? name.slice(p.length) : name).toLowerCase();
}

/** gen-3 FAMILY → set of stripped param keys. */
const GEN3_NAMES: Record<string, Set<string>> = {};
for (const [family, params] of Object.entries(PARAMS_BY_FAMILY)) {
  GEN3_NAMES[family] = new Set(params.map((p) => stripFamily(family, p.name)));
}

/** gen-2 block slug → set of param names (the describe_device / dispatcher set). */
const GEN2_NAMES: Record<string, Set<string>> = {};
for (const v of Object.values(GEN2_KNOWN_PARAMS) as Array<{ block: string; name: string }>) {
  (GEN2_NAMES[v.block] ??= new Set()).add(v.name);
}

/**
 * am4 block key → set of param names. Source is `KNOWN_PARAMS` (am4/params.ts) —
 * the authoritative table `buildBlocks()` iterates for the describe_device
 * schema, so the concept-key local names must match THESE spellings.
 */
const AM4_NAMES: Record<string, Set<string>> = {};
for (const v of Object.values(AM4_KNOWN_PARAMS) as Array<{ block: string; name: string }>) {
  (AM4_NAMES[v.block] ??= new Set()).add(v.name);
}

// Sample round-trip probes: (device, conceptKey) → expected local name.
const ROUND_TRIPS: ReadonlyArray<readonly [string, string, string]> = [
  ['axe-fx-iii', 'amp.preamp_gain', 'drive'],
  ['fm3', 'amp.preamp_gain', 'drive'],
  ['fm9', 'amp.bass', 'bass'],
  ['vp4', 'reverb.mix', 'mix'],
  ['am4', 'amp.bass', 'bass'],
  ['am4', 'drive.gain', 'drive'],
  ['axe-fx-ii', 'drive.output_level', 'volume'],
  ['axe-fx-ii', 'amp.mid', 'middle'],
  ['axe-fx-iii', 'delay.feedback', 'feed'],
  ['am4', 'wah.q', 'q_resonance'],
];

export const CONCEPT_COVERAGE_CASE_COUNT =
  Object.keys(CONCEPT_KEYS).length + ROUND_TRIPS.length + 8;

export function runConceptCoverageTests(): void {
  // 1. gen-3 floor units + VP4 resolve onto the shared III vocabulary column.
  for (const port of ['fm3', 'fm9', 'vp4', 'axe-fx-iii', 'am4', 'axe-fx-ii']) {
    assert(
      listConceptKeysForDevice(port).length > 0,
      `listConceptKeysForDevice("${port}") is empty`,
    );
  }
  // fm3/fm9/vp4 return exactly the axe-fx-iii column.
  const iiiList = JSON.stringify(listConceptKeysForDevice('axe-fx-iii'));
  for (const port of ['fm3', 'fm9', 'vp4']) {
    assert(
      JSON.stringify(listConceptKeysForDevice(port)) === iiiList,
      `listConceptKeysForDevice("${port}") differs from axe-fx-iii`,
    );
  }
  // Unknown port → empty list, undefined resolution.
  assert(listConceptKeysForDevice('nonesuch').length === 0, 'unknown port must list nothing');
  assert(
    resolveConceptKey('nonesuch', 'amp.bass') === undefined,
    'unknown port must not resolve',
  );

  // 2. THE GATE: every registry local name exists in the real device table.
  // Accumulate ALL misses so one run surfaces every problem.
  const errs: string[] = [];
  for (const [conceptKey, map] of Object.entries(CONCEPT_KEYS)) {
    const block = conceptKey.slice(0, conceptKey.indexOf('.'));
    const cols = map as Record<string, string | undefined>;

    if (cols['axe-fx-iii'] !== undefined) {
      const fam = GEN3_FAMILY[block];
      if (fam === undefined) errs.push(`${conceptKey}: no gen-3 family mapping for block "${block}"`);
      else if (!GEN3_NAMES[fam]?.has(cols['axe-fx-iii']))
        errs.push(`${conceptKey}: gen-3 "${cols['axe-fx-iii']}" not in family ${fam}`);
    }
    if (cols['axe-fx-ii'] !== undefined) {
      const b = GEN2_BLOCK[block];
      if (b === undefined) errs.push(`${conceptKey}: no gen-2 block mapping for "${block}"`);
      else if (!GEN2_NAMES[b]?.has(cols['axe-fx-ii']))
        errs.push(`${conceptKey}: gen-2 "${cols['axe-fx-ii']}" not in block ${b}`);
    }
    if (cols['am4'] !== undefined) {
      const b = AM4_BLOCK[block];
      if (b === undefined) errs.push(`${conceptKey}: no am4 block mapping for "${block}"`);
      else if (!AM4_NAMES[b]?.has(cols['am4']))
        errs.push(`${conceptKey}: am4 "${cols['am4']}" not in block ${b}`);
    }
    // hydrasynth column intentionally not verified (no in-repo param table).
  }
  assert(errs.length === 0, `unverified local names:\n  ${errs.join('\n  ')}`);

  // 3. resolveConceptKey round-trips across devices.
  for (const [device, key, expected] of ROUND_TRIPS) {
    const r = resolveConceptKey(device, key);
    assert(r !== undefined, `resolveConceptKey("${device}","${key}") returned undefined`);
    assert(
      r!.localName === expected,
      `resolveConceptKey("${device}","${key}").localName = "${r!.localName}", expected "${expected}"`,
    );
    assert(r!.block === key.slice(0, key.indexOf('.')), `${key}: block portion mismatch`);
  }

  // 4. A registry that grew well past the P0a baseline.
  assert(
    Object.keys(CONCEPT_KEYS).length >= 100,
    `expected >=100 concept keys, got ${Object.keys(CONCEPT_KEYS).length}`,
  );
}
