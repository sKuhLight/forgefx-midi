/**
 * gen-3 preset coherence validator goldens.
 *
 * A real FM3 preset fixture must validate ok; a truncated dump (framing
 * destroyed) and a CRC-corrupted dump (body no longer matches its stored CRC)
 * must both be refused with issues. This is the FILE-level gate that keeps the
 * converter from silently shipping a garbage .syx authored onto a bad base.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGen3Preset } from '../../src/devices/gen3/presetValidate.js';
import { MODEL_FM3 } from '../../src/devices/gen3/presetBody.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FM3_PRESET_5 = join(HERE, 'fm3', 'fixtures', 'preset-5.syx');

export const PRESET_VALIDATE_CASE_COUNT = 4;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`[gen3/preset-validate] ${msg}`);
}

export function runPresetValidateTests(): void {
  const good = new Uint8Array(readFileSync(FM3_PRESET_5));

  // 1. A real, coherent FM3 preset validates ok with no issues.
  const okRes = validateGen3Preset(good, MODEL_FM3);
  assert(okRes.ok, `preset-5 should validate ok, got issues: ${okRes.issues.join('; ')}`);
  assert(okRes.issues.length === 0, 'preset-5 should have zero issues');
  assert(okRes.blockCount > 0, 'preset-5 should decode blocks');
  assert(okRes.blockNames.length === okRes.blockCount, 'blockNames length matches blockCount');

  // 2. A truncated dump destroys the framing → does-not-decode issue.
  const truncated = good.slice(0, 200);
  const truncRes = validateGen3Preset(truncated, MODEL_FM3);
  assert(!truncRes.ok, 'truncated dump must be refused');
  assert(truncRes.issues.length > 0, 'truncated dump must report issues');
  assert(
    truncRes.issues.some((i) => i.startsWith('does not decode')),
    `truncated dump should report a decode failure, got: ${truncRes.issues.join('; ')}`,
  );
  assert(truncRes.blockCount === 0, 'truncated dump reports zero blocks');

  // 3. A CRC-corrupted dump still frames but no longer matches its stored CRC
  //    (or fails deeper decode) → refused with issues either way.
  const corrupt = good.slice();
  // Flip bytes inside the compressed payload, past the dump header, staying well
  // clear of the SysEx framing so parsePresetDump still accepts the container.
  const mid = Math.floor(corrupt.length / 2);
  for (let i = 0; i < 8; i++) corrupt[mid + i] = (corrupt[mid + i]! ^ 0xff) & 0x7f;
  const corruptRes = validateGen3Preset(corrupt, MODEL_FM3);
  assert(!corruptRes.ok, 'CRC-corrupted dump must be refused');
  assert(corruptRes.issues.length > 0, 'CRC-corrupted dump must report issues');
}
