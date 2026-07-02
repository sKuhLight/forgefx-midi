/**
 * Audibility walker for the Axe-Fx II 4×12 routing grid.
 *
 * Thin adapter: binds the device-agnostic core walker
 * (@mcp-midi-control/core/routing/audibility) to the Axe-Fx II's
 * specific constants and block-name lookup.
 *
 * All logic (graph building, BFS, cut-vertex analysis, detection)
 * lives in the core walker. This file provides:
 *   - AXE_FX_II_AUDIBILITY_CONFIG  (the II-specific GridAudibilityConfig)
 *   - checkAudibility(input)        (one-arg wrapper for existing callers)
 *   - Re-exports of all core interfaces so existing callers see no change
 */
import { BLOCK_BY_ID } from '../../../gen2/axe-fx-ii/index.js';
import {
  checkAudibility as coreCheckAudibility,
  MUTING_BYPASS_MODES,
  type GridAudibilityConfig,
  type GridCell,
  type AudibilityBreak,
  type AudibilityNote,
  type AudibilityReport,
  type AudibilityInput,
} from '../../../core/routing/audibility.js';

export type { GridCell, AudibilityBreak, AudibilityNote, AudibilityReport, AudibilityInput };
export { MUTING_BYPASS_MODES };

const GRID_COLS = 12;
const FX_LOOP_BLOCK_ID = 136;
const OUTPUT_BLOCK_ID = 140;

function axeFxIIBlockLabel(blockId: number, row: number, col: number): string {
  const block = BLOCK_BY_ID[blockId];
  return `${block?.name ?? `block ${blockId}`} at row ${row} col ${col}`;
}

/**
 * Axe-Fx II GridAudibilityConfig.
 *
 * - 4×12 grid; device output sink at col 12.
 * - Output block: ID 140. Acts as a chain terminator that internally
 *   cables to the hardware output sink.
 * - FX Loop: ID 136. Soft note when engaged (hardware-sense on Return
 *   means no Return jack falls back to dry pass-through).
 * - Shunts: IDs 200..235 (hard-wired pass-through wires).
 */
export const AXE_FX_II_AUDIBILITY_CONFIG: GridAudibilityConfig = {
  deviceOutputCol: GRID_COLS,
  outputBlockIds: new Set([OUTPUT_BLOCK_ID]),
  sendReturnBlockIds: new Set([FX_LOOP_BLOCK_ID]),
  isShunt: (id) => id >= 200 && id <= 235,
  blockLabel: axeFxIIBlockLabel,
};

/**
 * Pure check, no I/O. Caller assembles wire reads and passes the parsed data.
 *
 * One-argument wrapper so existing callers require no changes. Delegates
 * entirely to the device-agnostic core walker with the II config bound in.
 */
export function checkAudibility(input: AudibilityInput): AudibilityReport {
  return coreCheckAudibility(input, AXE_FX_II_AUDIBILITY_CONFIG);
}

/** Re-export for tests. */
export const __testing = {
  MUTING_BYPASS_MODES,
  FX_LOOP_BLOCK_ID,
  OUTPUT_BLOCK_ID,
  GRID_COLS,
};
