/**
 * AM4 codec golden vectors.
 *
 * Each entry is a byte-exact hex string captured live from an AM4 over
 * USB. The lifted set covers SET_PARAM (float and enum), block-type
 * change, bypass, preset-name rename, scene switch, preset switch,
 * save-to-location, scene rename, and read-preset-name — the full
 * shape surface of the moved codec.
 *
 * If this test ever fails, the codec drifted from byte-level wire
 * reality, NOT just from internal expectations.
 */
import {
  buildSetFloatParam,
  buildSetParam,
  buildSetBlockType,
  buildSetBlockBypass,
  buildSetPresetName,
  buildSetSceneName,
  buildSwitchScene,
  buildSwitchPreset,
  buildSaveToLocation,
  buildGetPresetName,
  buildGetAllParams,
  buildRequestActiveBufferDump,
  KNOWN_PARAMS,
  BLOCK_TYPE_VALUES,
  parseLocationCode,
} from '../../src/am4/index.js';

function hex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Case {
  label: string;
  built: number[];
  expected: string;
}

const cases: Case[] = [
  // SET_PARAM (float + enum + channel)
  {
    label: 'buildSetFloatParam amp.gain 0.0',
    built: buildSetFloatParam(KNOWN_PARAMS['amp.gain'], 0.0),
    expected: 'f000017415013a000b00010000000400000000000025f7',
  },
  {
    label: 'buildSetFloatParam EQ band 1 = -1.0 dB (internal -1/12)',
    built: buildSetFloatParam({ pidLow: 0x003a, pidHigh: 0x003e }, -1 / 12),
    expected: 'f000017415013a003e00010000000400556a552b6839f7',
  },
  {
    label: 'buildSetParam amp.gain 0 (display path → low-level)',
    built: buildSetParam('amp.gain', 0),
    expected: 'f000017415013a000b00010000000400000000000025f7',
  },
  {
    label: 'buildSetParam amp.bass 6 (session-06)',
    built: buildSetParam('amp.bass', 6),
    expected: 'f000017415013a000c000100000004004d2623137801f7',
  },
  {
    label: 'buildSetParam amp.channel 1 (session-09 channel-B toggle)',
    built: buildSetParam('amp.channel', 1),
    expected: 'f000017415013a00520f010000000400000010037818f7',
  },
  {
    label: 'buildSetParam drive.channel 1 (session-18)',
    built: buildSetParam('drive.channel', 1),
    expected: 'f000017415017600520f010000000400000010037854f7',
  },
  {
    label: 'buildSetParam reverb.channel 1 (session-18)',
    built: buildSetParam('reverb.channel', 1),
    expected: 'f000017415014200520f010000000400000010037860f7',
  },
  {
    label: 'buildSetParam delay.channel 1 (session-18)',
    built: buildSetParam('delay.channel', 1),
    expected: 'f000017415014600520f010000000400000010037864f7',
  },
  {
    label: 'buildSetParam chorus.type 1 (session-18)',
    built: buildSetParam('chorus.type', 1),
    expected: 'f000017415014e000a0001000000040000001003783bf7',
  },
  {
    label: 'buildSetParam flanger.type 8 (session-18)',
    built: buildSetParam('flanger.type', 8),
    expected: 'f0000174150152000a00010000000400000000040840f7',
  },
  {
    label: 'buildSetParam phaser.type 3 (session-18)',
    built: buildSetParam('phaser.type', 3),
    expected: 'f000017415015a000a00010000000400000008040048f7',
  },

  // Block type
  {
    label: 'buildSetBlockType(2, none) — session-18 block-clear-to-none',
    built: buildSetBlockType(2, BLOCK_TYPE_VALUES.none),
    expected: 'f000017415014e01100001000000040000000000004bf7',
  },
  {
    label: 'buildSetBlockType(3, reverb) — session-18 block-type-gte-to-rev',
    built: buildSetBlockType(3, BLOCK_TYPE_VALUES.reverb),
    expected: 'f000017415014e01110001000000040000001044100ef7',
  },
  {
    label: 'buildSetBlockType(4, amp) — session-18 block-add-none-to-amp',
    built: buildSetBlockType(4, BLOCK_TYPE_VALUES.amp),
    expected: 'f000017415014e01120001000000040000000d041050f7',
  },

  // Save + rename
  {
    label: 'buildSaveToLocation(Z04) — session-18 save-preset-z04',
    built: buildSaveToLocation(parseLocationCode('Z04')),
    expected: 'f00001741501000000001b000000040033400000007df7',
  },
  {
    label: 'buildSetPresetName(Z04, "boston") — session-20-rename-preset',
    built: buildSetPresetName(parseLocationCode('Z04'), 'boston'),
    expected:
      'f000017415014e010b000c00000024003340000003095e733a1b6d6201004020100804020100402010080402010040201008040201004020100009f7',
  },

  // Switch scene
  {
    label: 'buildSwitchScene(0) — session-21 switch-to-scene-1',
    built: buildSwitchScene(0),
    expected: 'f000017415014e010d00010000000400000000000056f7',
  },
  {
    label: 'buildSwitchScene(1) — session-18-switch-scene (scene 2)',
    built: buildSwitchScene(1),
    expected: 'f000017415014e010d00010000000400004000000016f7',
  },
  {
    label: 'buildSwitchScene(2) — session-21 switch-to-scene-3',
    built: buildSwitchScene(2),
    expected: 'f000017415014e010d00010000000400010000000057f7',
  },
  {
    label: 'buildSwitchScene(3) — session-21 switch-to-scene-4',
    built: buildSwitchScene(3),
    expected: 'f000017415014e010d00010000000400014000000017f7',
  },

  // Switch preset (float-encoded location index)
  {
    label: 'buildSwitchPreset(0) — session-22 switch-to-A01 (float 0.0)',
    built: buildSwitchPreset(0),
    expected: 'f000017415014e010a00010000000400000000000051f7',
  },
  {
    label: 'buildSwitchPreset(1) — session-22 switch-to-A02 (float 1.0)',
    built: buildSwitchPreset(1),
    expected: 'f000017415014e010a0001000000040000001003783af7',
  },

  // Read preset name (non-destructive stored-preset read)
  {
    label: 'buildGetPresetName(0) — session-46 launch capture frame 45 (A01)',
    built: buildGetPresetName(0),
    expected: 'f000017415014e010b00120000000400000000000043f7',
  },
  {
    label: 'buildGetPresetName(1) — session-46 launch capture frame 49 (A02)',
    built: buildGetPresetName(1),
    expected: 'f000017415014e010b00120000000400004000000003f7',
  },
  {
    label: 'buildGetPresetName(103) — session-46 launch capture (Z04)',
    built: buildGetPresetName(103),
    expected: 'f000017415014e010b00120000000400334000000030f7',
  },

  // Active-buffer dump request ( / session-51)
  {
    label: 'buildRequestActiveBufferDump() — session-51 export-preset',
    built: buildRequestActiveBufferDump(),
    expected: 'f000017415037f7f0013f7',
  },

  // Scene rename
  {
    label: 'buildSetSceneName(1, "clean") — session-22-rename-scene-2',
    built: buildSetSceneName(1, 'clean'),
    expected:
      'f000017415014e0138000c000000240000000000030d5865305b44020100402010080402010040201008040201004020100804020100402010005ef7',
  },
  {
    label: 'buildSetSceneName(2, "chorus") — session-22-rename-scene-3',
    built: buildSetSceneName(2, 'chorus'),
    expected:
      'f000017415014e0139000c000000240000000000030d506f391d2e3201004020100804020100402010080402010040201008040201004020100048f7',
  },
  {
    label: 'buildSetSceneName(3, "lead") — session-22-rename-scene-4',
    built: buildSetSceneName(3, 'lead'),
    expected:
      'f000017415014e013a000c00000024000000000003314a613208040201004020100804020100402010080402010040201008040201004020100067f7',
  },

  // Block bypass (session-23 scene-scoped captures)
  {
    label: 'buildSetBlockBypass(amp, true) — session-23-scene-2-amp-bypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.amp, true),
    expected: 'f000017415013a000300010000000400000010037846f7',
  },
  {
    label: 'buildSetBlockBypass(drive, true) — session-23-scene-3-drive-bypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.drive, true),
    expected: 'f000017415017600030001000000040000001003780af7',
  },
  {
    label: 'buildSetBlockBypass(reverb, true) — session-23-scene-4-reverb-bypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.reverb, true),
    expected: 'f000017415014200030001000000040000001003783ef7',
  },
  {
    label: 'buildSetBlockBypass(amp, false) — session-23-scene-2-amp-unbypass',
    built: buildSetBlockBypass(BLOCK_TYPE_VALUES.amp, false),
    expected: 'f000017415013a00030001000000040000000000002df7',
  },

  // GET_ALL_PARAMS (fn 0x1F) — HW-AM4-FN1F probe goldens (2026-05-22).
  // Three of seven shapes returned state_broadcast_triple; the helper
  // only emits the shapes the device accepts (2-byte septet effectId).
  {
    label: 'buildGetAllParams(106) — amp1 effectId; matches probe-am4-fn1f shape "amp1"',
    built: buildGetAllParams(106),
    expected: 'f000017415' + '1f' + '6a00' + '65' + 'f7',
  },
  {
    label: 'buildGetAllParams(1) — effectId 1; matches probe-am4-fn1f shape "scene1"',
    built: buildGetAllParams(1),
    expected: 'f000017415' + '1f' + '0100' + '0e' + 'f7',
  },

  // ---------------------------------------------------------------------
  // Live user captures (2026-07-02) — independent third-party AM4 over
  // USB-MIDI. Wireshark pcapng, de-chunked and reassembled from the raw
  // 4-byte USB-MIDI event packets. These upgrade preset-swap /
  // save-to-location / amp-model-change from single-source to a second,
  // independent hardware confirmation, byte-for-byte.
  // ---------------------------------------------------------------------
  {
    // "Preset Swap" capture, host->device frame #1965. Confirms
    // pidLow=0x00CE / pidHigh=0x000A / action WRITE / value = float32
    // location index (7.0 = A08). buildSwitchPreset reproduced it exactly.
    label: 'buildSwitchPreset(7) — live "Preset Swap" capture frame 1965 (float 7.0)',
    built: buildSwitchPreset(7),
    expected: 'f000017415014e010a0001000000040000001c040049f7',
  },
  {
    // "Preset Swap" capture, host->device frame #3397 (float 8.0 = A09).
    label: 'buildSwitchPreset(8) — live "Preset Swap" capture frame 3397 (float 8.0)',
    built: buildSwitchPreset(8),
    expected: 'f000017415014e010a0001000000040000000004085df7',
  },
  {
    // "Preset Save" capture, host->device frame #1509. Confirms
    // action=0x1B, pidLow=pidHigh=0x0000, payload = u32 LE location index
    // (8 = A09). buildSaveToLocation reproduced it exactly.
    label: 'buildSaveToLocation(8) — live "Preset Save" capture frame 1509 (u32 8)',
    built: buildSaveToLocation(8),
    expected: 'f00001741501000000001b000000040004000000000af7',
  },
  {
    // "Amp Model Change" capture, host->device frame #3059. The amp-model
    // change goes over the wire as a plain param WRITE to the amp block's
    // Type param (pidLow=0x003A, pidHigh=0x000A, unit=enum), value =
    // float32 model index 201.0 = "1987X Treble" — NOT a buildSetBlockType
    // slot-register write (that uses pidLow=0x00CE). buildSetParam
    // reproduced it exactly.
    label: 'buildSetParam(amp.type, 201) — live "Amp Model Change" capture frame 3059 (1987X Treble)',
    built: buildSetParam('amp.type', 201),
    expected: 'f000017415013a000a00010000000400000009141821f7',
  },
];

export function runAm4SetParamTests(): void {
  const failed: string[] = [];
  for (const c of cases) {
    const got = hex(c.built);
    if (got !== c.expected) {
      failed.push(`${c.label}\n  expected: ${c.expected}\n  got:      ${got}`);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${cases.length} AM4 codec golden(s) failed:\n` + failed.join('\n'),
    );
  }
}

export const AM4_GOLDEN_CASE_COUNT = cases.length;
