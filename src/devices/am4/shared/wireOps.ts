/**
 * Wire-op helpers shared across every AM4 tool that does a SET write:
 * `sendAndAwaitAck` (send + classify ack), `formatAcklessHint` (response
 * fragment when no ack arrives), and the inbound-MIDI capture helpers
 * (`recordInbound` + `formatInboundCapture`) that produce the labelled
 * `[+NNNms] LABEL` timeline appended to every high-value tool response.
 *
 * Diagnostic surface — high-value AM4 tools subscribe to ALL inbound MIDI
 * for the duration of their wire activity, then append a `[+NNNms] LABEL`
 * timeline + one-line ack summary to their response. Helps surface stale-
 * handle / wrong-port / wedged-device situations without requiring a
 * separate `am4_test_navigate` round-trip — when `am4_apply_preset` reports
 * "10 writes, 8 acked" the timeline shows whether the missing 2 writes
 * got NACKs, no response at all, or were absorbed by an unrelated AM4-
 * Edit poll.
 *
 * Mirrors the pattern from Hydra's `hydra_apply_init` /
 * `apply_patch` — same shape, AM4-specific labels via
 * `describeAm4InboundMessage`.
 */

import {
    toHex,
    type MidiConnection,
} from '../../../core/midi/pure.js';
import { describeAm4InboundMessage } from '../describe.js';

import {
    AM4_LABEL,
    STALE_HANDLE_TIMEOUT_THRESHOLD,
    WRITE_ECHO_TIMEOUT_MS,
    isColdHandle,
    recordAckOutcome,
} from '../../../core/server-shared/connections.js';

/**
 * One send + ack-await attempt. Subscribes to inbound SysEx (appending to
 * the shared `captured` buffer for diagnostics), arms the ack predicate,
 * sends, and resolves to whether a matching ack arrived in the window.
 * Does NOT touch the stale-handle counter — the caller records the final
 * outcome once, after any cold-start resend, so a recovered cold start
 * doesn't leave a phantom timeout on the counter.
 */
async function attemptSendAndAwait(
    conn: MidiConnection,
    bytes: number[],
    predicate: (write: number[], response: number[]) => boolean,
    captured: number[][],
): Promise<{ acked: true; ackBytes: number[] } | { acked: false }> {
    const unsubscribe = conn.onMessage((msg) => {
        if (msg[0] === 0xf0) captured.push([...msg]);
    });
    const ackPromise = conn.receiveSysExMatching(
        (resp) => predicate(bytes, resp),
        WRITE_ECHO_TIMEOUT_MS,
    );
    conn.send(bytes);
    try {
        const ackBytes = await ackPromise;
        unsubscribe();
        return { acked: true, ackBytes };
    } catch {
        unsubscribe();
        return { acked: false };
    }
}

/**
 * Send a command and wait for the expected ack frame. `predicate` is the
 * shape matcher — `isCommandAck` for 18-byte addressing-only acks (save,
 * rename), `isWriteEcho` for the 64-byte SET_PARAM/placement/scene-switch
 * echo. Returns:
 *   - { acked: true, ackBytes } if a matching frame arrived in the window.
 *   - { acked: false, captured } otherwise — `captured` is every inbound
 *     SysEx we saw, for diagnostic display on failure.
 * `retried` is set when a cold-start resend was issued (see below).
 *
 * Cold-start resend: a freshly-opened USB-MIDI handle frequently drops the
 * very first outbound transaction during driver warm-up, so the first
 * write's ack can go missing even though the handle is healthy. When the
 * first write on a cold handle (see `isColdHandle`) gets no ack, we resend
 * ONCE on the SAME open handle before giving up. Same-handle (not a
 * close/reopen reconnect) is deliberate: callers that issue several writes
 * in one tool call (the apply executor's batch loop, the rename-then-save
 * sequence) hold this `conn`, and closing the port mid-call would
 * invalidate it. A plain resend recovers the warm-up drop without that
 * hazard; genuinely-dead handles still fall through to the lazy
 * reconnect-after-${STALE_HANDLE_TIMEOUT_THRESHOLD}-timeouts backstop.
 * The resend is gated to cold handles so it never fires on the legitimate
 * "block not placed" silent-absorb (a real no-ack that must surface).
 *
 * Calls `recordAckOutcome` once with the final classification so the
 * stale-handle counter stays accurate (a recovered cold start records a
 * single success, not a timeout-then-success).
 */
export async function sendAndAwaitAck(
    conn: MidiConnection,
    bytes: number[],
    predicate: (write: number[], response: number[]) => boolean,
    label: string = AM4_LABEL,
): Promise<
    | { acked: true; ackBytes: number[]; captured: number[][]; retried?: boolean }
    | { acked: false; captured: number[][]; retried?: boolean }
> {
    const captured: number[][] = [];
    const wasCold = isColdHandle(label);

    const first = await attemptSendAndAwait(conn, bytes, predicate, captured);
    if (first.acked) {
        recordAckOutcome(true, label);
        return { acked: true, ackBytes: first.ackBytes, captured };
    }

    if (!wasCold) {
        // Not a cold handle — a no-ack here is a real silent-absorb
        // (e.g. block not placed). Surface it; don't mask it with a resend.
        recordAckOutcome(false, label);
        return { acked: false, captured };
    }

    // Cold handle: the dropped ack is most likely a USB warm-up artifact.
    // Resend once on the same open handle.
    const retry = await attemptSendAndAwait(conn, bytes, predicate, captured);
    recordAckOutcome(retry.acked, label);
    if (retry.acked) {
        return { acked: true, ackBytes: retry.ackBytes, captured, retried: true };
    }
    return { acked: false, captured, retried: true };
}

export function formatAcklessHint(captured: number[][]): string {
    const capturedBlock = captured.length === 0
        ? '  (none)'
        : captured.map((m, i) => `  [${i}] (${m.length}B) ${toHex(m)}`).join('\n');
    return (
        `No command-ack within ${WRITE_ECHO_TIMEOUT_MS} ms. ` +
        `Inbound SysEx during the window:\n${capturedBlock}\n` +
        `If this keeps happening, the MIDI handle may be stale (AM4-Edit briefly ` +
        `open? USB replug?). Server auto-reconnects after ` +
        `${STALE_HANDLE_TIMEOUT_THRESHOLD} consecutive ack-less writes, or call ` +
        `reconnect_midi to force a fresh handle now.`
    );
}

export interface InboundCapture {
    /** Snapshot of (ms-since-start, bytes) for every inbound message seen. */
    observed: Array<{ ms: number; bytes: number[] }>;
    /** Tear down the subscription. Always call (in a finally). */
    unsubscribe: () => void;
    /** True when the underlying connection has an open input port. */
    hasInput: boolean;
    /** Used by `formatInboundCapture` to produce the [+NNNms] timeline. */
    startMs: number;
}

/**
 * Subscribe to every inbound MIDI message for the duration of a tool
 * call. Caller MUST invoke `capture.unsubscribe()` (typically in a
 * finally block) — leaving the subscription dangling adds noise to the
 * next tool call's capture.
 */
export function recordInbound(conn: MidiConnection): InboundCapture {
    const startMs = Date.now();
    const observed: Array<{ ms: number; bytes: number[] }> = [];
    const unsubscribe = conn.onMessage((bytes) => {
        observed.push({ ms: Date.now() - startMs, bytes: [...bytes] });
    });
    return {
        observed,
        unsubscribe,
        hasInput: conn.hasInput,
        startMs,
    };
}

/**
 * Format the captured timeline + ack summary as a multi-line block to
 * append to a tool response. Includes:
 *   - Header line with hasInput state and message count.
 *   - One labelled line per observed message (`[+NNNms] LABEL`), where
 *     LABEL comes from `describeAm4InboundMessage` — Save ACK / Rename
 *     ACK / SET_PARAM write echo / Multipurpose NACK rc=0x05 / etc.
 *   - One-line summary tallying write-echo / command-ack / NACK / OK /
 *     other so a "did anything land?" question is answerable at a
 *     glance without re-reading the full timeline.
 *
 * Caller is responsible for prepending its own context (e.g. "Inbound
 * MIDI during apply_preset:") — this function returns the block only.
 */
export function formatInboundCapture(capture: InboundCapture): string {
    const lines: string[] = [];
    lines.push(
        `Inbound MIDI capture (hasInput=${capture.hasInput}, ${capture.observed.length} message${capture.observed.length === 1 ? '' : 's'}):`,
    );
    if (!capture.hasInput) {
        lines.push('  (no input port open — capture is empty by construction)');
    } else if (capture.observed.length === 0) {
        lines.push('  (none — device sent nothing back during this call)');
    } else {
        for (const { ms, bytes } of capture.observed) {
            lines.push(`  [+${ms.toString().padStart(4)}ms] ${describeAm4InboundMessage(bytes)}`);
        }
    }
    // Compact ack-summary tally. The classifier is keyed off the leading
    // tokens in `describeAm4InboundMessage`'s output so it stays in sync
    // with the labels the caller actually sees in the timeline above.
    let writeEchos = 0;
    let commandAcks = 0;
    let nacks = 0;
    let multipurposeOk = 0;
    let other = 0;
    for (const { bytes } of capture.observed) {
        const label = describeAm4InboundMessage(bytes);
        if (label.startsWith('SET_PARAM write echo')) writeEchos++;
        else if (label.startsWith('Save ACK') || label.startsWith('Rename ACK') || label.startsWith('Command ACK')) commandAcks++;
        else if (label.includes('NACK')) nacks++;
        else if (label.includes(': OK')) multipurposeOk++;
        else other++;
    }
    if (capture.observed.length > 0) {
        lines.push(
            `Summary: ${writeEchos} write-echo, ${commandAcks} command-ack, ${multipurposeOk} multipurpose-OK, ${nacks} NACK, ${other} other.`,
        );
    }
    return lines.join('\n');
}
