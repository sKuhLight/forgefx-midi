/**
 * W5.4 red/green — a live-grid shunt must carry the SAME `effect_id` as the
 * dump grid.
 *
 * The dump grid (`presetBody.parseGrid`) reserves `effect_id > 1000` for
 * shunts and names them `Shunt <effect_id - 1023>` (ForgeFX docs/preset-grid-codec.md).
 * `liveGridView` emitted the raw sequential `shuntIndex` in `effect_id`, so a
 * consumer keying shunts by `effect_id` mismatched across the two views.
 */
import { liveGridView } from '../../src/devices/gen3/reader.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`live-grid-shunt: ${msg}`);
}

// FM9/III bit-field grid layout (GRID_* in src/gen3/axe-fx-iii/gridLayout.ts).
const FM9 = 0x12;
const GRID_REGION_OFFSET = 361;
const GRID_BASE_BIT = 46;
const GRID_COL_STRIDE = 192;
const GRID_ROW_STRIDE = 32;

function writeBitsMsb(region: number[], bit: number, value: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = bit + i;
    const idx = Math.floor(b / 7);
    const pos = 6 - (b % 7);
    const v = (value >> (n - 1 - i)) & 1;
    region[idx] = (region[idx] ?? 0) | (v << pos);
  }
}

function buildFrame(cells: { col: number; row: number; id: number; type: number; cable: number }[]): number[] {
  const region = new Array(391).fill(0);
  for (const c of cells) {
    const base = GRID_BASE_BIT + c.col * GRID_COL_STRIDE + c.row * GRID_ROW_STRIDE;
    writeBitsMsb(region, base + 0, c.id << 1, 8);
    writeBitsMsb(region, base + 8, c.type, 8);
    writeBitsMsb(region, base + 16, c.cable, 8);
  }
  return [0xf0, ...new Array(GRID_REGION_OFFSET).fill(0), ...region, 0xf7];
}

export const LIVE_GRID_SHUNT_CASE_COUNT = 3;

export function runLiveGridShuntTests(): void {
  const frame = buildFrame([
    { col: 0, row: 0, id: 58, type: 0x00, cable: 0 }, // Amp
    { col: 1, row: 0, id: 3, type: 0x08, cable: 0b00000010 }, // shunt #3
  ]);
  const cells = liveGridView(frame, FM9);

  const amp = cells.find((c) => !c.is_shunt);
  assert(amp?.effect_id === 58, `real block effect_id preserved; got ${JSON.stringify(amp)}`);

  const shunt = cells.find((c) => c.is_shunt);
  assert(shunt !== undefined, 'shunt cell missing from the live grid view');
  assert(
    shunt!.effect_id === 1026,
    `live shunt effect_id must use the dump convention 1023 + index (index 3 → 1026); got ${shunt!.effect_id}`,
  );
  assert(
    shunt!.effect_id - 1023 === 3 && shunt!.name === 'Shunt 3',
    `live shunt must name/ID as 'Shunt 3'; got ${JSON.stringify(shunt)}`,
  );
}
