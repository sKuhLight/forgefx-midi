/**
 * Axe-Fx Standard/Ultra (gen-1) DeviceReader.
 *
 * Scope: parameter READ (get_param / get_params). The gen-1 protocol is
 * bidirectional — function 0x02 both sets and queries, selected by a trailing
 * query(0)/set(1) flag, and a query returns a MIDI_PARAM_VALUE response with the
 * live value (0..254) and the device's own label string. See
 * `fractal-midi/gen1` (readParam.ts) and the SYSEX-MAP.
 *
 * Community-beta: the read wire is decoded byte-exactly from the gen-1 wiki
 * spec, but the project owns no gen-1 hardware, so whether the unit actually
 * answers a query is unconfirmed. When it does answer, the returned label is
 * ground truth (it is the device's own rendering). On no response within the
 * window the reader fails with `no_ack` and points the user at the front panel.
 *
 * Still out of scope (no implemented wire path): get_preset / whole-patch dump
 * (function 0x03 -> 0x04 is documented but the patch body is only partially
 * decoded), save, preset/scene switching, channels, block placement.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  ParamQuery,
  ReadResult,
  Unit,
} from '../../../core/protocol-generic/types.js';
import { DispatchError } from '../../../core/protocol-generic/types.js';

import {
  KNOWN_PARAMS,
  blockIdFor,
  buildGetParam,
  parseParamValue,
  isParamValueResponse,
  type AxeFxGen1Param,
} from '../../../gen1/index.js';

const DEVICE_LABEL = 'Fractal Axe-Fx Standard/Ultra';
/** Query response window. gen-1 round-trips are short; 300 ms matches AM4. */
const READ_RESPONSE_TIMEOUT_MS = 300;

function resolveParam(block: string, name: string): AxeFxGen1Param {
  const p = KNOWN_PARAMS[`${block}.${name}` as keyof typeof KNOWN_PARAMS] as AxeFxGen1Param | undefined;
  if (!p) {
    const known = Object.values(KNOWN_PARAMS)
      .filter((x) => (x as AxeFxGen1Param).block === block)
      .map((x) => (x as AxeFxGen1Param).name);
    throw new DispatchError(
      'unknown_param',
      DEVICE_LABEL,
      `Unknown parameter '${block}.${name}' on ${DEVICE_LABEL}.` +
        (known.length
          ? ` Known params for ${block}: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', …' : ''}.`
          : ` Unknown block '${block}'.`),
      { retry_action: `Call list_params({port, block:["${block}"]}) for the canonical names.` },
    );
  }
  return p;
}

async function readOne(ctx: DispatchCtx, block: string, name: string): Promise<ReadResult> {
  const p = resolveParam(block, name);
  const blockId = blockIdFor(block, 1);
  if (blockId === undefined) {
    throw new DispatchError('unknown_block', DEVICE_LABEL, `No wire blockId for '${block}' on ${DEVICE_LABEL}.`);
  }
  const req = buildGetParam(blockId, p.paramId);
  // Subscribe BEFORE sending so the device's response cannot outrace the
  // listener (mirrors the AM4 read path).
  const respPromise = ctx.conn.receiveSysExMatching(
    (resp) => isParamValueResponse(req, resp),
    READ_RESPONSE_TIMEOUT_MS,
  );
  ctx.conn.send(req);

  let resp: number[];
  try {
    resp = await respPromise;
  } catch {
    throw new DispatchError(
      'no_ack',
      DEVICE_LABEL,
      `No PARAM_VALUE response from ${DEVICE_LABEL} for '${block}.${name}' within ${READ_RESPONSE_TIMEOUT_MS}ms. ` +
        `gen-1 read-back is community-beta and unconfirmed on hardware; the unit may not answer queries on ` +
        `your firmware, or the port may have routed to a different codec.`,
      { retry_action: "Read the value off the device's front-panel display, and report the result so we can confirm gen-1 reads." },
    );
  }

  const parsed = parseParamValue(resp);
  if (!parsed) {
    throw new DispatchError(
      'no_ack',
      DEVICE_LABEL,
      `Malformed PARAM_VALUE response from ${DEVICE_LABEL} for '${block}.${name}'. Confirm on the front panel.`,
      { retry_action: 'Read the value off the front panel.' },
    );
  }

  // The device's own label is ground truth when present; fall back to the
  // descriptor's display decode (the device label is empty only if firmware
  // sent no string).
  const ps = ctx.descriptor.blocks[block]?.params[name];
  const unit: Unit = ps?.unit ?? 'opaque';
  const display_value =
    parsed.label !== ''
      ? parsed.label
      : ps?.decode
        ? ps.decode(parsed.value)
        : parsed.value;

  return {
    block,
    name,
    wire_value: parsed.value,
    display_value,
    unit,
    raw_response: resp,
  };
}

export const reader: DeviceReader = {
  async getParam(ctx: DispatchCtx, block: string, name: string): Promise<ReadResult> {
    return readOne(ctx, block, name);
  },

  async getParams(ctx: DispatchCtx, queries: readonly ParamQuery[]): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        reads.push(await readOne(ctx, q.block, q.name));
      } catch (err) {
        failed_indices.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices,
      ...(failed_indices.length ? { errors } : {}),
    };
  },
};
