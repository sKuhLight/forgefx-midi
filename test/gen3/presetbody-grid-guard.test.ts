/**
 * W5.3 red/green — the gen-3 body grid guard must be grid-SHAPE aware.
 *
 * `decodeGen3Body` gated the grid decode on the hardcoded FM3 table end
 * `0x1c4 = 452 = 0x104 + 4*12*2*2`. A III/FM9 (6×14) body needs
 * `0x104 + 6*14*4 = 596`, so a 452..595-byte body passed the guard and
 * silently decoded an empty/truncated grid instead of declining.
 */
import {
  decodeGen3Body,
  MODEL_FM3,
  MODEL_FM9,
} from '../../src/devices/gen3/presetBody.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`grid-guard: ${msg}`);
}

export const GRID_GUARD_CASE_COUNT = 3;

export function runGridGuardTests(): void {
  // Below the FM3 4×12 table end (452) → no grid.
  const fm3Short = decodeGen3Body(new Uint8Array(451), MODEL_FM3);
  assert(fm3Short.grid === undefined, 'a 451-byte FM3 body is below the 4x12 grid table end (452)');

  // At the FM3 table end → the grid decodes (empty table, but defined).
  const fm3Ok = decodeGen3Body(new Uint8Array(452), MODEL_FM3);
  assert(Array.isArray(fm3Ok.grid), 'a 452-byte FM3 body must decode the 4x12 grid table');

  // Below the FM9 6×14 table end (596) → no grid (was silently decoded empty).
  const fm9Short = decodeGen3Body(new Uint8Array(500), MODEL_FM9);
  assert(
    fm9Short.grid === undefined,
    'a 500-byte FM9 body is below the 6x14 grid table end (596); must NOT decode a truncated grid',
  );
}
