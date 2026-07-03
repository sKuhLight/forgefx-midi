/**
 * Bound-codec model-byte discipline.
 *
 * `createModernFractalCodec(modelByte)` exists so a device driver can hold ONE
 * object and never touch a raw builder whose model byte silently defaults to
 * the Axe-Fx III (0x10) — the root cause of the "wrong codec / frames ignored
 * by the device" bug class. This suite smoke-invokes every frame-emitting
 * member of a codec bound to 0x10 / 0x11 / 0x12 and asserts byte f[4] of every
 * produced frame equals the bound model byte.
 */
import { createModernFractalCodec } from '../../../src/gen3/axe-fx-iii/setParam.js';

const MODEL_BYTES = [0x10, 0x11, 0x12] as const;

export const BOUNDCODEC_CASE_COUNT = MODEL_BYTES.length;

export function runBoundCodecTests(): void {
  for (const mb of MODEL_BYTES) {
    const codec = createModernFractalCodec(mb);
    if (codec.modelByte !== mb) throw new Error(`[boundcodec] codec.modelByte ${codec.modelByte} !== ${mb}`);

    const frames: Record<string, number[] | number[][]> = {
      buildSetParameter: codec.buildSetParameter(58, 1, 3),
      buildSetParameterContinuous: codec.buildSetParameterContinuous(58, 1, 0.5),
      buildGetParameter: codec.buildGetParameter(58, 1),
      buildSetBypass: codec.buildSetBypass(58, true),
      buildSetChannel: codec.buildSetChannel(58, 1),
      buildSetScene: codec.buildSetScene(2),
      buildSetGridCell: codec.buildSetGridCell({ row: 1, col: 1, blockId: 58, rows: 4 }),
      buildSetGridRouting: codec.buildSetGridRouting({ srcRow: 1, srcCol: 1, destRow: 1, rows: 4 }),
      buildSetPresetName: codec.buildSetPresetName('Test'),
      buildStorePreset: codec.buildStorePreset(5),
      buildSwitchPresetSysEx: codec.buildSwitchPresetSysEx(5),
      buildQueryPatchName: codec.buildQueryPatchName('current'),
      buildRequestPresetDump: codec.buildRequestPresetDump(5),
      buildRequestEditBufferDump: codec.buildRequestEditBufferDump(),
      buildBlockBulkReadPoll: codec.buildBlockBulkReadPoll(58),
      buildGetBypass: codec.buildGetBypass(58),
      buildGetChannel: codec.buildGetChannel(58),
      buildGetScene: codec.buildGetScene(),
      buildGetTempo: codec.buildGetTempo(),
      buildSetTempo: codec.buildSetTempo(120),
      buildTempoTap: codec.buildTempoTap(),
      buildSetTuner: codec.buildSetTuner(true),
      buildStatusDump: codec.buildStatusDump(),
      buildQuerySceneName: codec.buildQuerySceneName(0),
      buildSetSceneName: codec.buildSetSceneName(0, 'Scene'),
      buildRenamePreset: codec.buildRenamePreset('Name'),
      buildClearBlock: codec.buildClearBlock({ row: 1, col: 1, rows: 4 }),
      buildClearBlockCompanion: codec.buildClearBlockCompanion({ row: 1, col: 1, rows: 4 }),
      buildSetLooper: codec.buildSetLooper('play'),
      buildGetLooperState: codec.buildGetLooperState(),
    };

    for (const [name, out] of Object.entries(frames)) {
      const list = Array.isArray(out[0]) ? (out as number[][]) : [out as number[]];
      for (const frame of list) {
        if (frame[0] !== 0xf0) throw new Error(`[boundcodec] ${name}@0x${mb.toString(16)}: not a SysEx frame`);
        if (frame[4] !== mb) {
          throw new Error(`[boundcodec] ${name}@0x${mb.toString(16)}: frame carries model byte 0x${frame[4]?.toString(16)} — the wrong-codec bug class`);
        }
      }
    }

    // response predicates must accept only the bound model's frames
    const echo = codec.buildSetScene(1); // 0x0C frame shaped like the response
    if (!codec.isSetGetSceneResponse(echo)) throw new Error(`[boundcodec] isSetGetSceneResponse rejected own model 0x${mb.toString(16)}`);
    const other = createModernFractalCodec(mb === 0x10 ? 0x11 : 0x10).buildSetScene(1);
    if (codec.isSetGetSceneResponse(other)) throw new Error(`[boundcodec] isSetGetSceneResponse accepted a foreign model byte`);
  }
}
