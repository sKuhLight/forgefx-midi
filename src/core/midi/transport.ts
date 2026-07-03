/**
 * Generic MIDI transport — port enumeration + open/connect wrapper around
 * node-midi. Device-agnostic; used by every device package and the
 * generic-MIDI primitive tools (`send_cc`, `send_note`, …).
 *
 * Wraps node-midi to:
 *   - find a port by name-substring match
 *   - enable SysEx (off by default in node-midi)
 *   - return promises for clean async/await usage
 *
 * Caller must call `close()` to release ports.
 *
 * Device-specific connector wrappers (e.g. `connectAM4`,
 * `connectAxeFxII`) live in their device packages and delegate to
 * `connect()` here with device-specific needles + onboarding hints.
 *
 * The pure (browser-safe) half — connection/port types, the SysEx
 * reassembler, `mockConnect`, `toHex` — lives in `pure.ts` and is
 * re-exported below so existing import paths keep working. Only the
 * node-midi-backed `connect()` / `listMidiPorts()` live here.
 */
import type { Input, Output } from 'midi';

import {
  createSysExAssembler,
  makeSysExReceiver,
  type ConnectOptions,
  type MidiConnection,
  type MidiPortInfo,
} from './pure.js';
import { setFallbackConnect } from '../server-shared/connections.js';

export * from './pure.js';

/**
 * node-midi is loaded LAZILY (and synchronously via createRequire — the
 * `connect()` / `listMidiPorts()` contracts are sync) so merely importing this
 * module never touches the native binding. That keeps serial-only sessions
 * (FM3 over USB-CDC) working where the binding is absent — e.g. an
 * `npm install --ignore-scripts` clone with no node-gyp toolchain
 * (community field report, 2026-06-12).
 */
let midiModule: typeof import('midi') | undefined;
function loadMidi(): typeof import('midi') {
  if (midiModule === undefined) {
    // process.getBuiltinModule (Node ≥20.16) instead of a static
    // `import { createRequire } from 'node:module'` — a static node:*
    // import would make this module (and every barrel that re-exports
    // it) unbundleable for the browser. In a browser, loadMidi() throws
    // the clear error below; merely importing this module stays fine.
    const nodeModule = globalThis.process?.getBuiltinModule?.('node:module');
    if (!nodeModule) {
      throw new Error(
        'The node-midi transport requires Node.js — it is not available in the browser. ' +
        'Browser runtimes (Axis Browser Direct) use Web MIDI / Web Serial transports instead.',
      );
    }
    try {
      midiModule = nodeModule.createRequire(import.meta.url)('midi') as typeof import('midi');
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `The MIDI transport module ("midi" / node-midi) failed to load: ${cause}\n` +
        'This is an installation problem (missing or broken native binding), not a device ' +
        'problem. If you installed with --ignore-scripts, run "npm rebuild midi" to build the ' +
        'binding. Serial-only devices (FM3 over USB-CDC) do not need node-midi.',
      );
    }
  }
  return midiModule;
}

function findPortByName(
  port: Input | Output,
  needles: readonly string[],
): number {
  for (let i = 0; i < port.getPortCount(); i++) {
    const name = port.getPortName(i).toLowerCase();
    if (needles.some((n) => name.includes(n.toLowerCase()))) return i;
  }
  return -1;
}

function enumeratePorts(
  port: Input | Output,
  direction: 'input' | 'output',
  needles: readonly string[],
): MidiPortInfo[] {
  const out: MidiPortInfo[] = [];
  for (let i = 0; i < port.getPortCount(); i++) {
    const name = port.getPortName(i);
    const lower = name.toLowerCase();
    const matched = needles.length > 0 && needles.some((n) => lower.includes(n.toLowerCase()));
    out.push({ index: i, name, direction, matched });
  }
  return out;
}

/**
 * List every MIDI input and output the OS exposes, without opening any
 * connection. Used by the `list_midi_ports` MCP tool, every device-
 * specific "device not found" diagnostic, and ad-hoc discovery tooling.
 *
 * `needles` controls which ports get `matched: true`. Default (empty
 * array) leaves every port's `matched` field false — caller filters by
 * its own substring rules.
 *
 * Opens and immediately releases short-lived node-midi handles so a
 * subsequent `connect()` still sees a clean state.
 *
 * Under `MCP_MOCK_TRANSPORT=1`, the real port list is augmented with
 * synthetic AM4 / Axe-Fx II / Hydrasynth entries so callers that gate
 * on visibility (the agent-regression hardware probe, the startup
 * banner, the `list_midi_ports` MCP tool) treat the mock-backed
 * devices as connected. Mock matches the device-specific connectXXX
 * wrappers — each one short-circuits to `mockConnect` under the same
 * env var.
 */
export function listMidiPorts(
  needles: readonly string[] = [],
): { inputs: MidiPortInfo[]; outputs: MidiPortInfo[] } {
  const midi = loadMidi();
  const input = new midi.Input();
  const output = new midi.Output();
  try {
    const inputs = enumeratePorts(input, 'input', needles);
    const outputs = enumeratePorts(output, 'output', needles);
    if (process.env.MCP_MOCK_TRANSPORT === '1') {
      return {
        inputs: [...inputs, ...mockPortEntries('input', needles, inputs.length)],
        outputs: [...outputs, ...mockPortEntries('output', needles, outputs.length)],
      };
    }
    return { inputs, outputs };
  } finally {
    input.closePort();
    output.closePort();
  }
}

/**
 * Synthetic port entries injected when `MCP_MOCK_TRANSPORT=1`. Names
 * match what each device's connectXXX wrapper would search for
 * (`AM4_PORT_NEEDLES`, `AXE_FX_II_PORT_NEEDLES`, etc.) so the visibility
 * gate trips for every mock-supported device.
 */
function mockPortEntries(
  direction: 'input' | 'output',
  needles: readonly string[],
  baseIndex: number,
): MidiPortInfo[] {
  const dirSuffix = direction === 'input' ? 'In' : 'Out';
  const fakeNames = [
    `AM4 MIDI ${dirSuffix} (mock)`,
    `Axe-Fx II MIDI ${dirSuffix} (mock)`,
    `Hydrasynth MIDI ${dirSuffix} (mock)`,
  ];
  return fakeNames.map((name, i) => {
    const lower = name.toLowerCase();
    const matched = needles.length > 0 && needles.some((n) => lower.includes(n.toLowerCase()));
    return { index: baseIndex + i, name, direction, matched };
  });
}

/**
 * Build the "no port found" error message. Lists what the OS does see so
 * the user can diagnose a typo / wrong-device situation. Device-specific
 * install hints are appended only when the caller passes them via
 * `notFoundHints`.
 */
function buildNotFoundError(
  needles: readonly string[],
  ins: string[],
  outs: string[],
  leadIn: string | undefined,
  extraHints: string[],
): Error {
  const noPorts = ins.length === 0 && outs.length === 0;
  const needleDesc = needles.map((n) => `"${n}"`).join(' or ');
  const lines: string[] = [
    leadIn ?? `No MIDI port matching ${needleDesc} found.`,
    ...extraHints,
  ];
  if (noPorts) {
    lines.push('No MIDI ports of any kind are visible — this usually means a MIDI driver is missing.');
  } else {
    lines.push(`MIDI ports the server can see (none matched ${needleDesc}):`);
    lines.push('Inputs:');
    lines.push(...(ins.length ? ins : ['  (none)']));
    lines.push('Outputs:');
    lines.push(...(outs.length ? outs : ['  (none)']));
  }
  return new Error(lines.join('\n'));
}

/**
 * Open a MIDI input + output pair matching the given needles. Throws
 * with a diagnostic message listing visible ports if no match is found.
 */
export function connect(opts: ConnectOptions): MidiConnection {
  const midi = loadMidi();
  const input = new midi.Input();
  const output = new midi.Output();

  const inputPort = findPortByName(input, opts.needles);
  const outputPort = findPortByName(output, opts.needles);

  if (inputPort === -1 || outputPort === -1) {
    const ins: string[] = [];
    for (let i = 0; i < input.getPortCount(); i++) ins.push(`  [${i}] ${input.getPortName(i)}`);
    const outs: string[] = [];
    for (let i = 0; i < output.getPortCount(); i++) outs.push(`  [${i}] ${output.getPortName(i)}`);
    throw buildNotFoundError(opts.needles, ins, outs, opts.notFoundLeadIn, opts.notFoundHints ?? []);
  }

  // Enable SysEx (false = don't ignore SysEx); ignore timing + active-sensing.
  input.ignoreTypes(false, true, true);

  const handlers = new Set<(bytes: number[]) => void>();
  const dispatch = (bytes: number[]): void => {
    for (const h of handlers) h(bytes);
  };
  const assemble = createSysExAssembler(dispatch);
  input.on('message', (_dt: number, bytes: number[]) => {
    assemble(bytes);
  });

  input.openPort(inputPort);
  output.openPort(outputPort);

  // openPort() does NOT throw on failure: RtMidi prints the error to
  // stderr ("MidiInWinMM::openPort: error creating Windows MM MIDI
  // input port.") and leaves the port closed, after which every send
  // goes nowhere and every read times out while the tool layer reports
  // fire-and-forget success (2026-06-10 incident: 169 writes into a
  // dead port returned ok:true). isPortOpen() is the native truth —
  // assert it and fail LOUDLY with the exclusive-hold diagnosis.
  if (!input.isPortOpen() || !output.isPortOpen()) {
    const failedSide = !input.isPortOpen()
      ? (!output.isPortOpen() ? 'input + output ports' : 'input port')
      : 'output port';
    try { input.closePort(); } catch { /* best-effort */ }
    try { output.closePort(); } catch { /* best-effort */ }
    throw new Error(
      `MIDI ${failedSide} found but could NOT be opened (the OS refused the open). ` +
      'Windows MIDI ports are exclusive: another process is almost certainly holding the port. ' +
      'Common holders: a second MCP server instance (another Claude Code or Claude Desktop ' +
      'session with this server configured), a stale node process from an earlier session ' +
      '(check Task Manager for leftover node.exe), or a manufacturer editor (AxeEdit / ' +
      'AM4-Edit / FM-Edit / Fractal-Bot). Close the holder, then retry or call reconnect_midi. ' +
      'If this error REPEATS right after a reconnect_midi on a quiet bus, the holder may be THIS ' +
      "server's own previous handle (the Windows driver does not always release a handle that " +
      'died mid-send): restarting the server process is the reliable recovery — fully quit the ' +
      'host app (Claude Desktop: system tray, Quit) and relaunch.',
    );
  }

  // Track send errors on a separate cell so the `send` arrow can read /
  // write without TS forward-reference issues; the conn object exposes
  // the cell via a getter so callers see live state.
  const sendErrCell: { value?: Error } = {};
  const send = (bytes: number[]): void => {
    try {
      output.sendMessage(bytes);
      sendErrCell.value = undefined;
    } catch (err) {
      sendErrCell.value = err instanceof Error ? err : new Error(String(err));
      throw sendErrCell.value;
    }
  };
  const conn: MidiConnection = {
    send,
    get lastSendError(): Error | undefined { return sendErrCell.value; },
    // The connect() copy of the receivers is the live process-kill
    // exposure the helper's pre-observe catch closes: send() CAN throw
    // synchronously here (output.sendMessage on a dead handle) after a
    // receiver was registered.
    receiveSysEx: (timeoutMs = 1000) =>
      makeSysExReceiver(handlers, () => true, timeoutMs, 'Timeout waiting for SysEx response'),
    receiveSysExMatching: (predicate, timeoutMs = 1000) =>
      makeSysExReceiver(handlers, predicate, timeoutMs, 'Timeout waiting for matching SysEx'),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    hasInput: true,
    close: () => {
      handlers.clear();
      input.closePort();
      output.closePort();
    },
  };
  return conn;
}

// The connection registry (`server-shared/connections.ts`) is browser-safe
// and can't import node-midi; give it the generic substring-connect
// fallback whenever this Node transport module is loaded. Registered as a
// module-load side effect — mirrors how device midi.ts modules register
// their connector factories.
setFallbackConnect(connect);
