/**
 * `connectSerial().close()` must not leave `send()` silently
 * queueing forever.
 *
 * The facade defers the open: `send()` before the port opens queues. But
 * `close()` only flips `closed/opened` and clears rejecters — it sets no
 * error — so with `openError` undefined every later `send()` re-enters the
 * pre-open queue branch and returns without throwing and without setting
 * `lastSendError`. Fire-and-forget callers then see silent success.
 */
import { connectSerial } from '../../src/core/midi/serialTransport.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`serial-close: ${msg}`);
}

export const SERIAL_CLOSE_CASE_COUNT = 3;

export async function runSerialCloseTests(): Promise<void> {
  const conn = connectSerial({ explicitPath: '/dev/null' });
  conn.close();

  let threw = false;
  try {
    conn.send([0xf0, 0x7d, 0x01, 0xf7]);
  } catch {
    threw = true;
  }

  assert(
    threw || conn.lastSendError !== undefined,
    'serial send() after close() must fail loudly (throw or set lastSendError), not queue silently',
  );
  assert(
    conn.lastSendError !== undefined,
    'serial lastSendError must be set after a post-close send()',
  );

  // A stale error from before close() must not be reported as the cause. Queue a send on a path
  // that cannot open: the failed open stores its diagnostic in lastSendError and in openError.
  // After close(), send() must still say the connection is CLOSED.
  const stale = connectSerial({ explicitPath: '/dev/forgefx-test-no-such-port', log: () => {} });
  stale.send([0xf0, 0x7d, 0x01, 0xf7]);
  const t0 = Date.now();
  while (stale.lastSendError === undefined) {
    assert(Date.now() - t0 < 10_000, 'the open of a nonexistent serial path never failed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const staleMessage = stale.lastSendError.message;
  assert(!/closed/i.test(staleMessage), `precondition: the stored error is the open failure, got: ${staleMessage}`);
  stale.close();
  let closedError: Error | undefined;
  try {
    stale.send([0xf0, 0x7d, 0x01, 0xf7]);
  } catch (e) {
    closedError = e as Error;
  }
  assert(closedError !== undefined, 'send() after close() must throw');
  assert(/closed/i.test(closedError!.message), `send() after close() must throw the closed error, got: ${closedError!.message}`);
  assert(
    stale.lastSendError !== undefined && /closed/i.test(stale.lastSendError.message),
    `lastSendError after close() must be the closed error, not a stale one: ${stale.lastSendError?.message}`,
  );
}
