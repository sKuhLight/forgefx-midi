/**
 * Read/query function allowlist (raw-probe allowlist) — pinned against the
 * codec's own query builders per family, against its write builders (never a
 * query frame), and against every update / erase / dump / IR / firmware
 * function the codec tables name (never allowlisted).
 */
import {
  QUERY_FUNCTIONS_BY_GEN,
  BROADCAST_QUERY_FUNCTIONS,
  queryFunctionsForModel,
  isQueryFrame,
} from '../../src/shared/queryFunctions.js';
import { FIRMWARE_TRANSFER_FUNCTIONS } from '../../src/shared/firmwareTransfer.js';
import { DEVICE_MODELS, buildIdentifyBroadcast } from '../../src/shared/identify.js';
import { buildFirmwareVersionQuery } from '../../src/shared/firmware.js';
import { fractalChecksum } from '../../src/shared/checksum.js';
import { AXE_FX_II_OPCODES } from '../../src/gen2/axe-fx-ii/opcodes.js';
import { createModernFractalCodec } from '../../src/gen3/axe-fx-iii/setParam.js';
import {
  buildGetPresetName,
  buildGetGridLayout,
  buildGetAllParams as buildGen2GetAllParams,
  buildQueryStates,
  buildSwitchPreset as buildGen2SwitchPreset,
  buildSetPresetName as buildGen2SetPresetName,
} from '../../src/gen2/axe-fx-ii/setParam.js';
import {
  buildRequestActiveBufferDump,
  buildRequestStoredPresetDump,
  buildGetAllParams as buildAm4GetAllParams,
  buildSaveToLocation,
  buildSwitchPreset as buildAm4SwitchPreset,
  buildSetBlockBypass,
} from '../../src/am4/index.js';
import { buildGetPatchDump } from '../../src/gen1/patchDump.js';
import { buildTunerPoll, buildCpuPoll } from '../../src/gen3/axe-fx-iii/telemetry.js';

function fail(msg: string): never {
  throw new Error(`[shared/queryFunctions] ${msg}`);
}

const hx = (n: number): string => `0x${n.toString(16).padStart(2, '0')}`;

function frame(model: number, fn: number, payload: number[] = []): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
}

const GEN3_MODELS = [0x10, 0x11, 0x12, 0x14] as const;

export const QUERY_FUNCTIONS_CASE_COUNT = 9;

export function runQueryFunctionsTests(): void {
  const allLists = [...Object.values(QUERY_FUNCTIONS_BY_GEN), BROADCAST_QUERY_FUNCTIONS];

  // 1 ── nothing that writes flash or streams data is ever allowlisted, on any family
  const g2 = AXE_FX_II_OPCODES;
  const never = [
    ...FIRMWARE_TRANSFER_FUNCTIONS,
    0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, // broadcast / preset dump / cab IR streams
    g2.FW_UPDATE, g2.FPGA_UPDATE, g2.MICRO_UPDATE, g2.ERASE_SECTOR, g2.FW_UPDATE_END,
    g2.FPGA_UPDATE_START, g2.FPGA_UPDATE_DATA, g2.FPGA_UPDATE_END,
    g2.MICRO_UPDATE_START, g2.MICRO_UPDATE_DATA, g2.MICRO_UPDATE_END,
    g2.SAVE_PATCH, g2.SET_DEFAULTS, g2.DELETE_CABIR, g2.CABIR_RCV, g2.PATCH_RCV,
    0x01, 0x02, // dual-use parameter set/get functions
  ];
  for (const list of allLists) {
    if (!Object.isFrozen(list)) fail('a query list is not frozen');
    for (const fn of never) if (list.includes(fn)) fail(`${hx(fn)} is allowlisted`);
  }
  for (const [name, fn] of Object.entries(g2)) {
    if (/UPDATE|ERASE/.test(name) && QUERY_FUNCTIONS_BY_GEN[2].includes(fn)) fail(`gen-2 ${name} allowlisted`);
  }

  // 1b ── every list pinned EXACTLY; gen-2 additionally equals WHO_AM_I + GET_* / QUERY_* of the opcode
  //       table, so a regenerated table that adds a GET_/QUERY_ entry fails here instead of widening silently
  const pinned: Record<string, string> = {
    '1': '03',
    '2': '00,08,0e,0f,15,16,17,18,1f,20,28,2a,30,35,36,3a,47',
    '3': '03,08,0d,0e,13,1f,43',
    '4': '03,08,1f',
  };
  const fmt = (l: readonly number[]) => [...l].sort((a, b) => a - b).map((n) => n.toString(16).padStart(2, '0')).join(',');
  for (const [gen, want] of Object.entries(pinned)) {
    const got = fmt(QUERY_FUNCTIONS_BY_GEN[Number(gen) as 1 | 2 | 3 | 4]);
    if (got !== want) fail(`gen-${gen} list ${got} !== pinned ${want}`);
  }
  if (fmt(BROADCAST_QUERY_FUNCTIONS) !== '00') fail('broadcast list is not exactly [0x00]');
  const derived = Object.entries(g2)
    .filter(([name]) => name === 'WHO_AM_I' || name.startsWith('GET_') || name.startsWith('QUERY_'))
    .map(([, fn]) => fn as number);
  if (fmt(derived) !== pinned['2']) fail(`gen-2 opcode table now derives ${fmt(derived)} — review and re-pin`);

  // 2 ── gen-3: the list is exactly what the codec's query builders emit (+ fn 0x08 firmware query)
  for (const m of GEN3_MODELS.slice(0, 3)) {
    const c = createModernFractalCodec(m);
    const queries: Array<[string, number[]]> = [
      ['buildQueryPatchName', c.buildQueryPatchName('current')],
      ['buildRequestPresetDump', c.buildRequestPresetDump(5)],
      ['buildRequestEditBufferDump', c.buildRequestEditBufferDump()],
      ['buildBlockBulkReadPoll', c.buildBlockBulkReadPoll(58)],
      ['buildStatusDump', c.buildStatusDump()],
      ['buildQuerySceneName', c.buildQuerySceneName(0)],
      ['buildFirmwareVersionQuery', buildFirmwareVersionQuery(m)],
    ];
    for (const [name, f] of queries) if (!isQueryFrame(f)) fail(`gen-3 ${name}@${hx(m)} is not a query frame`);
    const emitted = [...new Set(queries.map(([, f]) => f[5]!))].sort((a, b) => a - b);
    if (emitted.join(',') !== [...QUERY_FUNCTIONS_BY_GEN[3]].sort((a, b) => a - b).join(',')) {
      fail(`gen-3 list ${QUERY_FUNCTIONS_BY_GEN[3].map(hx)} !== builder fns ${emitted.map(hx)}`);
    }

    // 3 ── gen-3 writes and dual-use getters are not query frames
    const notQueries: Array<[string, number[]]> = [
      ['buildSetParameter', c.buildSetParameter(58, 1, 3)],
      ['buildGetParameter (dual-use 0x01)', c.buildGetParameter(58, 1)],
      ['buildStorePreset', c.buildStorePreset(5)],
      ['buildSwitchPresetSysEx', c.buildSwitchPresetSysEx(5)],
      ['buildSetPresetName', c.buildSetPresetName('x')],
      ['buildSetGridCell', c.buildSetGridCell({ row: 1, col: 1, blockId: 58, rows: 4 })],
      ['buildClearBlock', c.buildClearBlock({ row: 1, col: 1, rows: 4 })],
      ['buildSetBypass', c.buildSetBypass(58, true)],
      ['buildGetBypass (dual-use 0x0a)', c.buildGetBypass(58)],
      ['buildSetScene', c.buildSetScene(2)],
      ['buildSetTempo', c.buildSetTempo(120)],
      ['buildTempoTap', c.buildTempoTap()],
      ['buildSetTuner', c.buildSetTuner(true)],
      ['buildSetLooper', c.buildSetLooper('play')],
      ['buildTunerPoll (0x01 poll)', buildTunerPoll(m)],
      ['buildCpuPoll (0x01 poll)', buildCpuPoll(m)],
    ];
    for (const [name, f] of notQueries) if (isQueryFrame(f)) fail(`gen-3 ${name}@${hx(m)} classified as query`);
  }

  // 4 ── gen-2: name-derived list; the codec's gen-2 query builders pass, its writes do not
  for (const [name, f] of [
    ['buildGetPresetName', buildGetPresetName()],
    ['buildGetGridLayout', buildGetGridLayout()],
    ['buildGetAllParams', buildGen2GetAllParams(106)],
    ['buildQueryStates', buildQueryStates()],
  ] as Array<[string, number[]]>) {
    if (!isQueryFrame(f)) fail(`gen-2 ${name} is not a query frame`);
  }
  if (isQueryFrame(buildGen2SwitchPreset(5))) fail('gen-2 buildSwitchPreset classified as query');
  if (isQueryFrame(buildGen2SetPresetName('x'))) fail('gen-2 buildSetPresetName classified as query');
  if (!QUERY_FUNCTIONS_BY_GEN[2].includes(g2.WHO_AM_I) || !QUERY_FUNCTIONS_BY_GEN[2].includes(g2.QUERY_VERSION)) {
    fail('gen-2 WHO_AM_I / QUERY_VERSION missing');
  }

  // 5 ── AM4: dump requests + get-all-params pass; store / switch / bypass writes do not
  for (const [name, f] of [
    ['buildRequestActiveBufferDump', buildRequestActiveBufferDump()],
    ['buildRequestStoredPresetDump', buildRequestStoredPresetDump(3)],
    ['buildGetAllParams', buildAm4GetAllParams(0x3a)],
    ['buildFirmwareVersionQuery(0x15)', buildFirmwareVersionQuery(0x15)],
  ] as Array<[string, number[]]>) {
    if (!isQueryFrame(f)) fail(`AM4 ${name} is not a query frame`);
  }
  for (const [name, f] of [
    ['buildSaveToLocation', buildSaveToLocation(3)],
    ['buildSwitchPreset', buildAm4SwitchPreset(3)],
    ['buildSetBlockBypass', buildSetBlockBypass(0x3a, true)],
  ] as Array<[string, number[]]>) {
    if (isQueryFrame(f)) fail(`AM4 ${name} classified as query`);
  }

  // 6 ── gen-1: the patch-dump request passes
  if (!isQueryFrame(buildGetPatchDump())) fail('gen-1 buildGetPatchDump is not a query frame');

  // 7 ── broadcast: identify only
  if (!isQueryFrame(buildIdentifyBroadcast())) fail('identify broadcast is not a query frame');
  if (isQueryFrame(frame(0x7f, 0x08))) fail('broadcast fn 0x08 classified as query');

  // 8 ── unknown model bytes, non-Fractal SysEx and short frames are never query frames
  if (queryFunctionsForModel(0x42).length !== 0) fail('unknown model 0x42 has query functions');
  if (isQueryFrame(frame(0x42, 0x1f))) fail('unknown model classified as query');
  if (isQueryFrame([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7])) fail('universal identity request classified as query');
  if (isQueryFrame([0xf0, 0x43, 0x00, 0x08, 0x11, 0x08, 0x00, 0xf7])) fail('foreign manufacturer classified as query');
  if (isQueryFrame([0xf0, 0x00, 0x01, 0x74, 0x11])) fail('truncated header classified as query');

  // 9 ── every known model byte maps to its family list; typed-array frames are accepted
  for (const [k, info] of Object.entries(DEVICE_MODELS)) {
    const want = QUERY_FUNCTIONS_BY_GEN[info.gen as 1 | 2 | 3 | 4];
    if (queryFunctionsForModel(Number(k)) !== want) fail(`model ${k} does not map to its gen-${info.gen} list`);
  }
  if (!isQueryFrame(Uint8Array.from(frame(0x11, 0x1f, [0x3a, 0x00])))) fail('Uint8Array query frame rejected');
}
