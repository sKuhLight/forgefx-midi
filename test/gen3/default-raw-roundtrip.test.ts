/**
 * Gen-3 catalog `defaultRaw` round-trip + sanity (FORGEFXMID-39).
 *
 * The per-param `defaultRaw` added to FM3/FM9/Axe-Fx III RANGES is the device's
 * DEFAULT as the stored u16 (0..65534 body model), imported from the live
 * func-0x01 self-describe walk (off+16). This suite proves the value is usable
 * as a body slot:
 *
 *   1. WRITE→READ IDENTITY (hard, 100%): writing `defaultRaw` at a block's param
 *      slot via `writeBlockParam` and reading it back through `readBlockParams`
 *      returns the same raw u16 — the correctness contract the synthesizer relies
 *      on. Amp params are written on all four channels (the reader reads each).
 *   2. RANGE INVARIANT (hard, 100%): every `defaultRaw` is in [0, 65534].
 *   3. FLOAT IN-RANGE (>=90%): a float default decodes (linear model) inside its
 *      display range. The known ~5% residue is a class of amp advanced params
 *      whose captured default is in a different unit than min/max (clamped to an
 *      extreme, flagged at import) — tolerated, not fatal, mirroring the fas-re
 *      generator's own gate.
 *   4. ENUM ORDINAL VALID (>=98%): an enum default ordinal is < enumCount.
 *
 * NOT a device-acceptance test — it validates the codec's own read/write model.
 */
import {
  gen3BlockParamModel,
  writeBlockParam,
  readBlockParams,
  type Gen3BlockParamTables,
  type Gen3BodyLayout,
} from '../../src/devices/gen3/blockParams.js';

const MODELS: { name: string; id: number }[] = [
  { name: 'FM3', id: 0x11 },
  { name: 'FM9', id: 0x12 },
  { name: 'Axe-Fx III', id: 0x10 },
];

interface RangeEntry {
  kind?: string;
  displayMin: number;
  displayMax: number;
  enumCount?: number;
  defaultRaw?: number;
}

const VALUE_MODEL_MAX = 65534;

/** Smallest grid effect id mapped to `family` (a family occupies base..base+3). */
function baseEidFor(tables: Gen3BlockParamTables, family: string): number | null {
  let best: number | null = null;
  for (const [eidStr, fam] of Object.entries(tables.familyByEffectId)) {
    if (fam !== family) continue;
    const eid = Number(eidStr);
    if (best == null || eid < best) best = eid;
  }
  return best;
}

/** Build a synthetic body with one block header (eid + 8 zero bytes) at the param
 *  region floor, write every `defaultRaw` of `family` into its slots, and read it
 *  back. Returns the decoded blocks (amp → one per channel). */
function roundTripFamily(
  tables: Gen3BlockParamTables,
  layout: Gen3BodyLayout,
  family: string,
  eid: number,
  ranges: Record<number, RangeEntry>,
): ReturnType<typeof readBlockParams> {
  const pids = Object.keys(ranges).map(Number);
  const maxPid = pids.reduce((m, p) => Math.max(m, p), 0);
  const isAmp = family === layout.ampFamily;
  const channels = isAmp ? layout.ampChannels : 1;
  const floor = layout.paramRegionFloor;
  const size =
    floor + layout.paramArrayBase + 2 * (maxPid + 1) + channels * layout.ampChannelStride + 32;
  const body = new Uint8Array(size);

  // header: eid u16 LE + >=8 zero bytes, at the floor (findHeader anchors here).
  body[floor] = eid & 0xff;
  body[floor + 1] = (eid >> 8) & 0xff;

  for (const pid of pids) {
    const dr = ranges[pid].defaultRaw;
    if (dr == null) continue;
    for (let ch = 0; ch < channels; ch++) writeBlockParam(body, floor, layout, pid, ch, dr);
  }
  return readBlockParams(body, new Set([eid]), tables, layout);
}

export const DEFAULT_RAW_ROUNDTRIP_CASE_COUNT = MODELS.length;

export function runDefaultRawRoundTripTests(): void {
  for (const { name, id } of MODELS) {
    const { tables, layout } = gen3BlockParamModel(id);
    const ranges = tables.ranges as unknown as Record<string, Record<number, RangeEntry>>;

    let withDefault = 0;
    let identityChecked = 0;
    let floatTot = 0;
    let floatIn = 0;
    let enumTot = 0;
    let enumOk = 0;

    for (const [family, byPid] of Object.entries(ranges)) {
      const hasAny = Object.values(byPid).some((r) => r.defaultRaw != null);
      if (!hasAny) continue;

      // range invariant
      for (const [pidStr, r] of Object.entries(byPid)) {
        if (r.defaultRaw == null) continue;
        withDefault++;
        if (!Number.isInteger(r.defaultRaw) || r.defaultRaw < 0 || r.defaultRaw > VALUE_MODEL_MAX) {
          throw new Error(
            `[${name}] ${family}.${pidStr} defaultRaw ${r.defaultRaw} out of [0,${VALUE_MODEL_MAX}]`,
          );
        }
      }

      const eid = baseEidFor(tables, family);
      if (eid == null) continue; // family carries no grid effect id (e.g. table-only) — skip write path

      const decoded = roundTripFamily(tables, layout, family, eid, byPid);
      for (const block of decoded) {
        for (const p of block.params) {
          const r = byPid[p.paramId];
          if (!r || r.defaultRaw == null) continue;
          // (1) write→read identity — hard
          if (p.raw !== r.defaultRaw) {
            throw new Error(
              `[${name}] ${family}.${p.paramId} ch${block.channel ?? 0}: read raw ${p.raw} !== written defaultRaw ${r.defaultRaw}`,
            );
          }
          identityChecked++;
          // (3)/(4) data-quality accounting
          if (r.kind === 'enum') {
            enumTot++;
            if (r.enumCount == null || r.defaultRaw < r.enumCount) enumOk++;
          } else if (r.displayMax !== r.displayMin && p.value != null) {
            floatTot++;
            const lo = Math.min(r.displayMin, r.displayMax);
            const hi = Math.max(r.displayMin, r.displayMax);
            const tol = 1e-6 * Math.max(1, Math.abs(lo), Math.abs(hi));
            if (p.value >= lo - tol && p.value <= hi + tol) floatIn++;
          }
        }
      }
    }

    const fpct = floatTot ? floatIn / floatTot : 1;
    const epct = enumTot ? enumOk / enumTot : 1;
    console.log(
      `  [default-raw] ${name}: ${withDefault} defaults, ${identityChecked} write→read-identity OK; ` +
        `float in-range ${floatIn}/${floatTot} (${(fpct * 100).toFixed(1)}%), ` +
        `enum ordinal<count ${enumOk}/${enumTot} (${(epct * 100).toFixed(1)}%)`,
    );
    if (identityChecked === 0) throw new Error(`[${name}] no defaultRaw params exercised — catalog regression?`);
    if (fpct < 0.9) throw new Error(`[${name}] float defaults in-range ${(fpct * 100).toFixed(1)}% < 90%`);
    if (epct < 0.98) throw new Error(`[${name}] enum defaults valid ${(epct * 100).toFixed(1)}% < 98%`);
  }
}
