/**
 * MIDI byte-stream framer for serial (USB-CDC) transports.
 *
 * The FM3 exposes no USB-MIDI interface on any OS — its control channel is a
 * CDC serial device carrying a RAW MIDI byte stream (community-collaborator
 * hardware finding: captured editor SysEx replayed verbatim over the serial
 * device commits on the FM3). A serial read gives arbitrary chunk boundaries:
 * one chunk may hold half a SysEx frame, or three frames back-to-back. This
 * framer turns that stream into the one-complete-message-per-dispatch
 * contract the rest of the transport layer assumes (same contract as
 * `createSysExAssembler`, which handles the narrower WinMM fragment case).
 *
 * Pure function — no serialport dependency — so the framing logic is provable
 * in tests without hardware (`scripts/verify-serial-framer.ts`).
 *
 * Handled per the MIDI byte grammar:
 *   - SysEx: F0 … F7, split across any number of chunks, any boundary.
 *   - Realtime bytes (F8..FF) may legally interleave INSIDE a SysEx frame;
 *     they are emitted as their own 1-byte message without breaking assembly.
 *   - Channel messages (80..EF) with running status; system common (F1..F6).
 *   - A status byte other than realtime appearing mid-SysEx aborts the
 *     unterminated frame (malformed input is dropped, never half-emitted).
 *   - Stray data bytes with no governing status are dropped.
 */

function channelMessageDataLength(status: number): number {
  const hi = status & 0xf0;
  return hi === 0xc0 || hi === 0xd0 ? 1 : 2;
}

function systemCommonDataLength(status: number): number {
  switch (status) {
    case 0xf1: return 1; // MTC quarter frame
    case 0xf2: return 2; // song position
    case 0xf3: return 1; // song select
    default: return 0;   // F4/F5 undefined, F6 tune request
  }
}

export function createSerialMidiFramer(
  dispatch: (bytes: number[]) => void,
): (chunk: Uint8Array | readonly number[]) => void {
  let sysex: number[] | undefined;
  let pending: number[] | undefined; // channel/common message under assembly
  let pendingLength = 0; // expected data-byte count for `pending`
  let runningStatus: number | undefined;

  const finishPendingIfComplete = (): void => {
    if (pending !== undefined && pending.length === 1 + pendingLength) {
      dispatch(pending);
      pending = undefined;
    }
  };

  return (chunk: Uint8Array | readonly number[]): void => {
    for (const byte of chunk) {
      if (byte >= 0xf8) {
        // Realtime: emit immediately; never disturbs SysEx or running status.
        dispatch([byte]);
        continue;
      }
      if (sysex !== undefined) {
        if (byte === 0xf7) {
          sysex.push(byte);
          dispatch(sysex);
          sysex = undefined;
        } else if (byte < 0x80) {
          sysex.push(byte);
        } else {
          // Non-realtime status mid-SysEx: malformed — drop the partial
          // frame and reprocess this byte as a fresh message start.
          sysex = undefined;
          if (byte === 0xf0) {
            runningStatus = undefined;
            sysex = [0xf0];
          } else if (byte >= 0x80 && byte <= 0xef) {
            pending = [byte];
            pendingLength = channelMessageDataLength(byte);
            runningStatus = byte;
          } else if (byte >= 0xf1 && byte <= 0xf6) {
            runningStatus = undefined;
            pending = [byte];
            pendingLength = systemCommonDataLength(byte);
            finishPendingIfComplete();
          }
        }
        continue;
      }
      if (byte === 0xf0) {
        // System exclusive cancels running status (MIDI 1.0 spec).
        pending = undefined;
        runningStatus = undefined;
        sysex = [0xf0];
        continue;
      }
      if (byte === 0xf7) {
        // Stray EOX with no open SysEx: malformed input. Drop it (never
        // dispatch it as data) and cancel running status so following
        // data bytes can't be mis-framed onto a stale channel status.
        pending = undefined;
        runningStatus = undefined;
        continue;
      }
      if (byte >= 0x80 && byte <= 0xef) {
        pending = [byte];
        pendingLength = channelMessageDataLength(byte);
        runningStatus = byte;
        continue;
      }
      if (byte >= 0xf1 && byte <= 0xf6) {
        runningStatus = undefined;
        pending = [byte];
        pendingLength = systemCommonDataLength(byte);
        finishPendingIfComplete();
        continue;
      }
      // Data byte.
      if (pending !== undefined) {
        pending.push(byte);
        finishPendingIfComplete();
      } else if (runningStatus !== undefined) {
        pending = [runningStatus, byte];
        pendingLength = channelMessageDataLength(runningStatus);
        finishPendingIfComplete();
      }
      // else: stray data byte with no status — dropped.
    }
  };
}
