// Axe-Fx II wire-byte → opcode-name vocabulary.
//
// Source: AxeEdit II `OpcodeDescriptor` struct in `.rdata`, mined via
// `scripts/ghidra/DumpAxeEditIIOpcodeTable.java`. The
// generator script lives in mcp-midi-control at
// `scripts/_research/axeedit2-opcode-map.ts`; output committed to
// `docs/devices/axe-fx-ii/axeedit-opcode-table.md`.
//
// To regenerate after an AxeEdit binary refresh:
//   1. From this repo: scripts\ghidra\run-axeedit2-full-analyze.cmd
//   2. Re-run scripts/ghidra/DumpAxeEditIIOpcodeTable.java via the
//      headless launcher (output: samples/captured/decoded/
//      ghidra-axeedit2-opcode-map.txt).
//   3. In the consumer repo, run npx tsx
//      scripts/_research/axeedit2-opcode-map.ts to emit the corrected
//      wire-byte enum (the generator applies wire = enum - 1; don't
//      subtract by hand).
//   4. Replace the AXE_FX_II_OPCODES block below.

/**
 * Every SysEx function-byte AxeEdit II recognizes on the wire.
 *
 * Names come from AxeEdit's internal `SYSEX_*` enum (stripped of the
 * SYSEX_ prefix). The wiki's per-byte names are different in places
 * (e.g. AxeEdit `PARAM_SET` ≡ wiki `SET_BLOCK_PARAMETER_VALUE`) but
 * refer to the same wire envelope. Where wiki and AxeEdit conflict on
 * a wire byte AND we have a live Q8.02 capture (15+ opcodes), AxeEdit
 * wins.
 *
 * Status: 🟢 wire bytes confirmed against live captures for every
 * opcode we use; remaining opcodes are decoded structurally (the
 * enum-value-to-wire-byte mapping is uniformly `-1` across the table)
 * but have no live wire verification yet.
 */
export const AXE_FX_II_OPCODES = {
  WHO_AM_I: 0x00,
  PARAM_DUMP: 0x01,
  PARAM_SET: 0x02,
  PATCH_DUMP: 0x03,
  PATCH_RCV: 0x04,
  PLACE_EFFECT: 0x05,
  CONNECT_EFFECT: 0x06,
  MODIFIER_SET: 0x07,
  QUERY_VERSION: 0x08,
  SET_NAME: 0x09,
  CABIR_RCV: 0x0a,
  CHECKSUM: 0x0b,
  SET_GRID: 0x0c,
  TUNER: 0x0d,
  QUERY_STATES: 0x0e,
  QUERY_NAME: 0x0f,
  TEMPO: 0x10,
  CABNAME: 0x12,
  CPU_LOAD: 0x13,
  PATCHNUM: 0x14,
  QUERY_NAME_BY_NUM: 0x15,
  GET_PARAM_INFO: 0x16,
  GET_MIDI_CHANNEL: 0x17,
  GET_MODIFIER_INFO: 0x18,
  CAB_DUMP: 0x19,
  GLOBAL_BLOCK_USED: 0x1a,
  GLOBAL_PATCH: 0x1b,
  BANK_DUMP: 0x1c,
  SAVE_PATCH: 0x1d,
  SET_BYPASS: 0x1e,
  GET_ALL_PARAMS: 0x1f,
  GET_GRID: 0x20,
  RESYNC: 0x21,
  SET_DEFAULTS: 0x22,
  LOOPER_STATE: 0x23,
  MOVE_EFFECT: 0x24,
  FW_UPDATE: 0x25,
  FPGA_UPDATE: 0x26,
  MICRO_UPDATE: 0x27,
  GET_PARAM_STRINGS: 0x28,
  SET_SCENE: 0x29,
  GET_FLAGS: 0x2a,
  MODIFIER_DUMP: 0x2b,
  MODIFIER: 0x2c,
  SET_CAB_NAME: 0x2d,
  SET_PARAM_DIRECT: 0x2e,
  GET_GRAPH: 0x30,
  TM_DATA: 0x31,
  MULTIMSG_START: 0x32,
  MULTIMSG_END: 0x33,
  ERASE_SECTOR: 0x34,
  GET_CONFIG: 0x35,
  GET_GRAPHN: 0x36,
  EDIT_EFFECT: 0x37,
  BROADCAST_KNOB: 0x38,
  BROADCAST_MODIFIER: 0x39,
  GET_POSITION: 0x3a,
  SET_MODPARAM_DIRECT: 0x3b,
  RECALL_PATCH: 0x3d,
  MUTE: 0x3e,
  SET_IRCAP_NAME: 0x3f,
  CONTROL_IRCAP: 0x40,
  DELETE_CABIR: 0x41,
  EDITOR_DISCONNECT: 0x42,
  DUMP_SYSTEM: 0x43,
  CAB_BANK_DUMP: 0x44,
  LAYOUT_SET: 0x45,
  PATCH_PLUS_CAB_DUMP: 0x46,
  GET_SYSINFO: 0x47,
  FW_UPDATE_END: 0x60,
  SYSTEM_DATA_START: 0x61,
  SYSTEM_DATA: 0x62,
  FSGRID: 0x63,
  CABIR_END: 0x66,
  RAWIR_START: 0x67,
  RAWIR_DATA: 0x68,
  STATUS_MSG: 0x69,
  FPGA_UPDATE_START: 0x6a,
  FPGA_UPDATE_DATA: 0x6b,
  FPGA_UPDATE_END: 0x6c,
  MICRO_UPDATE_START: 0x6d,
  MICRO_UPDATE_DATA: 0x6e,
  MICRO_UPDATE_END: 0x73,
  EFFECT_START: 0x74,
  EFFECT_DATA: 0x75,
  EFFECT_END: 0x76,
  PATCH_START: 0x77,
  PATCH_DATA: 0x78,
  PATCH_END: 0x79,
  CABIR_START: 0x7a,
  CABIR_DATA: 0x7b,
  RAWIR_END: 0x7c,
  FW_UPDATE_START: 0x7d,
  FW_UPDATE_DATA: 0x7e,
} as const;

/** Reverse map: wire byte → opcode name. Useful for parser logging. */
export const AXE_FX_II_OPCODE_NAMES: Readonly<Record<number, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(AXE_FX_II_OPCODES).map(([name, byte]) => [byte, name]),
    ),
  );

export type AxeFxIIOpcode = keyof typeof AXE_FX_II_OPCODES;

/**
 * Wire byte AxeEdit II does NOT have an opcode entry for, but our
 * codec uses based on direct hardware verification. The most notable
 * is `SWITCH_PRESET = 0x3C` (MSB-first preset
 * load), which AxeEdit handles through a different code path than
 * the SYSEX_* enum table. Keep these alongside the generated map so
 * callers see them as legitimate wire bytes.
 */
export const AXE_FX_II_LEGACY_OPCODES = {
  /** Set preset number / "switch to preset N". Confirmed wire byte
   *  0x3C on Q8.02. MSB-first preset number
   *  encoding. See setParam.ts buildSwitchPreset(). */
  SWITCH_PRESET: 0x3c,
  /** Block channel select X/Y (function 0x11). Wire byte not present
   *  in AxeEdit's SYSEX_* enum (gap between TEMPO=0x10 and
   *  CABNAME=0x12), but confirmed wire-active on Q8.02. See
   *  setParam.ts buildSetBlockChannel(). */
  BLOCK_CHANNEL: 0x11,
  /** Multipurpose response envelope (function 0x64) the device emits
   *  to acknowledge writes like STORE_PRESET (0x1D), SET_GRID_CELL
   *  (0x05), and SET_CELL_ROUTING (0x06). Wire byte not present in
   *  AxeEdit's SYSEX_* enum (FSGRID sits at wire 0x63), but the
   *  response shape is hardware-verified on Q8.02 (Sessions 61, 63,
   *  70). See setParam.ts isStorePresetResponse() et al. */
  MULTIPURPOSE_RESPONSE: 0x64,
} as const;
