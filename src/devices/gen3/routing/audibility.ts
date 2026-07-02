/**
 * Audibility walker configs for the modern Fractal family (gen-3).
 *
 * Binds the device-agnostic core walker
 * (@mcp-midi-control/core/routing/audibility) to gen-3 device constants.
 * Block names are derived from AXE_FX_III_BLOCKS (shared catalog across
 * the III family).
 *
 * Configs:
 *   - AXE_FX_III_AUDIBILITY_CONFIG  (6×14 grid)
 *   - FM9_AUDIBILITY_CONFIG          (6×14 grid, same as III)
 *   - FM3_AUDIBILITY_CONFIG          (4×12 grid)
 *
 * Entry points:
 *   - checkAudibilityAxeFxIII(input)
 *   - checkAudibilityFM9(input)
 *   - checkAudibilityFM3(input)
 */
import {
  checkAudibility as coreCheck,
  type GridAudibilityConfig,
  type AudibilityInput,
  type AudibilityReport,
  type GridCell,
} from '../../../core/routing/audibility.js';
import { AXE_FX_III_BLOCKS } from '../../../gen3/axe-fx-iii/index.js';

export type { GridCell, AudibilityInput, AudibilityReport };

// Build a blockId -> name lookup from the gen-3 catalog.
// Blocks with firstId=null have no confirmed effectId and are skipped.
const GEN3_BLOCK_NAME = new Map<number, string>();
for (const b of AXE_FX_III_BLOCKS) {
  if (b.firstId === null) continue;
  for (let i = 0; i < b.instances; i++) {
    const suffix = b.instances > 1 ? ` ${i + 1}` : '';
    GEN3_BLOCK_NAME.set(b.firstId + i, `${b.name}${suffix}`);
  }
}

const gen3BlockLabel = (id: number, row: number, col: number): string =>
  `${GEN3_BLOCK_NAME.get(id) ?? `block ${id}`} at row ${row} col ${col}`;

/**
 * 6-row grid config for the Axe-Fx III and FM9 (6×14 grid).
 *
 * Output blocks: IDs 42-45 (Output 1-4, firstId=42, instances=4).
 * Send/Return blocks: IDs 182-189 (Send 1-4: 182-185, Return 1-4: 186-189).
 * Shunts: no confirmed effectId in gen-3; isShunt always returns false.
 * Device output column: 14 (hardware-fixed sink).
 */
const GEN3_6ROW: GridAudibilityConfig = {
  deviceOutputCol: 14,
  outputBlockIds: new Set([42, 43, 44, 45]),
  sendReturnBlockIds: new Set([182, 183, 184, 185, 186, 187, 188, 189]),
  isShunt: () => false,
  blockLabel: gen3BlockLabel,
};

/**
 * 4-row grid config for the FM3 (4×12 grid).
 * Shares the same block catalog and Send/Return IDs as the III/FM9.
 * Device output column: 12.
 */
const GEN3_4ROW: GridAudibilityConfig = {
  ...GEN3_6ROW,
  deviceOutputCol: 12,
};

export const AXE_FX_III_AUDIBILITY_CONFIG = GEN3_6ROW;
export const FM9_AUDIBILITY_CONFIG = GEN3_6ROW;
export const FM3_AUDIBILITY_CONFIG = GEN3_4ROW;

export function checkAudibilityAxeFxIII(input: AudibilityInput): AudibilityReport {
  return coreCheck(input, GEN3_6ROW);
}

export function checkAudibilityFM9(input: AudibilityInput): AudibilityReport {
  return coreCheck(input, GEN3_6ROW);
}

export function checkAudibilityFM3(input: AudibilityInput): AudibilityReport {
  return coreCheck(input, GEN3_4ROW);
}
