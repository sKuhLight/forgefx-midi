/**
 * AM4 byte-exact preset restore (push) — backs the unified `apply_preset`
 * restore mode via `DeviceWriter.restorePresetBinary`.
 *
 * Pushes a 12,352-byte preset dump (produced by `export_preset`) back to the
 * device's WORKING BUFFER as a verbatim 6-message replay (the dump header
 * carries the active-buffer sentinel 0x7F/0x00, so it targets the working
 * buffer). `parsePresetDump` validates every envelope + checksum before any
 * byte hits the wire.
 *
 * Restore-to-stored-location is NOT supported yet: re-targeting the dump to a
 * stored A01..Z04 needs the stored-preset header encoding that is still
 * undecoded (HW-045). A working-buffer restore + a manual save is the path
 * until that capture lands.
 */
import type {
  DispatchCtx,
  LocationRef,
  RestorePresetResult,
} from '../../../core/protocol-generic/types.js';
import { DispatchError } from '../../../core/protocol-generic/types.js';

import { parsePresetDump, PRESET_DUMP_LEN } from '../presetDump.js';
import { markDirty } from '../../../core/server-shared/bufferDirty.js';
import { AM4_DIRTY_LABEL } from '../tools/safeEdit.js';

const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRAME_COUNT = 6; // header + 4 chunks + footer
const INTER_FRAME_MS = 15;
const SETTLE_MS = 400;
const DEVICE_LABEL = 'Fractal AM4';

function splitSysEx(bytes: Uint8Array): number[][] {
  const messages: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== SYSEX_START) { i++; continue; }
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== SYSEX_END) j++;
    if (j >= bytes.length) break;
    messages.push(Array.from(bytes.slice(i, j + 1)));
    i = j + 1;
  }
  return messages;
}

export async function restorePresetBinaryAm4(
  ctx: DispatchCtx,
  bytes: Uint8Array,
  options?: { target_location?: LocationRef; save_authorized?: boolean },
): Promise<RestorePresetResult> {
  if (bytes.length !== PRESET_DUMP_LEN) {
    throw new DispatchError(
      'value_out_of_range',
      DEVICE_LABEL,
      `apply_preset restore: AM4 preset binary must be ${PRESET_DUMP_LEN} bytes; got ${bytes.length}. ` +
        `Pass the .syx that export_preset wrote for THIS device (an Axe-Fx II or other-model dump will not fit).`,
    );
  }
  if (options?.save_authorized && options?.target_location !== undefined) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `apply_preset restore to a STORED location is not supported on AM4 yet: the stored-preset header encoding is undecoded. ` +
        `Restore to the working buffer (omit save_authorized / target_location), then save on the device, or via the editor.`,
    );
  }
  // Validates every envelope + per-frame checksum; throws on corruption.
  parsePresetDump(bytes);

  const messages = splitSysEx(bytes);
  if (messages.length !== FRAME_COUNT) {
    throw new DispatchError(
      'value_out_of_range',
      DEVICE_LABEL,
      `apply_preset restore: AM4 preset binary parsed to ${messages.length} SysEx messages; expected ${FRAME_COUNT}.`,
    );
  }

  // Verbatim replay of the 6-message stream to the working buffer.
  const responses: number[][] = [];
  const unsub = ctx.conn.onMessage((b) => { if (b[0] === SYSEX_START) responses.push([...b]); });
  for (const m of messages) {
    ctx.conn.send(m);
    await new Promise((r) => setTimeout(r, INTER_FRAME_MS));
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  unsub();

  // The replay pushes 6 frames into the working buffer, so on a real
  // restore the buffer no longer matches flash → dirty. But the replay
  // is fire-and-forget (no per-frame ack-await); only mark dirty if the
  // device echoed at least one frame per sent frame. A silent/dead handle
  // leaves the flag clean (fail-safe: no false "edited" refusal over a
  // restore that never landed).
  const allFramesEchoed = responses.length >= messages.length;
  if (allFramesEchoed) {
    markDirty(AM4_DIRTY_LABEL);
  }

  return {
    ok: messages.length === FRAME_COUNT,
    frames_sent: messages.length,
    acks_received: responses.length,
    nacks: [],
    format: 'am4-preset-dump',
  };
}
