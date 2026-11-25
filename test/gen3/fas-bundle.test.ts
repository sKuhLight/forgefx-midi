/**
 * `.fasBundle` tests: synthetic ZIP + manifest round-trips, the 8,192-byte cab
 * record contract, the EMPTY placeholder, restore re-framing, and every strict
 * rejection path (version, sizes, names, limits).
 */
import {
  FAS_BUNDLE_CAB_RECORD_LEN,
  FAS_BUNDLE_CHUNK_PAYLOAD_LEN,
  FAS_BUNDLE_MANIFEST_ENTRY,
  bundlePresetFooterPayload,
  buildBundleRestorePreamble,
  encodeBundleRestoreFile,
  readFasBundle,
  writeFasBundle,
  type FasBundle,
  type FasBundleCab,
} from '../../src/devices/gen3/fasBundle.js';
import { parsePresetDump } from '../../src/devices/gen3/presetDump.js';
import { readFractalFrame } from '../../src/devices/gen3/frame.js';
import { parseXml, xmlAttribute, xmlChildren } from '../../src/shared/xml.js';
import { readZipArchive, writeStoredZipArchive, type ZipEntry } from '../../src/shared/zipArchive.js';

export const FAS_BUNDLE_CASE_COUNT = 30;

function fail(msg: string): never {
  throw new Error(`[gen3/fasBundle] ${msg}`);
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function expectThrow(fn: () => unknown, pattern: RegExp, label: string): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) fail(`${label}: wrong error: ${message}`);
    return;
  }
  fail(`${label}: did not throw`);
}

function chunk(seed: number): Uint8Array {
  const out = new Uint8Array(FAS_BUNDLE_CHUNK_PAYLOAD_LEN);
  out[0] = 0;
  out[1] = 8; // 1,024 words, the 0x78 chunk count observed in a preset dump
  for (let i = 2; i < out.length; i++) out[i] = (seed * 31 + i * 7) & 0x7f;
  return out;
}

function cab(recordByte: number, index: number): FasBundleCab {
  const record = new Uint8Array(FAS_BUNDLE_CAB_RECORD_LEN).fill(recordByte);
  return {
    cabId: 2048 + index,
    channel: index & 3,
    slotIndex: index,
    bank: 0,
    number: index,
    name: `Cab ${index}`,
    record,
  };
}

function makeBundle(overrides?: Partial<FasBundle>): FasBundle {
  const chunks = Array.from({ length: 8 }, (_, i) => chunk(i + 1));
  return {
    version: 1,
    device: { deviceId: 0x11, deviceMajor: 13, deviceMinor: 0 },
    preset: { location: 12, name: 'My Preset', chunkPayloads: chunks },
    cabs: [cab(0x5a, 0), cab(0xa5, 1)],
    ...overrides,
  };
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\r\n';

function manifest(body: string, version = '1'): string {
  return `${XML_HEAD}<Bundle-Map version="${version}">${body}</Bundle-Map>`;
}

function presetEntry(): ZipEntry {
  const body = new Uint8Array(8 * FAS_BUNDLE_CHUNK_PAYLOAD_LEN);
  for (let i = 0; i < 8; i++) body.set(chunk(i + 1), i * FAS_BUNDLE_CHUNK_PAYLOAD_LEN);
  return { name: 'preset', data: body };
}

function bundleZip(xml: string, extra: ZipEntry[] = []): Uint8Array {
  return writeStoredZipArchive([{ name: FAS_BUNDLE_MANIFEST_ENTRY, data: bytes(xml) }, ...extra]);
}

function standardManifest(body = ''): string {
  return manifest(
    '<Device deviceId="17" deviceMajor="13" deviceMinor="0"/>' +
      '<Preset Location="12" Name="P" File="preset"/>' +
      body,
  );
}

export function runFasBundleTests(): void {
  const bundle = makeBundle();
  const encoded = writeFasBundle(bundle);
  const parsed = readFasBundle(encoded);

  // 1 ── write → read preserves device, preset identity and cabs
  if (parsed.device.deviceId !== 0x11 || parsed.device.deviceMajor !== 13 || parsed.device.deviceMinor !== 0) {
    fail('device did not round-trip');
  }
  if (parsed.preset.location !== 12 || parsed.preset.name !== 'My Preset') fail('preset identity did not round-trip');
  if (parsed.cabs.length !== 2 || parsed.cabs[0].cabId !== 2048 || parsed.cabs[1].cabId !== 2049) {
    fail('cab metadata did not round-trip');
  }

  // 2 ── manifest schema and element/attribute order
  const archive = readZipArchive(encoded);
  const manifestBytes = archive.get(FAS_BUNDLE_MANIFEST_ENTRY);
  if (manifestBytes === undefined) fail('manifest entry missing');
  const manifestText = toText(manifestBytes);
  if (!manifestText.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) fail('XML declaration missing');
  const root = parseXml(manifestBytes);
  if (root.name !== 'Bundle-Map' || xmlAttribute(root, 'version') !== '1') fail('manifest root');
  const device = xmlChildren(root, 'Device')[0];
  if (device.attributes.map((a) => a.name).join(',') !== 'deviceId,deviceMajor,deviceMinor') {
    fail('Device attribute order');
  }
  const presetElement = xmlChildren(root, 'Preset')[0];
  if (presetElement.attributes.map((a) => a.name).join(',') !== 'Location,Name,File') {
    fail('Preset attribute order');
  }
  const cabElements = xmlChildren(root, 'CabData');
  if (cabElements.length !== 2) fail('CabData count');
  if (cabElements[0].attributes.map((a) => a.name).join(',') !== 'CabID,Channel,SlotIndex,Bank,Number,Name,File') {
    fail('CabData attribute order');
  }

  // 3 ── entry order is manifest, preset, cabs
  if ([...archive.keys()].join('|') !== '.bundle|preset|cab-0|cab-1') fail(`entry order ${[...archive.keys()]}`);

  // 4 ── preset body is the concatenated 0x78 payloads
  const presetBytes = archive.get('preset');
  if (presetBytes === undefined || presetBytes.length !== 8 * FAS_BUNDLE_CHUNK_PAYLOAD_LEN) fail('preset size');
  for (let i = 0; i < 8; i++) {
    const local = presetBytes.subarray(i * FAS_BUNDLE_CHUNK_PAYLOAD_LEN, (i + 1) * FAS_BUNDLE_CHUNK_PAYLOAD_LEN);
    if (local.some((b, j) => b !== bundle.preset.chunkPayloads[i][j])) fail(`preset chunk ${i + 1} changed`);
  }

  // 5 ── cab entries are the exact 8,192-byte records, not frames
  const cabBytes = archive.get('cab-0');
  if (cabBytes === undefined || cabBytes.length !== FAS_BUNDLE_CAB_RECORD_LEN) fail('cab entry size');
  if (cabBytes[0] !== 0x5a || cabBytes[FAS_BUNDLE_CAB_RECORD_LEN - 1] !== 0x5a) fail('cab entry bytes changed');

  // 6 ── names with XML metacharacters round-trip
  const special = makeBundle({
    preset: { location: 0, name: 'A&B <x> "q" \'z\'', chunkPayloads: bundle.preset.chunkPayloads },
    cabs: [{ ...cab(0x11, 0), name: 'Cab & <IR> "x"' }],
  });
  const specialParsed = readFasBundle(writeFasBundle(special));
  if (specialParsed.preset.name !== 'A&B <x> "q" \'z\'') fail('preset name escaping');
  if (specialParsed.cabs[0].name !== 'Cab & <IR> "x"') fail('cab name escaping');

  // 7 ── restore preamble is the 0x46 {0x7F,0x00} frame
  const preamble = buildBundleRestorePreamble(0x11);
  if ([...preamble].map((b) => b.toString(16)).join(' ') !== 'f0 0 1 74 11 46 7f 0 2d f7') {
    fail(`preamble ${[...preamble]}`);
  }

  // 8 ── restore file = preamble + re-framed 0x77/0x78/0x79
  const headerPayload = Uint8Array.from([0, 12, 0, 0x40, 0]);
  const restore = encodeBundleRestoreFile(parsed, { headerPayload });
  const expectedLength = preamble.length + 13 + 8 * 3082 + 11;
  if (restore.length !== expectedLength) fail(`restore length ${restore.length} != ${expectedLength}`);
  const first = readFractalFrame(restore, 0, 'restore preamble');
  if (first.func !== 0x46 || first.payload.length !== 2 || first.payload[0] !== 0x7f || first.payload[1] !== 0x00) {
    fail('restore preamble frame');
  }
  const dump = parsePresetDump(restore.subarray(preamble.length), 0, 0x11);
  if (dump.chunkPayloads.length !== 8) fail('restore chunk count');
  for (let i = 0; i < 8; i++) {
    if (dump.chunkPayloads[i].some((b, j) => b !== parsed.preset.chunkPayloads[i][j])) {
      fail(`restore chunk ${i + 1} differs`);
    }
  }
  const footer = bundlePresetFooterPayload(parsed.preset.chunkPayloads);
  if (dump.footerPayload.some((b, i) => b !== footer[i])) fail('restore footer differs');

  // 9 ── a missing Device element is tolerated (all attributes default to 0)
  const noDevice = readFasBundle(
    bundleZip(manifest('<Preset Location="0" Name="P" File="preset"/>'), [presetEntry()]),
  );
  if (noDevice.device.deviceId !== 0 || noDevice.device.deviceMajor !== 0 || noDevice.device.deviceMinor !== 0) {
    fail('missing Device defaults');
  }

  // 10 ── EMPTY cab references synthesize the all-0xFF placeholder
  const emptyCab = readFasBundle(
    bundleZip(
      standardManifest('<CabData CabID="EMPTY" Channel="0" SlotIndex="0" Name="&lt;EMPTY&gt;" File="missing"/>'),
      [presetEntry()],
    ),
  );
  if (emptyCab.cabs.length !== 1 || emptyCab.cabs[0].record.length !== FAS_BUNDLE_CAB_RECORD_LEN) fail('EMPTY cab size');
  if (emptyCab.cabs[0].record[0] !== 0x3c || emptyCab.cabs[0].record[1] !== 0x45) fail('EMPTY cab text');
  let emptyTail = true;
  for (let i = 7; i < FAS_BUNDLE_CAB_RECORD_LEN; i++) if (emptyCab.cabs[0].record[i] !== 0xff) emptyTail = false;
  if (!emptyTail) fail('EMPTY cab is not 0xFF-filled');

  // 11 ── a missing non-EMPTY cab is an error
  expectThrow(
    () => readFasBundle(bundleZip(standardManifest('<CabData CabID="2048" File="missing"/>'), [presetEntry()])),
    /cab file not found/,
    'missing cab',
  );

  // 12 ── a cab record must be exactly 8,192 bytes
  expectThrow(
    () => readFasBundle(
      bundleZip(standardManifest('<CabData CabID="2048" File="cab"/>'), [
        presetEntry(),
        { name: 'cab', data: new Uint8Array(FAS_BUNDLE_CAB_RECORD_LEN - 1) },
      ]),
    ),
    /cab record is 8191 bytes/,
    'cab size',
  );

  // 13 ── a zero-byte preset entry is rejected
  expectThrow(
    () => readFasBundle(bundleZip(standardManifest(), [{ name: 'preset', data: new Uint8Array(0) }])),
    /preset file contained zero bytes/,
    'zero preset',
  );

  // 14 ── a preset entry that is not N × 3,074 is rejected
  expectThrow(
    () => readFasBundle(bundleZip(standardManifest(), [{ name: 'preset', data: new Uint8Array(FAS_BUNDLE_CHUNK_PAYLOAD_LEN + 1) }])),
    /not a multiple/,
    'preset multiple',
  );

  // 15 ── preset payload bytes are 7-bit wire bytes
  const high = chunk(1);
  high[100] = 0x80;
  expectThrow(
    () => readFasBundle(bundleZip(standardManifest(), [{ name: 'preset', data: high }])),
    /not 7-bit/,
    'preset high byte',
  );

  // 16 ── version must be 1
  expectThrow(
    () => readFasBundle(bundleZip(standardManifest().replace('version="1"', 'version="2"'), [presetEntry()])),
    /invalid version number 2/,
    'version 2',
  );

  // 17 ── root element must be Bundle-Map
  expectThrow(
    () => readFasBundle(
      bundleZip(manifest('<Preset Location="0" File="preset"/>').replaceAll('Bundle-Map', 'Other'), [presetEntry()]),
    ),
    /expected <Bundle-Map>/,
    'root',
  );

  // 18 ── exactly one Preset is required
  expectThrow(
    () => readFasBundle(bundleZip(manifest('<Device deviceId="17"/>'), [presetEntry()])),
    /missing <Preset>/,
    'missing preset',
  );

  // 19 ── duplicate Device elements are rejected
  expectThrow(
    () => readFasBundle(
      bundleZip(
        manifest('<Device deviceId="17"/><Device deviceId="17"/><Preset Location="0" File="preset"/>'),
        [presetEntry()],
      ),
    ),
    /more than one <Device>/,
    'duplicate Device',
  );

  // 20 ── duplicate Preset elements are rejected
  expectThrow(
    () => readFasBundle(
      bundleZip(
        manifest('<Preset Location="0" File="preset"/><Preset Location="1" File="preset"/>'),
        [presetEntry()],
      ),
    ),
    /more than one <Preset>/,
    'duplicate Preset',
  );

  // 21 ── unsafe File names are rejected
  for (const file of ['../x', '/abs', 'a\\b', 'C:x']) {
    expectThrow(
      () => readFasBundle(bundleZip(manifest(`<Preset Location="0" File="${file}"/>`), [presetEntry()])),
      /name|path|absolute|backslash|colon|segment/,
      `File ${file}`,
    );
  }

  // 22 ── Preset File must not be the manifest entry
  expectThrow(
    () => readFasBundle(bundleZip(standardManifest().replace('File="preset"', 'File=".bundle"'))),
    /manifest entry/,
    'preset File .bundle',
  );

  // 23 ── unknown elements and attributes are ignored
  const unknown = readFasBundle(
    bundleZip(
      manifest(
        '<Device deviceId="17" extra="x"/><Extra foo="1"/><Preset Location="0" Name="P" File="preset" Bogus="2"/>',
      ),
      [presetEntry()],
    ),
  );
  if (unknown.device.deviceId !== 0x11 || unknown.preset.name !== 'P') fail('unknown markup handling');

  // 24 ── maxCabs is enforced on read
  expectThrow(
    () => readFasBundle(
      bundleZip(
        standardManifest('<CabData CabID="1" File="cab0"/><CabData CabID="2" File="cab1"/>'),
        [
          presetEntry(),
          { name: 'cab0', data: new Uint8Array(FAS_BUNDLE_CAB_RECORD_LEN) },
          { name: 'cab1', data: new Uint8Array(FAS_BUNDLE_CAB_RECORD_LEN) },
        ],
      ),
      { maxCabs: 1 },
    ),
    /more than 1 <CabData>/,
    'maxCabs read',
  );

  // 25 ── maxPresetChunks is enforced on read
  expectThrow(
    () => readFasBundle(bundleZip(standardManifest(), [presetEntry()]), { maxPresetChunks: 4 }),
    /8 chunks \(maximum 4\)/,
    'maxPresetChunks',
  );

  // 26 ── the writer rejects a wrong cab record size
  expectThrow(
    () => writeFasBundle(makeBundle({ cabs: [{ ...cab(0, 0), record: new Uint8Array(10) }] })),
    /expected 8192/,
    'write cab size',
  );

  // 27 ── the writer rejects a wrong chunk size
  expectThrow(
    () => writeFasBundle(makeBundle({ preset: { location: 0, name: 'P', chunkPayloads: [new Uint8Array(10)] } })),
    /expected 3074/,
    'write chunk size',
  );

  // 28 ── a missing or zero-byte manifest is rejected
  expectThrow(
    () => readFasBundle(writeStoredZipArchive([{ name: 'preset', data: bytes('x') }])),
    /Bundle map file not found/,
    'missing manifest',
  );
  expectThrow(
    () => readFasBundle(writeStoredZipArchive([{ name: FAS_BUNDLE_MANIFEST_ENTRY, data: new Uint8Array(0) }])),
    /zero bytes/,
    'zero manifest',
  );

  // 29 ── missing numeric attributes default: Location 0, SlotIndex = document order
  const defaults = readFasBundle(
    bundleZip(
      manifest(
        '<Preset Name="P" File="preset"/>' +
          '<CabData CabID="1" File="cab0"/><CabData CabID="2" File="cab1"/>',
      ),
      [
        presetEntry(),
        { name: 'cab0', data: new Uint8Array(FAS_BUNDLE_CAB_RECORD_LEN) },
        { name: 'cab1', data: new Uint8Array(FAS_BUNDLE_CAB_RECORD_LEN) },
      ],
    ),
  );
  if (defaults.preset.location !== 0) fail('default Location');
  if (defaults.cabs[0].slotIndex !== 0 || defaults.cabs[1].slotIndex !== 1) fail('default SlotIndex order');

  // 30 ── footer/restore inputs are validated
  expectThrow(() => bundlePresetFooterPayload([]), /no chunks/, 'footer no chunks');
  expectThrow(
    () => encodeBundleRestoreFile(parsed, { headerPayload: Uint8Array.from([0, 0]) }),
    /expected 5/,
    'restore header length',
  );
  expectThrow(
    () => encodeBundleRestoreFile(parsed, { headerPayload: Uint8Array.from([0, 0, 0, 0x80, 0]) }),
    /not 7-bit/,
    'restore header high byte',
  );
}
