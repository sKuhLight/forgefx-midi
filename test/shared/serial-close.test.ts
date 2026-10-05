/**
 * W5.2 red/green — `connectSerial().close()` must not leave `send()` silently
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

export const SERIAL_CLOSE_CASE_COUNT = 2;

export function runSerialCloseTests(): void {
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
}
