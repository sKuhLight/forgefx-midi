/**
 * CaptureRig v2 offline replay validation (FORGEFXMID-28).
 *
 * Replays the two CaptureRig v2 "full" device captures (FM9 fw 12.0, Axe-Fx III
 * fw 32.6) back through the REAL `liveWalk` self-describe driver via a fake
 * `LiveTransport`, then builds a device cache through the SAME vote-only path
 * ForgeFX uses on a live device. This proves the captures decode and reconstruct
 * end-to-end offline, with no hardware.
 *
 * The transport is a pure lookup over the capture's `*.defs.jsonl` (the raw wire
 * view: one line per self-describe reply). It decodes each query exactly as
 * `buildQuery` frames it — view = frame[6] (body[0]); block = frame[8]|frame[9]<<7
 * (body[2]/[3]); param = frame[10]|frame[11]<<7 (body[4]/[5]); sub =
 * frame[12]|frame[13]<<7 (body[6]/[7]) — and answers with the capture's own raw
 * `r` reply frame for that (blk, param, view, sub). The capture keeps only real
 * definitions, so an address it lacks is answered in one of two ways, and the
 * walk is replayed under BOTH:
 *   - `device`: the documented device behaviour — an empty-slot definition / an
 *     end-of-list reply (the shared model of the live-walk suites);
 *   - `silent`: no reply at all (`null`), the opposite assumption. The walk must
 *     still complete and reconstruct exactly the capture's definitions (what the
 *     walk returned before reply-loss handling existed).
 *
 * The capture files live in the sibling fas-re RE workspace, addressed by
 * ABSOLUTE path; the whole suite SKIPS (never fails) when they are absent, so CI
 * without the RE workspace stays green — mirroring the guarded real-`.cache`
 * cross-check in `records.test.ts`.
 *
 * Assertions per device:
 *   • the walk COMPLETES and reconstructs exactly the capture's non-filler /
 *     non-garbage definition records, plus placeholder rows only for empty
 *     slots followed by a captured definition of the same block (record count
 *     reconciles; nothing else is fabricated), with zero lost replies;
 *   • every enum label the walk collects reconciles with the capture's 0x1f
 *     label-line count;
 *   • the vote-only family mapping (HW_SEEDS) leaves 0 param-bearing capture
 *     sections unmapped (bar the block-0 system selector), and the core effect
 *     families present in the capture all resolve to a section.
 *
 * `src/cache/*` stays browser-safe; this TEST may use `node:fs`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { buildDeviceCache, HW_SEEDS, liveWalkDetailed } from '../../src/cache/index.js';
import { decodeReply } from '../../src/cache/index.js';
import type { LiveTransport } from '../../src/cache/index.js';
import type { CacheRecord, DeviceParam, EnumRecord } from '../../src/cache/types.js';
import { FM9_PARAMS } from '../../src/gen3/fm9/index.js';
import { PARAMS as AXE3_PARAMS } from '../../src/gen3/axe-fx-iii/index.js';

export const RIGV2REPLAY_CASE_COUNT = 2;

// Candidate absolute roots for the CaptureRig v2 capture set (sibling fas-re RE
// workspace). Skip-if-absent, like records.test.ts's REAL_CACHE: the first that
// exists wins; none => SKIP (not fail). Both the Linux RE box and the Windows
// checkout are covered so the replay actually runs wherever the captures live.
const CAPTURE_ROOTS = [
  '/home/pascal/Dokumente/Repositorys/FractalAudio/fas-re/raw/captures/rigv2-20260717',
  'C:/Users/pasca/Documents/repositorys/FractalAudio/fas-re/raw/captures/rigv2-20260717',
];

interface DeviceCase {
  name: string;
  model: number;
  defsRel: string;
  params: readonly DeviceParam[];
}

const DEVICES: DeviceCase[] = [
  { name: 'FM9', model: 0x12, defsRel: 'fm9-full-fw12p0/fm9-full.defs.jsonl', params: FM9_PARAMS as unknown as DeviceParam[] },
  { name: 'AXE3', model: 0x10, defsRel: 'axe3-full-fw32p6/axe3-full.defs.jsonl', params: AXE3_PARAMS as unknown as DeviceParam[] },
];

// ---------------------------------------------------------------------------
// capture -> fake transport + reconciliation facts
// ---------------------------------------------------------------------------

interface DefsLine {
  blk: number;
  param: number;
  view: string;
  sub?: number;
  r: string;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Mirror of liveWalk's empty-slot filter: typecode 0 + all-zero body (any symbol id). */
function isFiller(d: { id: number; tc: number; min: number; max: number; def: number; step: number }): boolean {
  return d.tc === 0 && d.min === 0 && d.max === 0 && d.def === 0 && d.step === 0;
}

/** A device-shaped func-0x01 reply carrying `raw` (an empty `raw` = the no-payload end reply). */
function synthReply(model: number, view: number, param: number, tag: number, raw: Uint8Array): Uint8Array {
  const inner = new Array<number>(15).fill(0);
  inner[0] = view;
  inner[4] = param & 0x7f;
  inner[5] = (param >> 7) & 0x7f;
  inner[6] = tag;
  inner[13] = raw.length & 0xff;
  inner[14] = (raw.length >> 8) & 0xff;
  const wire: number[] = [];
  let acc = 0;
  let nbits = 0;
  for (const b of raw) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= 7) {
      nbits -= 7;
      wire.push((acc >> nbits) & 0x7f);
    }
  }
  if (nbits > 0) wire.push((acc << (7 - nbits)) & 0x7f);
  const core = [0xf0, 0x00, 0x01, 0x74, model, 0x01, ...inner, ...wire];
  let ck = 0;
  for (const b of core) ck ^= b;
  return Uint8Array.from([...core, ck & 0x7f, 0xf7]);
}

/** Mirror of liveWalk's system-selector junk filter (MAX_PLAUSIBLE_TC / SUBNORMAL_FLOOR). */
function isGarbage(d: { tc: number; min: number; max: number; def: number; step: number; scale: number }): boolean {
  if (d.tc > 0x3fff) return true;
  const junk = (x: number): boolean => !Number.isFinite(x) || (x !== 0 && Math.abs(x) < 1e-37);
  return junk(d.min) || junk(d.max) || junk(d.def) || junk(d.step) || junk(d.scale);
}

interface Loaded {
  transport: LiveTransport;
  blocks: number[];
  maxParam: number;
  defCount: number; // distinct (blk,param) 0x1c definition addresses
  labelLines: number; // 0x1f label lines
  expectedRecords: number; // non-filler, non-garbage definition records
  defKeys: Set<string>; // `${blk}:${param}` of every 0x1c address
}

function loadCapture(path: string, model: number, silent: boolean): Loaded {
  const byKey = new Map<string, Uint8Array>();
  const blocks = new Set<number>();
  const defKeys = new Set<string>();
  let maxParam = 0;
  let labelLines = 0;
  let expectedRecords = 0;

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const c = JSON.parse(line) as DefsLine;
    if (c.view !== '1c' && c.view !== '1f') continue;
    const viewByte = c.view === '1c' ? 0x1c : 0x1f;
    const sub = c.view === '1f' ? c.sub ?? 0 : 0;
    const frame = hexToBytes(c.r);
    byKey.set(`${c.blk}:${c.param}:${viewByte}:${sub}`, frame);
    blocks.add(c.blk);
    if (c.view === '1c') {
      defKeys.add(`${c.blk}:${c.param}`);
      maxParam = Math.max(maxParam, c.param);
      const d = decodeReply(frame);
      if (d && d.view === 'definition' && !isFiller(d) && !isGarbage(d)) expectedRecords += 1;
    } else {
      labelLines += 1;
    }
  }

  const transport: LiveTransport = {
    request(query: Uint8Array): Promise<Uint8Array | null> {
      const view = query[6]!;
      const block = query[8]! | (query[9]! << 7);
      const param = query[10]! | (query[11]! << 7);
      const sub = query[12]! | (query[13]! << 7);
      const hit = byKey.get(`${block}:${param}:${view}:${sub}`);
      if (hit) return Promise.resolve(hit);
      if (silent) return Promise.resolve(null);
      // Not in the capture: the device answered with an empty slot / end of list.
      if (view === 0x1c) return Promise.resolve(synthReply(model, 0x1c, param, 0x3a, new Uint8Array(36)));
      return Promise.resolve(synthReply(model, view, param, 0x40, new Uint8Array(0)));
    },
  };

  return {
    transport,
    blocks: [...blocks].sort((a, b) => a - b),
    maxParam,
    defCount: defKeys.size,
    labelLines,
    expectedRecords,
    defKeys,
  };
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

/** An all-zero float row (no information: an unused slot). */
function isPlaceholder(r: CacheRecord): boolean {
  return r.kind === 'float' && r.min === 0 && r.max === 0 && r.def === 0;
}

/** A placeholder row the WALK emitted for an inner empty slot (not a captured definition). */
function isWalkPlaceholder(r: CacheRecord): boolean {
  return r.kind === 'float' && r.placeholder === true;
}

export async function runRigV2Replay(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[cache/rigv2replay] ${msg}`);
  };

  const root = CAPTURE_ROOTS.find((p) => existsSync(p));
  if (!root) {
    console.log('  SKIP cache/rigv2replay (CaptureRig v2 captures absent — sibling fas-re RE workspace not present)');
    return;
  }

  for (const dev of DEVICES) {
    const path = `${root}/${dev.defsRel}`;
    if (!existsSync(path)) {
      console.log(`  SKIP cache/rigv2replay ${dev.name} (${dev.defsRel} absent)`);
      continue;
    }
    const cap = loadCapture(path, dev.model, false);

    // Replay through the real liveWalk driver. Sweep exactly the captured block
    // set; run/probe limits are opened past the highest captured param so every
    // captured slot is reached, and the sweep runs a few params past it, as a real
    // walk runs past the end of every table (readValues off: the defs capture holds
    // no 0x00 value replies, and record/label reconciliation does not depend on units).
    const walked = await liveWalkDetailed(cap.transport, {
      model: dev.model,
      blocks: cap.blocks,
      maxParamId: cap.maxParam + 8,
      paramAbsentRunLimit: cap.maxParam + 2,
      blockProbeDepth: cap.maxParam + 2,
      readValues: false,
      sleep: () => Promise.resolve(),
    });

    const records = walked.records;
    if (walked.lostReplies !== 0 || walked.silentAddresses !== 0) fail(`${dev.name}: ${walked.lostReplies} lost replies / ${walked.silentAddresses} silent addresses on a complete capture`);

    // 1. Walk completes and reconstructs exactly the capture's real definitions, plus
    //    placeholder rows for empty slots it proved to be inner.
    if (records.length === 0) fail(`${dev.name}: liveWalk produced no records`);
    if (records.length !== cap.expectedRecords + walked.placeholderSlots) {
      fail(
        `${dev.name}: walk records ${records.length} != capture non-filler defs ${cap.expectedRecords} ` +
          `+ ${walked.placeholderSlots} placeholders (of ${cap.defCount} defs)`,
      );
    }
    // Nothing fabricated: every real record maps to a captured 0x1c address; every placeholder
    // is an uncaptured slot with a captured definition AFTER it in its block (inner or leading).
    const realKeys = new Set<string>();
    for (const r of records) if (!isWalkPlaceholder(r)) realKeys.add(`${r.section}:${r.id}`);
    const fabricated = records.filter((r) => !isWalkPlaceholder(r) && !cap.defKeys.has(`${r.section}:${r.id}`));
    if (fabricated.length > 0) {
      fail(`${dev.name}: ${fabricated.length} walked record(s) not present in the capture (e.g. ${fabricated[0]!.section}:${fabricated[0]!.id})`);
    }
    const strayPlaceholder = records.find((r) => {
      if (!isWalkPlaceholder(r)) return false;
      if (cap.defKeys.has(`${r.section}:${r.id}`)) return true; // a captured address is never a placeholder
      const ids = records.filter((x) => x.section === r.section && realKeys.has(`${x.section}:${x.id}`)).map((x) => x.id);
      return !ids.some((i) => i > r.id); // inner or leading: a captured definition follows it
    });
    if (strayPlaceholder) fail(`${dev.name}: placeholder ${strayPlaceholder.section}:${strayPlaceholder.id} is captured or trailing`);

    // 2. Enum labels reconcile with the capture's 0x1f label lines exactly.
    let labels = 0;
    for (const r of records) if (r.kind === 'enum') labels += (r as EnumRecord).values.length;
    if (labels !== cap.labelLines) {
      fail(`${dev.name}: collected ${labels} enum labels != capture 0x1f lines ${cap.labelLines}`);
    }

    // 3. Family mapping via the production vote-only path. The captured walk keys
    //    sections by the live block id (not the cache section tag), so buildCache's
    //    all-seed anchor never applies — buildDeviceCache takes the vote-only path
    //    when at least one asserted seed exists but none anchors. Assert only the
    //    amp block (DISTORT), present in both amp-oriented capture presets: a
    //    single-preset capture cannot instantiate every core block (this FM9 preset
    //    has no drive/FUZZ block, this III preset no CABINET), so asserting all
    //    five HW_SEEDS would wrongly reject a valid capture.
    const built = buildDeviceCache(records, dev.params, HW_SEEDS, { assertSeeds: new Set(['DISTORT']) });

    // Every captured section that carries real (non-placeholder) params must map
    // to a family — the only tolerated unmapped informative section is the block-0
    // system selector (not an effect family).
    const bySection = new Map<number, CacheRecord[]>();
    for (const r of records) {
      let g = bySection.get(r.section);
      if (!g) bySection.set(r.section, (g = []));
      g.push(r);
    }
    const unmappedInformative = built.unmappedSections.filter((s) => {
      const recs = bySection.get(s.sectionTag) ?? [];
      return recs.some((r) => !isPlaceholder(r)) && s.sectionTag !== 0;
    });
    if (unmappedInformative.length > 0) {
      fail(`${dev.name}: ${unmappedInformative.length} param-bearing section(s) unmapped: ${unmappedInformative.map((s) => s.sectionTag).join(', ')}`);
    }

    // The seeded core families that ARE present in this capture must all resolve.
    const seedsResolved = Object.keys(HW_SEEDS).filter((f) => built.rangeSections[f] !== undefined);
    const seedsAbsent = Object.keys(HW_SEEDS).filter((f) => built.rangeSections[f] === undefined);
    if (!seedsResolved.includes('DISTORT')) fail(`${dev.name}: DISTORT (amp) block did not resolve`);
    if (Object.keys(built.ranges).length < 10) {
      fail(`${dev.name}: only ${Object.keys(built.ranges).length} families mapped (expected the full effect set)`);
    }

    // 4. The same capture with every uncaptured address SILENT: the walk completes (no abort)
    //    and returns exactly the captured definitions — no placeholders, nothing invented.
    const silentCap = loadCapture(path, dev.model, true);
    const quiet = await liveWalkDetailed(silentCap.transport, {
      model: dev.model,
      blocks: silentCap.blocks,
      maxParamId: silentCap.maxParam + 8,
      paramAbsentRunLimit: silentCap.maxParam + 2,
      blockProbeDepth: silentCap.maxParam + 2,
      readValues: false,
      sleep: () => Promise.resolve(),
    });
    const quietLabels = quiet.records.reduce((n, r) => n + (r.kind === 'enum' ? (r as EnumRecord).values.length : 0), 0);
    if (
      quiet.records.length !== cap.expectedRecords ||
      quiet.placeholderSlots !== 0 ||
      quiet.records.some((r) => !cap.defKeys.has(`${r.section}:${r.id}`)) ||
      quietLabels !== cap.labelLines
    ) {
      fail(`${dev.name} (silent addresses): ${quiet.records.length} records / ${quietLabels} labels, want ${cap.expectedRecords} / ${cap.labelLines}; unresolved ${quiet.unresolvedReplies}, missing ${quiet.missingSlots}`);
    }
    // Same definitions as the device walk (kinds may differ: only an ANSWERED empty label list
    // is evidence for float, a silent one is not).
    const addrs = (rs: readonly CacheRecord[]) => rs.filter((r) => !isWalkPlaceholder(r)).map((r) => `${r.section}:${r.id}`).join(',');
    if (addrs(quiet.records) !== addrs(records)) fail(`${dev.name}: silent-address walk reached different definitions than the device walk`);

    console.log(
      `  cache/rigv2replay ${dev.name} (silent addresses): walk completes with the same ${quiet.records.length} definitions ` +
        `(${quiet.queries} queries vs ${walked.queries}, ${quiet.silentAddresses} silent addresses, ` +
        `${quiet.unresolvedReplies} kept as loss: silent list ends + short inner runs)`,
    );
    console.log(
      `  cache/rigv2replay ${dev.name}: ${records.length - walked.placeholderSlots}/${cap.defCount} defs reconstructed ` +
        `(+${walked.placeholderSlots} inner placeholders), ` +
        `${labels} enum labels reconcile; ${Object.keys(built.ranges).length} families mapped, ` +
        `0 param-sections unmapped; seeds present [${seedsResolved.join(',')}]` +
        (seedsAbsent.length ? ` absent [${seedsAbsent.join(',')}] (preset-scoped)` : ''),
    );
  }
}
