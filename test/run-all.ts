// fractal-midi test runner.
//
// tsx-runnable goldens, each printing PASS / FAIL and exiting non-zero
// on failure.

import { VERSION } from '../src/index.js';
import { runPackValueTests, runChecksumTests } from './shared/packvalue.test.js';
import { runLineageTests } from './shared/lineage.test.js';
import { runEffectIdTests, EFFECTID_CASE_COUNT } from './shared/effectid.test.js';
import { runIdentifyTests, IDENTIFY_CASE_COUNT } from './shared/identify.test.js';
import { runAm4SetParamTests, AM4_GOLDEN_CASE_COUNT } from './am4/setparam.test.js';
import { runAm4BlockLayoutTests, AM4_BLOCK_LAYOUT_CASE_COUNT } from './am4/blocklayout.test.js';
import { runAm4DecodeTests, AM4_DECODE_CASE_COUNT } from './am4/decode.test.js';
import {
  runAm4PresetBinaryTests,
  AM4_PRESET_BINARY_CASE_COUNT,
} from './am4/presetbinary.test.js';
import {
  runAm4PresetDumpTests,
  AM4_PRESET_DUMP_CASE_COUNT,
} from './am4/presetdump.test.js';
import {
  runAm4ModifierTests,
  AM4_MODIFIER_CASE_COUNT,
} from './am4/modifiers.test.js';
import {
  runAm4FirmwareTests,
  AM4_FIRMWARE_CASE_COUNT,
} from './am4/firmware.test.js';
import { runAm4DescribeTests, AM4_DESCRIBE_CASE_COUNT } from './am4/describe.test.js';
import { runAm4LivePollTests, AM4_LIVE_POLL_CASE_COUNT } from './am4/livepolls.test.js';
import { runAm4PollDecodeTests, AM4_POLL_DECODE_CASE_COUNT } from './am4/polldecode.test.js';
import { runAm4LiveDecodeTests, AM4_LIVE_DECODE_CASE_COUNT } from './am4/livedecode.test.js';
import { runAm4MidiRegisterTests, AM4_MIDI_REGISTERS_CASE_COUNT } from './am4/midiregisters.test.js';
import { runAm4TunerTests, AM4_TUNER_CASE_COUNT } from './am4/tuner.test.js';
import { runAm4ChannelTests, AM4_CHANNEL_CASE_COUNT } from './am4/channel.test.js';
import { runAm4PresetContainerTests, AM4_PRESET_CONTAINER_CASE_COUNT } from './am4/presetcontainer.test.js';
import { runAxeFxIISetParamTests, AXEFX2_GOLDEN_CASE_COUNT } from './gen2/axe-fx-ii/setparam.test.js';
import { runAxeFxIIRoutingTests, AXEFX2_ROUTING_CASE_COUNT } from './gen2/axe-fx-ii/routing.test.js';
import { runAxeFxGen1SetParamTests, AXEFXGEN1_GOLDEN_CASE_COUNT } from './gen1/setparam.test.js';
import { runAxeFxGen1ReadParamTests, AXEFXGEN1_READ_CASE_COUNT } from './gen1/readparam.test.js';
import { runAxeFxGen1PatchDumpTests, GEN1_PATCHDUMP_CASE_COUNT } from './gen1/patchdump.test.js';
import { runAxeFxIIAnnotationCoverageTests, AXEFX2_ANNOTATION_CASE_COUNT } from './gen2/axe-fx-ii/annotation-coverage.test.js';
import { runAxeFxIIISetParamTests, AXEFX3_GOLDEN_CASE_COUNT } from './gen3/axe-fx-iii/setparam.test.js';
import { runAxeFxIIICalibrationTest } from './gen3/axe-fx-iii/calibration.test.js';
import { runGen3RoutingTests, GEN3_ROUTING_CASE_COUNT } from './gen3/axe-fx-iii/routing.test.js';
import { runGen3SubactionTests, GEN3_SUBACTION_CASE_COUNT } from './gen3/axe-fx-iii/subactions.test.js';
import { runGen3GridLayoutTests, GEN3_GRIDLAYOUT_CASE_COUNT } from './gen3/axe-fx-iii/gridlayout.test.js';
import { runModernFamilyTests, MODERN_FAMILY_CASE_COUNT } from './gen3/modern-family/catalog.test.js';
import { runBoundCodecTests, BOUNDCODEC_CASE_COUNT } from './gen3/modern-family/boundcodec.test.js';
import { runFm3MetersTests, FM3_METERS_CASE_COUNT } from './gen3/fm3/meters.test.js';
import { runFm3BlockParamsTests, FM3_BLOCKPARAMS_CASE_COUNT } from './gen3/fm3/blockparams.test.js';
import { runCrossBlockParamsTests, CROSS_BLOCKPARAMS_CASE_COUNT } from './gen3/modern-family/blockparams-cross.test.js';
import { runFm3TelemetryTests, FM3_TELEMETRY_CASE_COUNT } from './gen3/fm3/telemetry.test.js';
import { runGen3RosterTests, FM3_ROSTER_CASE_COUNT } from './gen3/fm3/roster.test.js';
import { runFm9MetersTests, FM9_METERS_CASE_COUNT } from './gen3/fm9/meters.test.js';
import { runFm9FootControllerTests, FM9_FOOTCONTROLLER_CASE_COUNT } from './gen3/fm9/footcontroller.test.js';
import { runFm9ModifierTests, FM9_MODIFIER_CASE_COUNT } from './gen3/fm9/modifiers.test.js';
import { runAxe3MetersTests, AXE3_METERS_CASE_COUNT } from './gen3/axe-fx-iii/meters.test.js';
import { runAxe3FootControllerTests, AXE3_FC_CASE_COUNT } from './gen3/axe-fx-iii/footcontroller.test.js';
import { runAxe3ModifierTests, AXE3_MOD_CASE_COUNT } from './gen3/axe-fx-iii/modifiers.test.js';
import { runVp4SetParamTests, VP4_SETPARAM_CASE_COUNT } from './gen3/vp4/setparam.test.js';
import { runVp4StructureBlobTests, VP4_STRUCTUREBLOB_CASE_COUNT } from './gen3/vp4/structureblob.test.js';
import { runDiscreteOverlayTests, DISCRETE_OVERLAY_CASE_COUNT } from './gen3/discrete-overlay.test.js';
import { runGen3TypeNameTests, GEN3_TYPENAME_CASE_COUNT } from './gen3/axe-fx-iii/typename.test.js';
import { runAm4InternalFromDisplayTests, AM4_INTERNAL_FROM_DISPLAY_CASE_COUNT } from './am4/internalfromdisplay.test.js';
import { runAxeFxIIApplicabilityTests, AXEFX2_APPLICABILITY_CASE_COUNT } from './gen2/axe-fx-ii/applicability.test.js';
import { runSharedDisplayScaleTests, SHARED_DISPLAYSCALE_CASE_COUNT } from './shared/displayscale.test.js';
import { runDevicesSmokeTests, DEVICES_SMOKE_CASE_COUNT } from './devices-smoke.test.js';
import { runRecords, RECORDS_CASE_COUNT } from './cache/records.test.js';
import { runAssign, ASSIGN_CASE_COUNT } from './cache/assign.test.js';
import { runBuildProfile, BUILDPROFILE_CASE_COUNT } from './cache/buildprofile.test.js';
import { runLiveWalk, LIVEWALK_CASE_COUNT } from './cache/livewalk.test.js';

const tests: Array<{ name: string; run: () => void | Promise<void> }> = [
  {
    name: 'skeleton-smoke',
    run: () => {
      if (typeof VERSION !== 'string' || VERSION.length === 0) {
        throw new Error('VERSION export missing');
      }
    },
  },
  { name: 'shared/checksum', run: runChecksumTests },
  { name: 'shared/packvalue', run: runPackValueTests },
  { name: 'shared/lineage-load', run: runLineageTests },
  { name: `shared/effectid (${EFFECTID_CASE_COUNT} goldens)`, run: runEffectIdTests },
  { name: `shared/identify (${IDENTIFY_CASE_COUNT} goldens)`, run: runIdentifyTests },
  { name: `am4/setparam (${AM4_GOLDEN_CASE_COUNT} goldens)`, run: runAm4SetParamTests },
  { name: `am4/blocklayout (${AM4_BLOCK_LAYOUT_CASE_COUNT} cases)`, run: runAm4BlockLayoutTests },
  { name: `am4/decode (${AM4_DECODE_CASE_COUNT} cases)`, run: runAm4DecodeTests },
  {
    name: `am4/presetBinary (${AM4_PRESET_BINARY_CASE_COUNT} cases)`,
    run: runAm4PresetBinaryTests,
  },
  {
    name: `am4/presetDump (${AM4_PRESET_DUMP_CASE_COUNT} cases)`,
    run: runAm4PresetDumpTests,
  },
  {
    name: `am4/modifiers (${AM4_MODIFIER_CASE_COUNT} cases)`,
    run: runAm4ModifierTests,
  },
  {
    name: `am4/firmware (${AM4_FIRMWARE_CASE_COUNT} cases)`,
    run: runAm4FirmwareTests,
  },
  { name: `am4/describe (${AM4_DESCRIBE_CASE_COUNT} capture labels)`, run: runAm4DescribeTests },
  { name: `am4/livePolls (${AM4_LIVE_POLL_CASE_COUNT} candidates)`, run: runAm4LivePollTests },
  { name: `am4/pollDecode (${AM4_POLL_DECODE_CASE_COUNT} real-frame cases)`, run: runAm4PollDecodeTests },
  { name: `am4/liveDecode (${AM4_LIVE_DECODE_CASE_COUNT} cases)`, run: runAm4LiveDecodeTests },
  { name: `am4/midiRegisters (${AM4_MIDI_REGISTERS_CASE_COUNT} cases)`, run: runAm4MidiRegisterTests },
  { name: `am4/tuner (${AM4_TUNER_CASE_COUNT} real-frame cases)`, run: runAm4TunerTests },
  { name: `am4/channel (${AM4_CHANNEL_CASE_COUNT} cases)`, run: runAm4ChannelTests },
  { name: `am4/presetcontainer (${AM4_PRESET_CONTAINER_CASE_COUNT} cases)`, run: runAm4PresetContainerTests },
  { name: `axe-fx-ii/setparam (${AXEFX2_GOLDEN_CASE_COUNT} goldens)`, run: runAxeFxIISetParamTests },
  { name: `axe-fx-ii/routing (${AXEFX2_ROUTING_CASE_COUNT} goldens)`, run: runAxeFxIIRoutingTests },
  { name: `axe-fx-gen1/setparam (${AXEFXGEN1_GOLDEN_CASE_COUNT} goldens)`, run: runAxeFxGen1SetParamTests },
  { name: `axe-fx-gen1/readparam (${AXEFXGEN1_READ_CASE_COUNT} goldens)`, run: runAxeFxGen1ReadParamTests },
  { name: `axe-fx-gen1/patchdump (${GEN1_PATCHDUMP_CASE_COUNT} goldens)`, run: runAxeFxGen1PatchDumpTests },
  { name: `axe-fx-ii/annotation-coverage (${AXEFX2_ANNOTATION_CASE_COUNT} goldens)`, run: runAxeFxIIAnnotationCoverageTests },
  { name: `axe-fx-iii/setparam (${AXEFX3_GOLDEN_CASE_COUNT} goldens)`, run: runAxeFxIIISetParamTests },
  { name: 'axe-fx-iii/calibration', run: runAxeFxIIICalibrationTest },
  { name: `axe-fx-iii/routing (${GEN3_ROUTING_CASE_COUNT} goldens)`, run: runGen3RoutingTests },
  { name: `axe-fx-iii/subactions (${GEN3_SUBACTION_CASE_COUNT} goldens)`, run: runGen3SubactionTests },
  { name: `axe-fx-iii/gridlayout (${GEN3_GRIDLAYOUT_CASE_COUNT} goldens)`, run: runGen3GridLayoutTests },
  { name: `modern-family/catalog (${MODERN_FAMILY_CASE_COUNT} goldens)`, run: runModernFamilyTests },
  { name: `modern-family/boundcodec (${BOUNDCODEC_CASE_COUNT} model bytes, full surface)`, run: runBoundCodecTests },
  { name: `fm3/meters (${FM3_METERS_CASE_COUNT} cases)`, run: runFm3MetersTests },
  { name: `fm3/blockparams (${FM3_BLOCKPARAMS_CASE_COUNT} live-FM3 preset goldens)`, run: runFm3BlockParamsTests },
  { name: `modern-family/blockparams-cross (${CROSS_BLOCKPARAMS_CASE_COUNT} cross-device preset goldens)`, run: runCrossBlockParamsTests },
  { name: `fm3/telemetry (${FM3_TELEMETRY_CASE_COUNT} live-FM3 frame goldens)`, run: runFm3TelemetryTests },
  { name: `gen3/roster (${FM3_ROSTER_CASE_COUNT} projection goldens)`, run: runGen3RosterTests },
  { name: `fm9/meters (${FM9_METERS_CASE_COUNT} cases)`, run: runFm9MetersTests },
  { name: `fm9/footcontroller (${FM9_FOOTCONTROLLER_CASE_COUNT} cases)`, run: runFm9FootControllerTests },
  { name: `fm9/modifiers (${FM9_MODIFIER_CASE_COUNT} cases)`, run: runFm9ModifierTests },
  { name: `axe-fx-iii/meters (${AXE3_METERS_CASE_COUNT} cases)`, run: runAxe3MetersTests },
  { name: `axe-fx-iii/footcontroller (${AXE3_FC_CASE_COUNT} cases)`, run: runAxe3FootControllerTests },
  { name: `axe-fx-iii/modifiers (${AXE3_MOD_CASE_COUNT} cases)`, run: runAxe3ModifierTests },
  { name: `vp4/setparam (${VP4_SETPARAM_CASE_COUNT} goldens)`, run: runVp4SetParamTests },
  { name: `vp4/structureblob (${VP4_STRUCTUREBLOB_CASE_COUNT} goldens)`, run: runVp4StructureBlobTests },
  { name: `gen3/discrete-overlay (${DISCRETE_OVERLAY_CASE_COUNT} cases)`, run: runDiscreteOverlayTests },
  { name: `gen3/typename (${GEN3_TYPENAME_CASE_COUNT} goldens)`, run: runGen3TypeNameTests },
  { name: `am4/internalFromDisplay (${AM4_INTERNAL_FROM_DISPLAY_CASE_COUNT} cases)`, run: runAm4InternalFromDisplayTests },
  { name: `axe-fx-ii/applicability (${AXEFX2_APPLICABILITY_CASE_COUNT} cases)`, run: runAxeFxIIApplicabilityTests },
  { name: `shared/displayScale (${SHARED_DISPLAYSCALE_CASE_COUNT} cases)`, run: runSharedDisplayScaleTests },
  { name: `devices/smoke (${DEVICES_SMOKE_CASE_COUNT} descriptors, from dist)`, run: runDevicesSmokeTests },
  { name: `cache/records (${RECORDS_CASE_COUNT} cases)`, run: runRecords },
  { name: `cache/assign (${ASSIGN_CASE_COUNT} oracle cases)`, run: runAssign },
  { name: `cache/buildprofile (${BUILDPROFILE_CASE_COUNT} cases)`, run: runBuildProfile },
  { name: `cache/livewalk (${LIVEWALK_CASE_COUNT} cases)`, run: runLiveWalk },
];

let failures = 0;

for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${tests.length} test(s) passed.`);
