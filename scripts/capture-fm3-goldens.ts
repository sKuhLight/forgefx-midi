/**
 * One-time FM3 golden capture (migration Phase 0).
 *
 * Talks to a RUNNING ForgeFX server (old codebase, pre-driver-refactor) with a
 * live FM3 attached, and freezes its live-validated behavior as fixtures under
 * test/gen3/fm3/fixtures/:
 *
 *   preset-<n>.syx                    raw preset dump (version-store bytes)
 *   preset-<n>.summary.expected.json  GET /presets/:n/summary?full=1
 *   preset-<n>.params.expected.json   GET /presets/:n/params
 *   telemetry.expected.json           raw frames + the values the old server computed
 *     (handshake fn 0x00, tempo 0x14, scene 0x0C, status dump 0x13,
 *      tuner/meter/CPU polls fn 0x01 sub 0x19/0x2E)
 *
 * Usage: tsx scripts/capture-fm3-goldens.ts [--base http://localhost:5056]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv.includes('--base')
  ? process.argv[process.argv.indexOf('--base') + 1]!
  : 'http://localhost:5056';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'gen3', 'fm3', 'fixtures');
mkdirSync(FIXTURES, { recursive: true });

const SLOTS_TO_SCAN = 100; // survey window for picking representative presets
const PICK_COUNT = 10;

async function get(path: string): Promise<any> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}
async function getBytes(path: string): Promise<Uint8Array> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function post(path: string, body?: unknown): Promise<any> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

/** Fractal SysEx envelope for model 0x11 (FM3): F0 00 01 74 11 fn data… cs F7 (cs = XOR & 0x7f). */
function envelope(model: number, fn: number, data: number[]): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, model, fn, ...data];
  let cs = 0;
  for (const b of body) cs ^= b;
  return [...body, cs & 0x7f, 0xf7];
}

/** Raw SysEx round-trip via the server's /debug/raw probe (frames arrive hex-encoded). */
async function raw(bytes: number[]): Promise<number[][]> {
  const res = await post('/debug/raw', { hex: hex(bytes) });
  return (res.frames ?? []).map((f: string) => (f.match(/../g) ?? []).map((x: string) => parseInt(x, 16)));
}

/** Old-server value math, replicated verbatim so expected values freeze alongside frames. */
function decodeFloat32At(frame: number[], off: number): number {
  let u = 0;
  for (let i = 0; i < 5; i++) u |= (frame[off + i]! & 0x7f) << (7 * i);
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, u >>> 0, true);
  return dv.getFloat32(0, true);
}
function meterDb(f: number[]): number {
  let v = 0;
  for (let i = 0; i < 5; i++) v |= (f[12 + i]! & 0x7f) << (7 * i);
  const rms = new Float32Array(new Uint32Array([v >>> 0]).buffer)[0]!;
  if (!(rms > 1e-7)) return -40;
  const db = 10 * Math.log10(rms);
  return Math.max(-40, Math.min(6, db));
}

async function main() {
  // ── sanity: FM3 attached, old server up ──
  const detect = await get('/device/detect');
  if (detect.modelId !== 0x11) throw new Error(`expected FM3 (0x11), got ${JSON.stringify(detect)}`);
  console.log(`connected: ${detect.name} on ${detect.port}`);

  if (!process.argv.includes('--telemetry-only')) await capturePresets();
  await captureTelemetry(detect);
}

async function capturePresets() {
  // ── 1. survey slots, pick a family-diverse set ──
  type Summary = { number: number; name: string; blocks?: { slug: string }[]; crcValid?: boolean };
  const surveyed: Summary[] = [];
  for (let n = 0; n < SLOTS_TO_SCAN; n++) {
    try {
      const s = await get(`/presets/${n}/summary`);
      if (s?.name && s.crcValid !== false) surveyed.push(s);
      process.stdout.write(`\rsurvey ${n + 1}/${SLOTS_TO_SCAN} (${surveyed.length} valid)`);
    } catch {
      /* empty/unreadable slot — skip */
    }
  }
  console.log();
  // greedy max-coverage pick over block slugs
  const picked: Summary[] = [];
  const covered = new Set<string>();
  while (picked.length < PICK_COUNT && surveyed.length) {
    surveyed.sort((a, b) => {
      const gain = (s: Summary) => (s.blocks ?? []).filter((x) => !covered.has(x.slug)).length;
      return gain(b) - gain(a);
    });
    const next = surveyed.shift()!;
    if (picked.some((p) => p.number === next.number)) continue;
    picked.push(next);
    for (const b of next.blocks ?? []) covered.add(b.slug);
  }
  console.log(`picked slots: ${picked.map((p) => `${p.number}(${p.name})`).join(', ')}`);
  console.log(`family coverage: ${[...covered].sort().join(', ')}`);

  // ── 2. per-slot goldens: raw dump + frozen decode output ──
  for (const p of picked) {
    const n = p.number;
    const backup = await post(`/backup/preset/${n}`);
    const id = backup?.version?.id;
    if (!id) {
      console.warn(`slot ${n}: backup returned no version id — skipped`);
      continue;
    }
    const syx = await getBytes(`/version/${id}/syx`);
    writeFileSync(join(FIXTURES, `preset-${n}.syx`), syx);
    const summary = await get(`/presets/${n}/summary?full=1`);
    writeFileSync(join(FIXTURES, `preset-${n}.summary.expected.json`), JSON.stringify(summary, null, 2));
    const params = await get(`/presets/${n}/params`);
    writeFileSync(join(FIXTURES, `preset-${n}.params.expected.json`), JSON.stringify(params, null, 2));
    console.log(`slot ${n} "${p.name}": ${syx.length} bytes syx + summary + params`);
  }
}

async function captureTelemetry(detect: unknown) {
  // ── 3. telemetry / protocol frames via /debug/raw ──
  const M = 0x11;
  const entries: any[] = [];
  const capture = async (name: string, req: number[], expected: (frames: number[][]) => unknown, repeat = 3) => {
    const runs: { frames: string[]; expected: unknown }[] = [];
    for (let i = 0; i < repeat; i++) {
      const frames = await raw(req);
      runs.push({ frames: frames.map(hex), expected: expected(frames) });
    }
    entries.push({ name, requestHex: hex(req), runs });
    console.log(`telemetry: ${name} × ${repeat}`);
  };

  // handshake — broadcast to wildcard model 0x7f, reply model byte at f[4]
  await capture('handshake', envelope(0x7f, 0x00, []), (fs) => {
    const f = fs.find((x) => x[1] === 0x00 && x[2] === 0x01 && x[3] === 0x74 && x.length > 5);
    return { modelId: f ? f[4] : -1 };
  }, 1);
  // tempo (fn 0x14): payload bytes 6..7 LSB-first septet pair
  await capture('tempo', envelope(M, 0x14, []), (fs) => {
    const f = fs.find((x) => x[5] === 0x14);
    if (!f) return null;
    const p = f.slice(6, f.length - 2);
    return { bpm: (p[0]! & 0x7f) | ((p[1]! & 0x7f) << 7) };
  });
  // scene (fn 0x0c): byte 6, masked & 0x07
  await capture('scene', envelope(M, 0x0c, [0x7f]), (fs) => {
    const f = fs.find((x) => x[5] === 0x0c);
    if (!f) return null;
    return { index: (f.slice(6, f.length - 2)[0] ?? 0) & 0x07 };
  });
  // status dump (fn 0x13)
  await capture('status-dump', envelope(M, 0x13, []), (fs) => ({ frames: fs.length }), 1);
  // tuner poll (fn 0x01 sub 0x19 field 0x02) — float32 @ off 12 = fundamental Hz
  await capture('tuner-poll', envelope(M, 0x01, [0x19, 0x00, 0x23, 0x00, 0x02, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]), (fs) => {
    const f = fs.find((x) => x[5] === 0x01 && x[6] === 0x19 && x[10] === 0x02);
    return f ? { freqHz: decodeFloat32At(f, 12) } : null;
  });
  // output meters (fn 0x01 sub 0x19, addr 0x2A/0x2B out1/out2, sub 0x10/0x11 L/R) — 23-byte reply
  for (const { addr, sub, label } of [
    { addr: 0x2a, sub: 0x10, label: 'meter-out1L' },
    { addr: 0x2a, sub: 0x11, label: 'meter-out1R' },
    { addr: 0x2b, sub: 0x10, label: 'meter-out2L' },
    { addr: 0x2b, sub: 0x11, label: 'meter-out2R' },
  ]) {
    await capture(label, envelope(M, 0x01, [0x19, 0x00, addr, 0x00, sub, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), (fs) => {
      const f = fs.find((x) => x[5] === 0x01 && x[6] === 0x19 && x[8] === addr && x[10] === sub && x.length === 23);
      return f ? { db: meterDb(f) } : null;
    });
  }
  // CPU (fn 0x01 sub 0x2E, ≥590-byte frame; byte 37 → % = 32 + raw*0.5)
  await capture('cpu-poll', envelope(M, 0x01, [0x2e, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), (fs) => {
    const f = fs.find((x) => x[5] === 0x01 && x[6] === 0x2e && x.length >= 590);
    return f ? { rawByte37: f[37], percent: Math.round((32 + f[37]! * 0.5) * 10) / 10 } : null;
  });

  writeFileSync(join(FIXTURES, 'telemetry.expected.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    device: detect,
    note: 'Frames + values frozen from the live-FM3-validated pre-migration ForgeFX server (Phase 0).',
    entries,
  }, null, 2));
  console.log(`\nwrote fixtures to ${FIXTURES}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
