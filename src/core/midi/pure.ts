/**
 * Pure (browser-safe) half of the generic MIDI transport layer.
 *
 * Everything here is plain JS — connection/port type contracts, the
 * SysEx reassembler, the mock connection, and hex formatting. The
 * node-midi-backed `connect()` / `listMidiPorts()` live in
 * `transport.ts`, which re-exports this module so existing Node
 * consumers keep their import paths.
 *
 * Split out so descriptor-layer modules (message describers, wire ops,
 * the connection registry) can be bundled for the browser (Axis Browser
 * Direct) without dragging in `node:module` / native bindings.
 */

export interface MidiConnection {
  send: (bytes: number[]) => void;
  /**
   * Last error thrown by the underlying `output.sendMessage` call, or
   * `undefined` if the most recent send succeeded. node-midi's WinMM
   * backend prints `MidiOutWinMM::sendMessage: error sending sysex
   * message` to stderr and silently fails on a stale handle, which
   * leaves the tool reporting "success" while 0/22 chunks land. Tools
   * doing multi-message dumps (Hydrasynth patch, AM4 apply_preset)
   * read this after each send to bail loudly on the first failure
   * instead of looping through 22 broken writes.
   */
  lastSendError?: Error;
  /** Resolves with the next inbound SysEx message, or rejects on timeout. */
  receiveSysEx: (timeoutMs?: number) => Promise<number[]>;
  /**
   * Wait for the first inbound SysEx that satisfies `predicate`. Non-matching
   * messages are silently dropped until `timeoutMs` elapses. Register BEFORE
   * the outgoing write so the response can't race ahead of the listener.
   */
  receiveSysExMatching: (
    predicate: (bytes: number[]) => boolean,
    timeoutMs?: number,
  ) => Promise<number[]>;
  /**
   * Subscribe to ALL inbound messages (SysEx + non-SysEx). Returns an
   * unsubscribe function. When `hasInput` is false (no input port found),
   * the handler is registered but will never fire — diagnostic tools that
   * report "n messages observed" stay safe to call.
   */
  onMessage: (handler: (bytes: number[]) => void) => () => void;
  /**
   * True when an input port was successfully opened. Diagnostic surfaces
   * (the inbound-capture timeline in `apply_preset` / `set_param` / etc.)
   * read this flag so they can say "no input port — capture is empty by
   * construction" instead of silently reporting an empty timeline.
   */
  hasInput: boolean;
  close: () => void;
}

/**
 * Build a stateful SysEx reassembler. node-midi's WinMM backend hands
 * each MIM_LONGDATA buffer up as its own `message` event, so any SysEx
 * longer than RT_SYSEX_BUFFER_SIZE (1024 bytes — RtMidi.cpp:2467)
 * arrives split across multiple callbacks. AM4 preset-dump chunks
 * (3082 bytes) and Axe-Fx II preset bodies are both bigger than that.
 * Downstream parsers (presetDump.ts assertDumpMessageShape,
 * receiveSysExMatching, every device's response parser) assume one
 * F0…F7 message per emit — this glues fragments back together so the
 * assumption holds.
 *
 * Returned function is the inbound seam: feed every raw `message`
 * callback through it; it emits to `dispatch` once a fragment ends
 * in F7 (or immediately for any non-SysEx fragment, which short MIDI
 * messages always are).
 *
 * Edge cases:
 *   - Short MIDI (3-byte note/CC/PC) bypasses the accumulator —
 *     the first byte is a non-F0 status, so it ships straight through.
 *   - Complete SysEx in a single fragment (F0…F7, length ≤ 1024)
 *     also bypasses the accumulator. Fast path.
 *   - A fragment with F7 mid-buffer (rare on WinMM but legal MIDI)
 *     is split at the F7: prefix is emitted as the completed message,
 *     trailing bytes open a new accumulation if they start with F0.
 *
 * Serial byte streams use `createSerialMidiFramer` (serialFraming.ts)
 * instead — the two stay separate deliberately: the input contracts
 * (node-midi message-shaped fragments vs a raw byte stream) and
 * malformed-input behavior differ, so neither can substitute for the
 * other.
 *
 * Exported for unit testing so we don't need a live MIDI port to
 * prove the reassembly is correct.
 */
export function createSysExAssembler(
  dispatch: (bytes: number[]) => void,
): (fragment: number[]) => void {
  let accumulator: number[] | undefined;
  return (bytes: number[]): void => {
    if (bytes.length === 0) return;
    const startsWithF0 = bytes[0] === 0xf0;
    const endsWithF7 = bytes[bytes.length - 1] === 0xf7;

    // Fast path: complete SysEx in one fragment, or a non-SysEx
    // short message. Nothing to assemble.
    if (accumulator === undefined && startsWithF0 && endsWithF7) {
      dispatch(bytes);
      return;
    }
    if (accumulator === undefined && !startsWithF0) {
      dispatch(bytes);
      return;
    }

    // Open or continuing SysEx fragment.
    if (accumulator === undefined && startsWithF0) {
      accumulator = bytes.slice();
    } else if (accumulator !== undefined) {
      for (const b of bytes) accumulator.push(b);
    }

    // Drain on any F7. Handle F7-in-middle by splitting (defensive).
    if (accumulator !== undefined && endsWithF7) {
      const f7Index = accumulator.lastIndexOf(0xf7);
      const complete = accumulator.slice(0, f7Index + 1);
      const trailing = accumulator.slice(f7Index + 1);
      accumulator = undefined;
      dispatch(complete);
      if (trailing.length > 0 && trailing[0] === 0xf0) {
        if (trailing[trailing.length - 1] === 0xf7) {
          dispatch(trailing);
        } else {
          accumulator = trailing;
        }
      }
    }
  };
}

export interface MidiPortInfo {
  index: number;
  name: string;
  direction: 'input' | 'output';
  /** True when this port's name matched one of the supplied needles. */
  matched: boolean;
}

export interface ConnectOptions {
  /**
   * Case-insensitive substrings; the first port whose name contains any
   * needle wins. Bidirectional — applied to both inputs and outputs.
   */
  needles: readonly string[];
  /**
   * Optional first line of the "not found" error. Defaults to a generic
   * `No MIDI port matching ...` message; device-specific callers override
   * it (e.g. AM4 uses `AM4 not found in the MIDI device list.`).
   */
  notFoundLeadIn?: string;
  /**
   * Optional install / driver hints appended to the "not found" error.
   * AM4 callers pass driver download + AM4-Edit exclusivity warnings;
   * generic callers usually leave this empty.
   */
  notFoundHints?: string[];
}

/**
 * Synthesize zero-or-more inbound SysEx messages in response to one
 * outgoing message. Returned arrays are delivered to the connection's
 * `onMessage` handlers (and therefore to any pending `receiveSysEx*`
 * waiters) asynchronously, after a configurable latency.
 *
 * Per-device implementations live alongside each device's `midi.ts` —
 * AM4 produces SET_PARAM write-echos and command-acks, Axe-Fx II
 * produces parameter-value responses, etc. The core knows nothing
 * about any protocol; it just wires the synthesizer into the
 * connection.
 */
export type MockResponder = (outgoing: number[]) => number[][];

/**
 * Shared `receiveSysEx` / `receiveSysExMatching` promise construction
 * for the node-midi-backed connections (`connect`, `mockConnect`):
 * register a predicate handler on the shared handler set, race it
 * against a timeout, clean up on either outcome.
 *
 * Pre-observes the rejection (same hardening as serialTransport's
 * `makeReceiver`): callers that register a receiver FIRST and send()
 * SECOND (the standard register-before-write pattern) abandon this
 * promise when send() throws synchronously — without the no-op catch
 * handler, that abandoned rejection is an unhandledRejection and Node
 * KILLS THE WHOLE SERVER PROCESS. Awaiting callers still receive the
 * rejection normally.
 */
export function makeSysExReceiver(
  handlers: Set<(bytes: number[]) => void>,
  predicate: (bytes: number[]) => boolean,
  timeoutMs: number,
  timeoutLabel: string,
): Promise<number[]> {
  const p = new Promise<number[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      handlers.delete(handler);
      reject(new Error(`${timeoutLabel} after ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (bytes: number[]) => {
      if (bytes[0] !== 0xf0) return;
      if (!predicate(bytes)) return;
      clearTimeout(timer);
      handlers.delete(handler);
      resolve(bytes);
    };
    handlers.add(handler);
  });
  p.catch(() => { /* observed; real handling happens at the await site */ });
  return p;
}

export interface MockConnectOptions {
  /** Device-specific response synthesizer. Receives every outbound message; returns inbound responses to inject. */
  responder: MockResponder;
  /** Simulated ack latency in ms. Default 30 (matches AM4 typical). */
  ackLatencyMs?: number;
}

/**
 * Mock MidiConnection — accepts writes without touching USB and feeds
 * synthesized responses back through the same onMessage / receiveSysEx*
 * channels real connections use. Per the 2026 MCP community pattern
 * ("mock transport" — Fastio MCP testing guide), this replaces the
 * lowest dependency layer with a deterministic stub while leaving the
 * device dispatcher, schema validation, and encoding pipeline intact.
 *
 * Caller enables via env var on the device-specific connectXXX wrapper:
 *
 *   if (process.env.MCP_MOCK_TRANSPORT === '1') return mockConnect({
 *     responder: am4MockResponder,
 *   });
 *
 * Agent-regression cases that don't have hardware plugged in flip this
 * flag and all set_param / apply_preset / etc. tools execute end-to-end
 * against the in-memory mock — same code paths as the real device,
 * minus the USB layer.
 */
export function mockConnect(opts: MockConnectOptions): MidiConnection {
  const handlers = new Set<(bytes: number[]) => void>();
  const ackLatencyMs = opts.ackLatencyMs ?? 30;
  const sendErrCell: { value?: Error } = {};

  const deliver = (bytes: number[]): void => {
    // Snapshot handlers — handler may unsubscribe itself during delivery.
    const snapshot = Array.from(handlers);
    for (const h of snapshot) h([...bytes]);
  };

  const send = (bytes: number[]): void => {
    sendErrCell.value = undefined;
    const responses = opts.responder([...bytes]);
    // Deliver after the simulated latency so receiveSysExMatching's
    // ordering matches real hardware (the writer registers the
    // predicate before send returns).
    if (responses.length > 0) {
      setTimeout(() => {
        for (const r of responses) deliver(r);
      }, ackLatencyMs);
    }
  };

  return {
    send,
    get lastSendError(): Error | undefined { return sendErrCell.value; },
    receiveSysEx: (timeoutMs = 1000) =>
      makeSysExReceiver(handlers, () => true, timeoutMs, 'Timeout waiting for SysEx response'),
    receiveSysExMatching: (predicate, timeoutMs = 1000) =>
      makeSysExReceiver(handlers, predicate, timeoutMs, 'Timeout waiting for matching SysEx'),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    hasInput: true,
    close: () => { handlers.clear(); },
  };
}

export function toHex(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? Array.from(bytes) : bytes;
  return arr.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
