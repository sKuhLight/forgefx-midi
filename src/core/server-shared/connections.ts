/**
 * Per-port MIDI connection registry shared by every tool family.
 *
 * The connection layer is keyed by `label` so the server can hold open
 * handles to multiple MIDI ports concurrently. Each device contributes
 * its own connector factory via `registerConnector(label, factory)` at
 * module-load time — typically a side-effect of the device's `midi.ts`
 * being imported. Labels with no registered factory fall back to a
 * generic substring connect against the label string itself.
 *
 * Extracted from `src/server/index.ts` during the server.ts split — the
 * shared module the rest of the tools depend on.
 */

import type { ConnectOptions, MidiConnection } from '../midi/pure.js';

/**
 * Generic substring-connect fallback for labels with no registered
 * factory. Installed by `../midi/transport.js` at module load (it owns
 * the node-midi binding); kept injectable so this registry stays
 * browser-safe — browser runtimes register explicit factories and never
 * need the generic fallback.
 */
let fallbackConnect: ((opts: ConnectOptions) => MidiConnection) | null = null;

export function setFallbackConnect(fn: (opts: ConnectOptions) => MidiConnection): void {
    fallbackConnect = fn;
}

/**
 * Max time we wait for the device to echo a WRITE after we send it. The
 * AM4 typically responds in well under 50 ms when the target block is
 * placed; if 300 ms passes we treat it as silent-absorb (block not in
 * the active preset) and surface a clear error instead of pretending
 * the write succeeded.
 */
export const WRITE_ECHO_TIMEOUT_MS = 300;

export const AM4_LABEL = 'am4';
export const AXEFX2_LABEL = 'axe-fx-ii';
export const AXEFX3_LABEL = 'axe-fx-iii';
// Modern Fractal family siblings of the III (same gen-3 codec, different
// model byte). community-beta.
export const FM3_LABEL = 'fm3';
export const FM9_LABEL = 'fm9';
// VP4 (gen-3 effects codec, AM4-shape serial chain). community-beta; reads +
// mode switch only, device-state writes gated (placement wire shape undecoded).
export const VP4_LABEL = 'vp4';

/**
 * How many ack-less writes we tolerate before assuming the MIDI handle is
 * stale and forcing a reconnect on the next use. Two is chosen so a single
 * "block not placed" silent-absorb doesn't trigger a reconnect (that's a
 * legitimate no-ack and should keep the handle), but two in a row across
 * any tool calls looks like the handle is actually dead.
 */
export const STALE_HANDLE_TIMEOUT_THRESHOLD = 2;

interface RegistryEntry {
    conn: MidiConnection;
    consecutiveTimeouts: number;
    /**
     * True until the first write/ack outcome is recorded on this handle.
     * A freshly-opened USB-MIDI handle frequently drops the very first
     * outbound transaction during driver warm-up, so the first write's ack
     * can go missing even though the handle is healthy. `sendAndAwaitAck`
     * reads this to decide whether a no-ack warrants a one-shot same-handle
     * resend (see `isColdHandle`). Cleared by `recordAckOutcome` on the
     * first outcome of either kind, so the cold-start resend fires at most
     * once per handle lifetime.
     */
    cold: boolean;
}

const connections = new Map<string, RegistryEntry>();
const connectionErrors = new Map<string, Error>();
const connectorFactories = new Map<string, () => MidiConnection>();

/**
 * Register a device-specific connector factory. The factory is invoked
 * the first time a tool calls `ensureConnection(label)` for the given
 * label. Subsequent calls return the cached connection until a
 * forced/stale reconnect.
 *
 * Devices register at module-load time (typically in their `midi.ts`)
 * so the side effect happens whenever any code imports the device
 * package — including the server boot path and isolated test scripts.
 */
export function registerConnector(label: string, factory: () => MidiConnection): void {
    connectorFactories.set(label, factory);
}

/**
 * Call after a write/ack pair completes. Resets the stale-handle counter on
 * success; increments it on timeout. Counter is per-port — patterns like
 * "apply_preset 3 AM4 writes all time out" count as 3 consecutive against
 * the AM4 entry only, and don't drag down a separate Hydrasynth handle.
 */
export function recordAckOutcome(acked: boolean, label: string = AM4_LABEL): void {
    const entry = connections.get(label);
    if (!entry) return;
    if (acked) entry.consecutiveTimeouts = 0;
    else entry.consecutiveTimeouts++;
    // The handle has now completed at least one write/ack round-trip
    // attempt, so it is no longer "cold". This clears the cold-start
    // resend eligibility regardless of outcome — a failed first write
    // gets exactly one resend, not a resend on every subsequent write.
    entry.cold = false;
}

/**
 * True when `label`'s handle has not yet recorded any write/ack outcome —
 * i.e. the next write would be the first on a freshly-opened handle, where
 * a dropped ack is most likely a USB warm-up artifact rather than a real
 * silent-absorb. `sendAndAwaitAck` uses this to gate its one-shot
 * cold-start resend. Returns false when there is no entry (no handle yet,
 * so nothing is "cold" to retry).
 */
export function isColdHandle(label: string = AM4_LABEL): boolean {
    return connections.get(label)?.cold ?? false;
}

function closeMidiSafely(conn: MidiConnection | undefined): void {
    if (!conn) return;
    try {
        conn.close();
    } catch {
        // Closing a stale handle can throw; ignore — we're discarding it anyway.
    }
}

/**
 * Open or return a cached connection for `label`. The default label is
 * the AM4; future device packages will pass their own label.
 *
 * When the label has a registered connector factory, that factory is
 * invoked. Otherwise the label itself is used as a port-name substring
 * via the generic `connect()`. Devices needing a non-substring port
 * discovery path (e.g. Axe-Fx II's "Axe-Fx II Port 1" with a space the
 * label uses a dash for) must register a factory.
 */
export function ensureConnection(
    label: string = AM4_LABEL,
    forceReconnect = false,
): MidiConnection {
    const cached = connections.get(label);
    const stale = (cached?.consecutiveTimeouts ?? 0) >= STALE_HANDLE_TIMEOUT_THRESHOLD;
    if (forceReconnect || stale) {
        if (cached) closeMidiSafely(cached.conn);
        connections.delete(label);
        connectionErrors.delete(label);
        // 2026-05-23: ALSO clear ANY error keyed by a label that doesn't
        // match this one. Pre-fix: reconnect_midi("hydra") cleared
        // connectionErrors["hydra"] but the real stale entry was under
        // "hydrasynth" (the canonical connection_label). A clear cache
        // wipe on any reconnect is cheap (~5 device labels max) and
        // closes the entire class of "wrong cache key" bugs. The flip
        // side: a forced reconnect for one device retriggers a fresh
        // port scan for ALL devices on next use, which is fine — port
        // scans are cheap.
        if (forceReconnect) {
            connectionErrors.clear();
        }
    }
    const existing = connections.get(label);
    if (existing) return existing.conn;
    const cachedErr = connectionErrors.get(label);
    if (cachedErr) throw cachedErr;
    try {
        const factory = connectorFactories.get(label);
        if (!factory && !fallbackConnect) {
            throw new Error(
                `No connector registered for label "${label}" and the generic MIDI ` +
                'transport is not loaded (import forgefx-midi/core/midi first, or ' +
                'register a factory via registerConnector).',
            );
        }
        const conn = factory ? factory() : fallbackConnect!({ needles: [label] });
        connections.set(label, { conn, consecutiveTimeouts: 0, cold: true });
        return conn;
    } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        connectionErrors.set(label, e);
        throw e;
    }
}

/**
 * Close every open connection and clear the registry. There is no
 * module-load side effect in this file — a host process that wants
 * exit-time cleanup wires this itself (e.g. `process.on('exit',
 * closeAllConnections)`), keeping registration/lifecycle explicit
 * by callers.
 */
export function closeAllConnections(): void {
    for (const entry of connections.values()) closeMidiSafely(entry.conn);
    connections.clear();
    connectionErrors.clear();
}
