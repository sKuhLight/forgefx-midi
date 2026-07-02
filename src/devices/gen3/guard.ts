/**
 * Modern Fractal family — safe-edit dirty/save gate.
 *
 * `makeGuard` returns the `guardActiveBufferOrSave` adapter bound to one
 * device's codec (model byte) + connection label. It uses the device-
 * scoped connection (`ctx.conn`), not a module-global handle, so the
 * gate is correct per device.
 *
 * Dirty classification is device-sourced (STATE_BROADCAST inbound) plus
 * an outbound belt-and-suspenders markDirty on edit-class SysEx wired in
 * `midi.ts`. The outbound markDirty fires on EVERY device, so the gate is
 * live on FM3/FM9 after the first edit — it is NOT inert. What keeps FM
 * safe is `supportsSave`: when a device's save persistence is not yet
 * hardware-verified (true for III/FM3/FM9), the gate NEVER auto-emits the
 * store op (`fn=0x01 sub=0x26`, wire-confirmed but persistence-unverified) in
 * `save_active_first`; it refuses and tells the caller to discard or save on
 * the front panel. See `docs/devices/axe-fx-iii/dirty-state-research.md` for
 * the III evidence.
 */
import type { DispatchCtx } from '../../core/protocol-generic/types.js';
import { isDirty } from '../../core/server-shared/bufferDirty.js';
import type {
  OnEditedMode,
  DirtyGuardResult,
} from '../../core/server-shared/safeEdit.js';
import type { ModernFractalCodec } from '../../gen3/axe-fx-iii/index.js';

export function makeGuard(opts: {
  codec: ModernFractalCodec;
  connectionLabel: string;
  deviceLabel: string;
  getResponseTimeoutMs: number;
  /** Whether the device's STORE envelope is spec-supported. When false
   *  (III/FM3/FM9), `save_active_first` refuses rather than auto-emit the
   *  persistence-unverified store op (fn=0x01 sub=0x26) at the device. */
  supportsSave: boolean;
}): (ctx: DispatchCtx, mode: OnEditedMode) => Promise<DirtyGuardResult> {
  const { codec, connectionLabel, deviceLabel, getResponseTimeoutMs, supportsSave } = opts;
  return async function guardActiveBufferOrSave(ctx, mode): Promise<DirtyGuardResult> {
    if (!isDirty(connectionLabel)) {
      return { proceed: true };
    }
    if (mode === 'discard') {
      return { proceed: true };
    }
    // Save persistence is not yet hardware-verified for any current
    // modern-Fractal device, so never auto-emit the store op (fn=0x01
    // sub=0x26) during navigation. The explicit save_preset tool still
    // attempts it (with its own beta warning); the safe-edit auto-save does not.
    if (mode === 'save_active_first' && !supportsSave) {
      return {
        proceed: false,
        warningText:
          `${deviceLabel} has unsaved working-buffer edits, but automatic save is not ` +
          `available on this device (its STORE envelope is unverified / not in the ` +
          `published spec). Save on the device front panel, then retry — or pass ` +
          `on_active_preset_edited="discard" to navigate and lose the edits.`,
      };
    }
    const c = ctx.conn;
    let presetNumber: number | undefined;
    let presetName: string | undefined;
    try {
      const respPromise = c.receiveSysExMatching(
        (b) => codec.isQueryPatchNameResponse(b),
        getResponseTimeoutMs,
      );
      c.send(codec.buildQueryPatchName('current'));
      const resp = await respPromise;
      const parsed = codec.parseQueryPatchNameResponse(resp);
      presetNumber = parsed.presetNumber;
      presetName = parsed.name.trim() || undefined;
    } catch {
      presetNumber = undefined;
    }
    const activeDescriptor = presetNumber !== undefined
      ? `preset ${presetNumber}${presetName ? ` ("${presetName}")` : ''}`
      : 'the currently active preset';

    if (mode === 'warn') {
      const saveLine = supportsSave
        ? `  • "save first" → call again with on_active_preset_edited="save_active_first".\n`
        : `  • "save first" → save on the device front panel, then retry (automatic save ` +
          `is not available on this beta device).\n`;
      return {
        proceed: false,
        warningText:
          `REFUSING TO NAVIGATE: ${activeDescriptor} has unsaved working-buffer edits on ` +
          `${deviceLabel}.\n\n` +
          `Navigating away would DISCARD those edits silently. Ask the user how to proceed:\n` +
          saveLine +
          `  • "discard"   → call again with on_active_preset_edited="discard".`,
      };
    }

    // save_active_first
    if (presetNumber === undefined) {
      return {
        proceed: false,
        warningText:
          `Could not read the active preset number; refusing to navigate to avoid losing ` +
          `edits silently. Try reconnect_midi, then retry, or save manually on the front panel.`,
      };
    }
    try {
      const errorPromise = c
        .receiveSysExMatching((b) => codec.isMultipurposeResponse(b), 250)
        .catch(() => undefined as number[] | undefined);
      c.send(codec.buildStorePreset(presetNumber));
      const errorFrame = await errorPromise;
      if (errorFrame) {
        const { resultCode } = codec.parseMultipurposeResponse(errorFrame);
        const label = codec.describeMultipurposeResultCode(resultCode) ?? '(unknown code)';
        return {
          proceed: false,
          warningText:
            `Save failed: ${deviceLabel} rejected STORE_PRESET to ${activeDescriptor} with ` +
            `result_code=0x${resultCode.toString(16).padStart(2, '0').toUpperCase()} (${label}). ` +
            `Edits NOT saved; refusing to navigate. Pass on_active_preset_edited="discard" to ` +
            `lose them anyway, or save manually on the device front panel.`,
        };
      }
      return {
        proceed: true,
        savedSlot: presetNumber,
        savedDetail: `Saved working buffer to ${activeDescriptor} before navigating ` +
          `(🟡 via the fn=0x01 sub=0x26 store op; confirm on the device front panel).`,
      };
    } catch (err) {
      return {
        proceed: false,
        warningText:
          `Save attempt failed: ${err instanceof Error ? err.message : String(err)}. ` +
          `Refusing to navigate. Pass on_active_preset_edited="discard" to proceed without saving.`,
      };
    }
  };
}
