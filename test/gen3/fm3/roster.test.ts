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

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface RosterFixture {
  roster: { slug: string; name: string; page: number }[];
  refByEid: Record<string, { slug: string; instance: number } | null>;
  slugByEid: Record<string, string | null>;
  instances: Record<string, number>;
}

export const FM3_ROSTER_CASE_COUNT = 4;

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

  if (blockInstances('nonexistent') !== 4) fail(`blockInstances default must be 4`);
}
