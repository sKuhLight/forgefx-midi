/**
 * Gen-3 roster projections — goldens frozen from the pre-migration ForgeFX
 * server's live-validated helpers (fixtures/roster.expected.json): the palette
 * roster, the eid → {slug, instance} sweep 0..200, and per-family instance
 * counts. Byte-exact parity gates the server's switch to these package
 * implementations (migration Phase 4).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectRoster, blockRefForEid, slugForEffectId, blockInstances } from '../../../src/devices/gen3/roster.js';
import { listBlockTypes, swapBlockType } from '../../../src/devices/gen3/presetAuthor.js';
import {
  decodeGen3PresetDump,
  MODEL_AXE_FX_III,
  MODEL_FM3,
  MODEL_FM9,
} from '../../../src/devices/gen3/presetBody.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface RosterFixture {
  roster: { slug: string; name: string; page: number }[];
  refByEid: Record<string, { slug: string; instance: number } | null>;
  slugByEid: Record<string, string | null>;
  instances: Record<string, number>;
}

export const FM3_ROSTER_CASE_COUNT = 6;

export function runGen3RosterTests(): void {
  const exp = JSON.parse(readFileSync(join(FIXTURES, 'roster.expected.json'), 'utf8')) as RosterFixture;
  const fail = (msg: string): never => { throw new Error(`[gen3/roster] ${msg}`); };

  const roster = effectRoster();
  if (JSON.stringify(roster) !== JSON.stringify(exp.roster)) {
    const got = JSON.stringify(roster).slice(0, 200);
    fail(`effectRoster() diverged from server golden: ${got}…`);
  }

  for (let eid = 0; eid <= 200; eid++) {
    const got = JSON.stringify(blockRefForEid(eid) ?? null);
    const want = JSON.stringify(exp.refByEid[String(eid)] ?? null);
    if (got !== want) fail(`blockRefForEid(${eid}) = ${got}, server golden ${want}`);
    const gotSlug = slugForEffectId(eid) ?? null;
    const wantSlug = exp.slugByEid[String(eid)] ?? null;
    if (gotSlug !== wantSlug) fail(`slugForEffectId(${eid}) = ${gotSlug}, server golden ${wantSlug}`);
  }

  for (const [slug, count] of Object.entries(exp.instances)) {
    if (blockInstances(slug) !== count) fail(`blockInstances('${slug}') = ${blockInstances(slug)}, server golden ${count}`);
  }

  if (blockInstances('nonexistent') !== 4) fail('blockInstances default must be 4');

  const fm3 = listBlockTypes('Amp');
  const axe3 = listBlockTypes('Amp', MODEL_AXE_FX_III);
  const fm9 = listBlockTypes('Amp', MODEL_FM9);
  for (const [name, types, count] of [
    ['FM3', fm3, 331],
    ['Axe-Fx III', axe3, 336],
    ['FM9', fm9, 336],
  ] as const) {
    if (types.length !== count || types.some((type, i) => type.id !== i || !type.name)) {
      fail(name + ' must have a complete amp roster in ordinal order');
    }
  }
  if (fm3[173]?.name !== 'FAS Brootalz' || fm3[283]?.name !== 'Deluxe Tweed'
    || axe3[283]?.name !== 'Deluxe Tweed Bright' || axe3[335]?.name !== 'Brit JVM Crunch Red') {
    fail('amp roster is missing a previously unnamed or model-specific ordinal');
  }
  if (axe3.some((type, i) => type.name !== fm9[i]?.name)
    || fm3.some((type, i) => i !== 283 && type.name !== axe3[i]?.name)) {
    fail('amp roster labels diverged outside the documented model-specific ordinals');
  }

  // Verify the author and body decoder agree when a preset uses these ordinals.
  for (const [model, fixture, ordinal, name] of [
    [MODEL_FM3, 'preset-5.syx', 173, 'FAS Brootalz'],
    [MODEL_AXE_FX_III, '../../axe-fx-iii/fixtures/devs-gift-of-tone.syx', 283, 'Deluxe Tweed Bright'],
    [MODEL_FM9, '../../fm9/fixtures/devs-gift-of-tone.syx', 335, 'Brit JVM Crunch Red'],
  ] as const) {
    const original = new Uint8Array(readFileSync(join(FIXTURES, fixture)));
    const swap = swapBlockType(original, 'Amp', name);
    const decoded = decodeGen3PresetDump(swap.syx, model);
    const amp = decoded.blocks?.find((block) => block.block === 'Amp');
    if (swap.typeId !== ordinal || !decoded.crc_valid
      || amp?.channels?.A?.type_id !== ordinal || amp.channels.A.type !== name) {
      fail('amp type did not round-trip on model ' + model + ' at ordinal ' + ordinal);
    }
  }
}
