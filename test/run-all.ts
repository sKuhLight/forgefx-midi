// fractal-midi test runner.
//
// tsx-runnable goldens, each printing PASS / FAIL and exiting non-zero
// on failure.

import { VERSION } from '../src/index.js';
import { runPackValueTests, runChecksumTests } from './shared/packvalue.test.js';
import { runLineageTests } from './shared/lineage.test.js';
import { runEffectIdTests, EFFECTID_CASE_COUNT } from './shared/effectid.test.js';
import { runIdentifyTests, IDENTIFY_CASE_COUNT } from './shared/identify.test.js';
import { runFirmwareTests, FIRMWARE_CASE_COUNT } from './shared/firmware.test.js';
import { runFirmwareTransferTests, FIRMWARE_TRANSFER_CASE_COUNT } from './shared/firmwaretransfer.test.js';
import { runQueryFunctionsTests, QUERY_FUNCTIONS_CASE_COUNT } from './shared/queryfunctions.test.js';
import { runAm4SetParamTests, AM4_GOLDEN_CASE_COUNT } from './am4/setparam.test.js';
import { runAm4CabNameTests, AM4_CABNAME_CASE_COUNT } from './am4/cabname.test.js';
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
import { runGen3ReadPollsTests, GEN3_READPOLLS_CASE_COUNT } from './gen3/axe-fx-iii/readpolls.test.js';
import { runGen3GraphsTests, GEN3_GRAPHS_CASE_COUNT } from './gen3/graphs.test.js';
import { runGen3GridLayoutTests, GEN3_GRIDLAYOUT_CASE_COUNT } from './gen3/axe-fx-iii/gridlayout.test.js';
import { runModernFamilyTests, MODERN_FAMILY_CASE_COUNT } from './gen3/modern-family/catalog.test.js';
import { runBoundCodecTests, BOUNDCODEC_CASE_COUNT } from './gen3/modern-family/boundcodec.test.js';
import { runFm3MetersTests, FM3_METERS_CASE_COUNT } from './gen3/fm3/meters.test.js';
import { runFm3BlockParamsTests, FM3_BLOCKPARAMS_CASE_COUNT } from './gen3/fm3/blockparams.test.js';
import { runPresetAuthorIrTests, PRESET_AUTHOR_IR_CASE_COUNT } from './gen3/fm3/preset-author-ir.test.js';
import { runPresetSynthIrTests, PRESET_SYNTH_IR_CASE_COUNT } from './gen3/fm3/preset-synth-ir.test.js';
import { runWalkBlocksCountTests, WALKBLOCKS_COUNT_CASE_COUNT } from './gen3/fm3/walkblocks-count.test.js';
import { runDefaultRawRoundTripTests, DEFAULT_RAW_ROUNDTRIP_CASE_COUNT } from './gen3/default-raw-roundtrip.test.js';
import { runPresetSynthCatalogTests, PRESET_SYNTH_CATALOG_CASE_COUNT } from './gen3/fm3/preset-synth-catalog.test.js';
import { runGen3SynthNonFm3Tests, GEN3_SYNTH_NONFM3_CASE_COUNT } from './gen3/gen3-synth-nonfm3.test.js';
import { runRoutingRoundTripTests, ROUTING_ROUNDTRIP_CASE_COUNT } from './gen3/fm3/routing-roundtrip.test.js';
import { runConvertGridEidTests, CONVERT_GRID_EID_CASE_COUNT } from './convert/grid-eid.test.js';
import { runCrossBlockParamsTests, CROSS_BLOCKPARAMS_CASE_COUNT } from './gen3/modern-family/blockparams-cross.test.js';
import { runFm3TelemetryTests, FM3_TELEMETRY_CASE_COUNT } from './gen3/fm3/telemetry.test.js';
import { runGen3RosterTests, FM3_ROSTER_CASE_COUNT } from './gen3/fm3/roster.test.js';
import { runPresetValidateTests, PRESET_VALIDATE_CASE_COUNT } from './gen3/preset-validate.test.js';
import { runEmptySlotTests, EMPTY_SLOT_CASE_COUNT } from './gen3/empty-slot.test.js';
import { runFm9MetersTests, FM9_METERS_CASE_COUNT } from './gen3/fm9/meters.test.js';
import { runFm9FootControllerTests, FM9_FOOTCONTROLLER_CASE_COUNT } from './gen3/fm9/footcontroller.test.js';
import { runFm9ModifierTests, FM9_MODIFIER_CASE_COUNT } from './gen3/fm9/modifiers.test.js';
import { runAxe3MetersTests, AXE3_METERS_CASE_COUNT } from './gen3/axe-fx-iii/meters.test.js';
import { runAxe3FootControllerTests, AXE3_FC_CASE_COUNT } from './gen3/axe-fx-iii/footcontroller.test.js';
import { runAxe3ModifierTests, AXE3_MOD_CASE_COUNT } from './gen3/axe-fx-iii/modifiers.test.js';
import { runAxe3EffectIdsTests, AXE3_EFFECT_IDS_CASE_COUNT } from './gen3/axe-fx-iii/effect-ids.test.js';
import { runVp4SetParamTests, VP4_SETPARAM_CASE_COUNT } from './gen3/vp4/setparam.test.js';
import { runVp4StructureBlobTests, VP4_STRUCTUREBLOB_CASE_COUNT } from './gen3/vp4/structureblob.test.js';
import { runDiscreteOverlayTests, DISCRETE_OVERLAY_CASE_COUNT } from './gen3/discrete-overlay.test.js';
import { runGen3TypeNameTests, GEN3_TYPENAME_CASE_COUNT } from './gen3/axe-fx-iii/typename.test.js';
import { runAm4InternalFromDisplayTests, AM4_INTERNAL_FROM_DISPLAY_CASE_COUNT } from './am4/internalfromdisplay.test.js';
import { runAxeFxIIApplicabilityTests, AXEFX2_APPLICABILITY_CASE_COUNT } from './gen2/axe-fx-ii/applicability.test.js';
import { runSharedDisplayScaleTests, SHARED_DISPLAYSCALE_CASE_COUNT } from './shared/displayscale.test.js';
import { runSysExAssemblerTests, SYSEX_ASSEMBLER_CASE_COUNT } from './shared/sysexassembler.test.js';
import { runDevicesSmokeTests, DEVICES_SMOKE_CASE_COUNT } from './devices-smoke.test.js';
import { runRecords, RECORDS_CASE_COUNT } from './cache/records.test.js';
import { runAssign, runAssignLive, ASSIGN_CASE_COUNT, ASSIGN_LIVE_CASE_COUNT } from './cache/assign.test.js';
import { runBuildProfile, BUILDPROFILE_CASE_COUNT } from './cache/buildprofile.test.js';
import { runAm4Cache, AM4_CACHE_CASE_COUNT } from './cache/am4-cache.test.js';
import { runLiveWalk, LIVEWALK_CASE_COUNT } from './cache/livewalk.test.js';
import { runLiveWalkReplies, LIVEWALK_REPLIES_CASE_COUNT } from './cache/livewalk-replies.test.js';
import { runLiveWalkSlots, LIVEWALK_SLOTS_CASE_COUNT } from './cache/livewalk-slots.test.js';
import { runLiveWalkTraffic, LIVEWALK_TRAFFIC_CASE_COUNT } from './cache/livewalk-traffic.test.js';
import { runLiveWalkBounds, LIVEWALK_BOUNDS_CASE_COUNT } from './cache/livewalk-bounds.test.js';
import { runLiveWalkHints, LIVEWALK_HINTS_CASE_COUNT } from './cache/livewalk-hints.test.js';
import { runFullWalk, FULLWALK_CASE_COUNT } from './cache/fullwalk.test.js';
import { runKnobRule, KNOBRULE_CASE_COUNT } from './cache/knobrule.test.js';
import { runWalkReplay, WALKREPLAY_CASE_COUNT } from './cache/walkreplay.test.js';
import { runFingerprint, FINGERPRINT_CASE_COUNT } from './cache/fingerprint.test.js';
import { runCatalogBridge, CATALOG_BRIDGE_CASE_COUNT } from './cache/catalog-bridge.test.js';
import { runRedact, REDACT_CASE_COUNT } from './cache/redact.test.js';
import { runCacheHeader, CACHE_HEADER_CASE_COUNT } from './cache/header.test.js';
import { runProfileDoc, PROFILE_DOC_CASE_COUNT } from './cache/profile-doc.test.js';
import { runProfileSections, PROFILE_SECTIONS_CASE_COUNT } from './cache/profile-sections.test.js';
import { runMerge, MERGE_CASE_COUNT } from './cache/merge.test.js';
import { runTypecodeRules, TYPECODE_RULES_CASE_COUNT } from './cache/typecode-rules.test.js';
import { runBlockMap, BLOCK_MAP_CASE_COUNT } from './cache/block-map.test.js';
import { runLiveWalkScope, LIVEWALK_SCOPE_CASE_COUNT } from './cache/livewalk-scope.test.js';
import { runShare, SHARE_CASE_COUNT } from './cache/share.test.js';
import { runSpotCheckSuite, SPOT_CHECK_CASE_COUNT } from './cache/spot-check.test.js';
import { runEditorLayoutsTests, EDITOR_LAYOUTS_CASE_COUNT } from './editorLayouts.test.js';
import { runEditorLayoutFamiliesTests, EDITOR_LAYOUT_FAMILIES_CASE_COUNT } from './editorLayouts-families.test.js';
import { runCrossBlockEffectIdTests, CROSSBLOCK_EFFECTID_CASE_COUNT } from './gen3/crossblock-effectid.test.js';
import { runGenEditorLayoutsTests, GEN_EDITOR_LAYOUTS_CASE_COUNT } from './scripts/gen-editor-layouts.test.js';
import { runFamiliesTests, FAMILIES_CASE_COUNT } from './convert/families.test.js';
import { runGen3AdapterTests, GEN3_ADAPTER_CASE_COUNT } from './convert/gen3-adapter.test.js';
import { runShallowAdaptersTests, SHALLOW_ADAPTERS_CASE_COUNT } from './convert/adapters-shallow.test.js';
import { runConceptCoverageTests, CONCEPT_COVERAGE_CASE_COUNT } from './convert/concept-coverage.test.js';
import { runLineageIndexTests, LINEAGE_INDEX_CASE_COUNT } from './convert/lineage-index.test.js';
import { runEngineTests, ENGINE_CASE_COUNT } from './convert/engine.test.js';
import { runTargetRangesTests, TARGET_RANGES_CASE_COUNT } from './convert/target-ranges.test.js';
import { runGen3TaperTests, GEN3_TAPER_CASE_COUNT } from './convert/gen3-taper.test.js';
import { runEnumParamsTests, ENUM_PARAMS_CASE_COUNT } from './convert/enum-params.test.js';
import { runSerialCloseTests, SERIAL_CLOSE_CASE_COUNT } from './shared/serial-close.test.js';
import { runGridGuardTests, GRID_GUARD_CASE_COUNT } from './gen3/presetbody-grid-guard.test.js';
import { runLiveGridShuntTests, LIVE_GRID_SHUNT_CASE_COUNT } from './gen3/live-grid-shunt.test.js';
import { runTaperDecodeTests, TAPER_DECODE_CASE_COUNT } from './gen3/taper-decode.test.js';
import { runParamsRangesAgreeTests, PARAMS_RANGES_AGREE_CASE_COUNT } from './gen3/params-ranges-agree.test.js';
import { runEnumOverlayDeviceTruthTests, ENUM_OVERLAY_DEVICE_TRUTH_CASE_COUNT } from './gen3/enum-overlay-device-truth.test.js';
import { runSharedSeptetStreamTests, SHARED_SEPTETSTREAM_CASE_COUNT } from './shared/septetstream.test.js';
import { runSharedPollTimingTests, SHARED_POLLTIMING_CASE_COUNT } from './shared/polltiming.test.js';
import { runGen3VisualDataTests, GEN3_VISUALDATA_CASE_COUNT } from './gen3/visualdata.test.js';
import { runAm4VisualDataTests, AM4_VISUALDATA_CASE_COUNT } from './am4/visualdata.test.js';
import { runZipTests, ZIP_CASE_COUNT } from './shared/zip.test.js';
import { runXmlTests, XML_CASE_COUNT } from './shared/xml.test.js';
import { runFasBundleTests, FAS_BUNDLE_CASE_COUNT } from './gen3/fas-bundle.test.js';
import { runFasSetlistTests, FAS_SETLIST_CASE_COUNT } from './gen3/fas-setlists.test.js';
import { runSystemDumpTests, SYSTEM_DUMP_CASE_COUNT } from './gen3/system-dump.test.js';
import { runFullResIrTests, FULLRES_IR_CASE_COUNT } from './gen3/fullres-ir.test.js';
import { runPresetBodyRecordTests, PRESETBODY_RECORDS_CASE_COUNT } from './gen3/fm3/presetbody-records.test.js';
import { runPresetSynthTrailingTests, PRESET_SYNTH_TRAILING_CASE_COUNT } from './gen3/fm3/preset-synth-trailing.test.js';
import { runGen3WalkModel, GEN3_WALK_MODEL_CASE_COUNT } from './cache/gen3-walk-model.test.js';
import { runSpecialTables, SPECIAL_TABLES_CASE_COUNT } from './cache/special-tables.test.js';
import { runAm4DefinitionWalk, AM4_DEFINITION_WALK_CASE_COUNT } from './am4/definition-walk.test.js';

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
  { name: `shared/firmware (${FIRMWARE_CASE_COUNT} cases)`, run: runFirmwareTests },
  { name: `shared/firmwareTransfer (${FIRMWARE_TRANSFER_CASE_COUNT} cases)`, run: runFirmwareTransferTests },
  { name: `shared/queryFunctions (${QUERY_FUNCTIONS_CASE_COUNT} cases)`, run: runQueryFunctionsTests },
  { name: `am4/setparam (${AM4_GOLDEN_CASE_COUNT} goldens)`, run: runAm4SetParamTests },
{ name: `am4/cabname (${AM4_CABNAME_CASE_COUNT} cab-name cases)`, run: runAm4CabNameTests },
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
  { name: `axe-fx-iii/readPolls (${GEN3_READPOLLS_CASE_COUNT} byte-identity cases)`, run: runGen3ReadPollsTests },
{ name: `gen3/graphs (${GEN3_GRAPHS_CASE_COUNT} curve-channel cases)`, run: runGen3GraphsTests },
  { name: `axe-fx-iii/gridlayout (${GEN3_GRIDLAYOUT_CASE_COUNT} goldens)`, run: runGen3GridLayoutTests },
  { name: `modern-family/catalog (${MODERN_FAMILY_CASE_COUNT} goldens)`, run: runModernFamilyTests },
  { name: `modern-family/boundcodec (${BOUNDCODEC_CASE_COUNT} model bytes, full surface)`, run: runBoundCodecTests },
  { name: `fm3/meters (${FM3_METERS_CASE_COUNT} cases)`, run: runFm3MetersTests },
  { name: `fm3/blockparams (${FM3_BLOCKPARAMS_CASE_COUNT} live-FM3 preset goldens)`, run: runFm3BlockParamsTests },
  { name: `fm3/preset-author-ir (${PRESET_AUTHOR_IR_CASE_COUNT} offline round-trip)`, run: runPresetAuthorIrTests },
  { name: `fm3/walkblocks-count (${WALKBLOCKS_COUNT_CASE_COUNT} placed-block completeness cases)`, run: runWalkBlocksCountTests },
  { name: `fm3/preset-synth-ir (${PRESET_SYNTH_IR_CASE_COUNT} full-body synthesis round-trip)`, run: runPresetSynthIrTests },
  { name: `fm3/preset-synth-catalog (${PRESET_SYNTH_CATALOG_CASE_COUNT} geometry families, catalog/defaults build)`, run: runPresetSynthCatalogTests },
  { name: `gen3-synth-nonfm3 (${GEN3_SYNTH_NONFM3_CASE_COUNT} devices: FM9 + Axe-Fx III full-body synthesis round-trip)`, run: runGen3SynthNonFm3Tests },
  { name: `fm3/routing-roundtrip (${ROUTING_ROUNDTRIP_CASE_COUNT} grid route-flag cases)`, run: runRoutingRoundTripTests },
  { name: `modern-family/blockparams-cross (${CROSS_BLOCKPARAMS_CASE_COUNT} cross-device preset goldens)`, run: runCrossBlockParamsTests },
  { name: `gen3/default-raw-roundtrip (${DEFAULT_RAW_ROUNDTRIP_CASE_COUNT} models: FM3/FM9/III)`, run: runDefaultRawRoundTripTests },
  { name: `fm3/telemetry (${FM3_TELEMETRY_CASE_COUNT} live-FM3 frame goldens)`, run: runFm3TelemetryTests },
  { name: `gen3/roster (${FM3_ROSTER_CASE_COUNT} projection goldens)`, run: runGen3RosterTests },
  { name: `gen3/preset-validate (${PRESET_VALIDATE_CASE_COUNT} cases)`, run: runPresetValidateTests },
  { name: `gen3/empty-slot (${EMPTY_SLOT_CASE_COUNT} cases: empty preset slot + bounded Huffman tree)`, run: runEmptySlotTests },
  { name: `fm9/meters (${FM9_METERS_CASE_COUNT} cases)`, run: runFm9MetersTests },
  { name: `fm9/footcontroller (${FM9_FOOTCONTROLLER_CASE_COUNT} cases)`, run: runFm9FootControllerTests },
  { name: `fm9/modifiers (${FM9_MODIFIER_CASE_COUNT} cases)`, run: runFm9ModifierTests },
  { name: `axe-fx-iii/meters (${AXE3_METERS_CASE_COUNT} cases)`, run: runAxe3MetersTests },
  { name: `axe-fx-iii/footcontroller (${AXE3_FC_CASE_COUNT} cases)`, run: runAxe3FootControllerTests },
  { name: `axe-fx-iii/modifiers (${AXE3_MOD_CASE_COUNT} cases)`, run: runAxe3ModifierTests },
  { name: `axe-fx-iii/effect-ids (${AXE3_EFFECT_IDS_CASE_COUNT} cases)`, run: runAxe3EffectIdsTests },
  { name: `vp4/setparam (${VP4_SETPARAM_CASE_COUNT} goldens)`, run: runVp4SetParamTests },
  { name: `vp4/structureblob (${VP4_STRUCTUREBLOB_CASE_COUNT} goldens)`, run: runVp4StructureBlobTests },
  { name: `gen3/discrete-overlay (${DISCRETE_OVERLAY_CASE_COUNT} cases)`, run: runDiscreteOverlayTests },
  { name: `gen3/typename (${GEN3_TYPENAME_CASE_COUNT} goldens)`, run: runGen3TypeNameTests },
  { name: `gen3/params-ranges-agree (${PARAMS_RANGES_AGREE_CASE_COUNT} cases)`, run: runParamsRangesAgreeTests },
  { name: `gen3/enum-overlay-device-truth (${ENUM_OVERLAY_DEVICE_TRUTH_CASE_COUNT} cases)`, run: runEnumOverlayDeviceTruthTests },
  { name: `am4/internalFromDisplay (${AM4_INTERNAL_FROM_DISPLAY_CASE_COUNT} cases)`, run: runAm4InternalFromDisplayTests },
  { name: `axe-fx-ii/applicability (${AXEFX2_APPLICABILITY_CASE_COUNT} cases)`, run: runAxeFxIIApplicabilityTests },
  { name: `shared/displayScale (${SHARED_DISPLAYSCALE_CASE_COUNT} cases)`, run: runSharedDisplayScaleTests },
  { name: `shared/sysexAssembler (${SYSEX_ASSEMBLER_CASE_COUNT} inbound-fragment cases)`, run: runSysExAssemblerTests },
  { name: `devices/smoke (${DEVICES_SMOKE_CASE_COUNT} descriptors, from dist)`, run: runDevicesSmokeTests },
  { name: `cache/records (${RECORDS_CASE_COUNT} cases)`, run: runRecords },
  { name: `cache/assign (${ASSIGN_CASE_COUNT} oracle cases)`, run: runAssign },
  { name: `cache/assign-live (${ASSIGN_LIVE_CASE_COUNT} cases)`, run: runAssignLive },
  { name: `cache/buildprofile (${BUILDPROFILE_CASE_COUNT} cases)`, run: runBuildProfile },
  { name: `cache/am4 (${AM4_CACHE_CASE_COUNT} cases)`, run: runAm4Cache },
  { name: `cache/livewalk (${LIVEWALK_CASE_COUNT} cases)`, run: runLiveWalk },
  { name: `cache/livewalk-replies (${LIVEWALK_REPLIES_CASE_COUNT} cases)`, run: runLiveWalkReplies },
  { name: `cache/livewalk-slots (${LIVEWALK_SLOTS_CASE_COUNT} cases)`, run: runLiveWalkSlots },
  { name: `cache/livewalk-traffic (${LIVEWALK_TRAFFIC_CASE_COUNT} cases)`, run: runLiveWalkTraffic },
  { name: `cache/livewalk-bounds (${LIVEWALK_BOUNDS_CASE_COUNT} cases)`, run: runLiveWalkBounds },
  { name: `cache/livewalk-hints (${LIVEWALK_HINTS_CASE_COUNT} cases)`, run: runLiveWalkHints },
  { name: `cache/fullwalk (${FULLWALK_CASE_COUNT} cases)`, run: runFullWalk },
  { name: `cache/knobrule (${KNOBRULE_CASE_COUNT} cases)`, run: runKnobRule },
  { name: `cache/walkreplay (${WALKREPLAY_CASE_COUNT} device captures)`, run: runWalkReplay },
  { name: `cache/fingerprint (${FINGERPRINT_CASE_COUNT} cases)`, run: runFingerprint },
  { name: `cache/catalog-bridge (${CATALOG_BRIDGE_CASE_COUNT} cases, FM3 catalog vs fw 12.0 walk profile)`, run: runCatalogBridge },
  { name: `cache/redact (${REDACT_CASE_COUNT} cases)`, run: runRedact },
  { name: `cache/header (${CACHE_HEADER_CASE_COUNT} cases)`, run: runCacheHeader },
  { name: `cache/profile-doc (${PROFILE_DOC_CASE_COUNT} cases)`, run: runProfileDoc },
  { name: `cache/profile-sections (${PROFILE_SECTIONS_CASE_COUNT} cases)`, run: runProfileSections },
  { name: `cache/merge (${MERGE_CASE_COUNT} cases)`, run: runMerge },
  { name: `cache/typecode-rules (${TYPECODE_RULES_CASE_COUNT} cases, FM3/FM9/III catalogs)`, run: runTypecodeRules },
  { name: `cache/block-map (${BLOCK_MAP_CASE_COUNT} cases)`, run: runBlockMap },
  { name: `cache/livewalk-scope (${LIVEWALK_SCOPE_CASE_COUNT} cases)`, run: runLiveWalkScope },
  { name: `cache/share (${SHARE_CASE_COUNT} cases, sanitizer + fact hash goldens)`, run: runShare },
  { name: `cache/spot-check (${SPOT_CHECK_CASE_COUNT} cases, target selection + read-only runner)`, run: runSpotCheckSuite },
  { name: `editorLayouts (${EDITOR_LAYOUTS_CASE_COUNT} devices)`, run: runEditorLayoutsTests },
  { name: `editorLayouts/families (${EDITOR_LAYOUT_FAMILIES_CASE_COUNT} cases)`, run: runEditorLayoutFamiliesTests },
  { name: `gen3/crossblock-effectid (${CROSSBLOCK_EFFECTID_CASE_COUNT} cases)`, run: runCrossBlockEffectIdTests },
  { name: `scripts/gen-editor-layouts (${GEN_EDITOR_LAYOUTS_CASE_COUNT} cases)`, run: runGenEditorLayoutsTests },
  { name: `convert/families (${FAMILIES_CASE_COUNT} cases)`, run: runFamiliesTests },
  { name: `convert/gen3-adapter (${GEN3_ADAPTER_CASE_COUNT} preset goldens)`, run: runGen3AdapterTests },
  { name: `convert/adapters-shallow (${SHALLOW_ADAPTERS_CASE_COUNT} adapters)`, run: runShallowAdaptersTests },
  { name: `convert/concept-coverage (${CONCEPT_COVERAGE_CASE_COUNT} cases)`, run: runConceptCoverageTests },
  { name: `convert/lineage-index (${LINEAGE_INDEX_CASE_COUNT} cases)`, run: runLineageIndexTests },
  { name: `convert/engine (${ENGINE_CASE_COUNT} conversion cases)`, run: runEngineTests },
  { name: `convert/grid-eid (${CONVERT_GRID_EID_CASE_COUNT} cross-device fm3 eid-assignment)`, run: runConvertGridEidTests },
  { name: `convert/target-ranges (${TARGET_RANGES_CASE_COUNT} cases)`, run: runTargetRangesTests },
  { name: `convert/gen3-taper (${GEN3_TAPER_CASE_COUNT} cases)`, run: runGen3TaperTests },
  { name: `convert/enum-params (${ENUM_PARAMS_CASE_COUNT} cases)`, run: runEnumParamsTests },
  { name: `shared/serial-close (${SERIAL_CLOSE_CASE_COUNT} cases)`, run: runSerialCloseTests },
  { name: `gen3/presetbody-grid-guard (${GRID_GUARD_CASE_COUNT} cases)`, run: runGridGuardTests },
  { name: `gen3/live-grid-shunt (${LIVE_GRID_SHUNT_CASE_COUNT} cases)`, run: runLiveGridShuntTests },
  { name: `gen3/taper-decode (${TAPER_DECODE_CASE_COUNT} cases)`, run: runTaperDecodeTests },
  { name: `shared/septetStream (${SHARED_SEPTETSTREAM_CASE_COUNT} cases)`, run: runSharedSeptetStreamTests },
  { name: `shared/pollTiming (${SHARED_POLLTIMING_CASE_COUNT} cases)`, run: runSharedPollTimingTests },
  { name: `gen3/visualData (${GEN3_VISUALDATA_CASE_COUNT} cases)`, run: runGen3VisualDataTests },
  { name: `am4/visualData (${AM4_VISUALDATA_CASE_COUNT} cases)`, run: runAm4VisualDataTests },
  { name: `shared/zip (${ZIP_CASE_COUNT} cases)`, run: runZipTests },
  { name: `shared/xml (${XML_CASE_COUNT} cases)`, run: runXmlTests },
  { name: `gen3/fasBundle (${FAS_BUNDLE_CASE_COUNT} cases)`, run: runFasBundleTests },
  { name: `gen3/fasSetlists (${FAS_SETLIST_CASE_COUNT} cases)`, run: runFasSetlistTests },
  { name: `gen3/systemDump (${SYSTEM_DUMP_CASE_COUNT} cases)`, run: runSystemDumpTests },
  { name: `gen3/fullResIr (${FULLRES_IR_CASE_COUNT} cases)`, run: runFullResIrTests },
  { name: `fm3/presetbody-records (${PRESETBODY_RECORDS_CASE_COUNT} prelude/chain record cases)`, run: runPresetBodyRecordTests },
  { name: `fm3/preset-synth-trailing (${PRESET_SYNTH_TRAILING_CASE_COUNT} trailing-boundary cases)`, run: runPresetSynthTrailingTests },
  { name: `cache/gen3-walk-model (${GEN3_WALK_MODEL_CASE_COUNT} cases)`, run: runGen3WalkModel },
  { name: `cache/special-tables (${SPECIAL_TABLES_CASE_COUNT} cases)`, run: runSpecialTables },
  { name: `am4/definition-walk (${AM4_DEFINITION_WALK_CASE_COUNT} read-only cases)`, run: runAm4DefinitionWalk },
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
