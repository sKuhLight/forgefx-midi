/**
 * Preset + cab bundle (`.fasBundle`) — offline reader/writer.
 *
 * The container is a plain ZIP with an XML manifest in the entry named
 * `.bundle`:
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <Bundle-Map version="1">
 *     <Device deviceId="17" deviceMajor="13" deviceMinor="0"/>
 *     <Preset Location="12" Name="My Preset" File="preset"/>
 *     <CabData CabID="2048" Channel="0" SlotIndex="0" Bank="0" Number="0"
 *              Name="OH 412 MES V30" File="cab-0"/>
 *   </Bundle-Map>
 *
 * `version` must be 1. `Device` is optional (all three attributes default to
 * 0). `CabData` elements are in bundle order; their `File` values name the ZIP
 * entries. The preset entry is the `0x78` chunk payloads with the frame
 * envelope stripped (8 × 3,074 = 24,592 bytes on FM3/FM9). Whether the entry
 * holds the RAW 7-bit payload bytes or a 7-bit-unpacked body is inferred (MED)
 * from the reference reader's concatenation step; one bundle produced by the
 * editor settles it. A cab entry is the decoded 8,192-byte cab record — not
 * `0x7A/0x7B/0x7C` frames (an inferred, MED-HIGH reading).
 *
 * The writer emits stored ZIP entries (valid PKZIP; readers that accept method
 * 0 take it) because a compressor is out of scope. Reads accept store and
 * deflate. All limits and validation are in zipArchive.ts / xml.ts; this module
 * adds the bundle schema, entry-size checks and the `EMPTY` cab placeholder.
 *
 * Restore conversion is offline only: the `0x46 {0x7F,0x00}` preamble plus
 * re-framed `0x77/0x78/0x79` bytes. Reusing that restore path for bundle import
 * is inferred (MED; the exact editor call edge was not recovered). Nothing here
 * sends or applies anything, and the device write direction itself remains
 * hardware-unverified.
 */

import {
  assertSafeEntryName,
  readZipArchive,
  writeStoredZipArchive,
  DEFAULT_ZIP_LIMITS,
  type ZipEntry,
  type ZipLimits,
} from '../../shared/zipArchive.js';
import {
  parseXml,
  serializeXml,
  xmlAttribute,
  isWhitespaceText,
  DEFAULT_XML_LIMITS,
  type XmlElement,
  type XmlLimits,
} from '../../shared/xml.js';
import { buildFractalFrame } from './frame.js';
import { serializePresetDump, type ParsedPresetDump } from './presetDump.js';
import { computeRawPatchXor, decode3to16 } from './presetHuffman.js';

export const FAS_BUNDLE_MANIFEST_ENTRY = '.bundle';
export const FAS_BUNDLE_VERSION = 1;
export const FAS_BUNDLE_CHUNK_PAYLOAD_LEN = 3074;
export const FAS_BUNDLE_CAB_RECORD_LEN = 8192;
/** Canonical FM3/FM9 preset body: 8 × 3,074 = 24,592 bytes. */
export const FAS_BUNDLE_PRESET_CHUNKS = 8;
export const FAS_BUNDLE_EMPTY_CAB_IDS = Object.freeze(['EMPTY', '<EMPTY>'] as const);
export const FAS_BUNDLE_RESTORE_PREAMBLE_FUNC = 0x46;

export interface FasBundleDevice {
  readonly deviceId: number;
  readonly deviceMajor: number;
  readonly deviceMinor: number;
}

export interface FasBundlePreset {
  /** Source preset slot from the manifest. */
  readonly location: number;
  readonly name: string;
  /** `0x78` payloads, envelope stripped, in dump order. */
  readonly chunkPayloads: readonly Uint8Array[];
}

export interface FasBundleCab {
  /** Cab reference; user cabs are 2048 + index. */
  readonly cabId: number;
  /** Cab-block channel the reference came from (0..3). */
  readonly channel: number;
  /** Document order. */
  readonly slotIndex: number;
  /** Import placement, informational. */
  readonly bank: number;
  /** Import placement, informational. */
  readonly number: number;
  readonly name: string;
  /** Decoded 8,192-byte cab record. */
  readonly record: Uint8Array;
}

export interface FasBundle {
  readonly version: 1;
  readonly device: FasBundleDevice;
  readonly preset: FasBundlePreset;
  readonly cabs: readonly FasBundleCab[];
}

export interface FasBundleLimits {
  zip?: Partial<ZipLimits>;
  xml?: Partial<XmlLimits>;
  maxPresetChunks?: number;
  maxCabs?: number;
  maxNameLength?: number;
}

interface ResolvedBundleLimits {
  zip: ZipLimits;
  xml: XmlLimits;
  maxPresetChunks: number;
  maxCabs: number;
  maxNameLength: number;
}

const DEFAULT_BUNDLE_LIMITS = {
  maxPresetChunks: 64,
  maxCabs: 512,
  maxNameLength: 128,
};

function resolveLimits(limits?: FasBundleLimits): ResolvedBundleLimits {
  return {
    zip: { ...DEFAULT_ZIP_LIMITS, ...limits?.zip },
    xml: { ...DEFAULT_XML_LIMITS, ...limits?.xml },
    maxPresetChunks: limits?.maxPresetChunks ?? DEFAULT_BUNDLE_LIMITS.maxPresetChunks,
    maxCabs: limits?.maxCabs ?? DEFAULT_BUNDLE_LIMITS.maxCabs,
    maxNameLength: limits?.maxNameLength ?? DEFAULT_BUNDLE_LIMITS.maxNameLength,
  };
}

function assertUint(value: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${what}: ${value} is out of range (0..${max})`);
  }
}

function assertDisplayName(name: string, maxLength: number, what: string): void {
  if (name.length > maxLength) throw new Error(`${what}: name is ${name.length} characters (maximum ${maxLength})`);
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(`${what}: name contains a control character at ${i}`);
    }
  }
}

function readIntAttribute(
  element: XmlElement,
  name: string,
  defaultValue: number,
  max: number,
  what: string,
): number {
  const raw = xmlAttribute(element, name);
  if (raw === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${what}: attribute ${name} is not a decimal integer: ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    throw new Error(`${what}: attribute ${name} ${raw} is out of range (0..${max})`);
  }
  return value;
}

function readStringAttribute(
  element: XmlElement,
  name: string,
  defaultValue: string,
  maxLength: number,
  what: string,
): string {
  const raw = xmlAttribute(element, name);
  if (raw === undefined) return defaultValue;
  assertDisplayName(raw, maxLength, `${what} ${name}`);
  return raw;
}

function assertElementText(element: XmlElement): void {
  if (!isWhitespaceText(element.text)) {
    throw new Error(`bundle: <${element.name}> contains unexpected text`);
  }
}

function emptyCabRecord(): Uint8Array {
  const record = new Uint8Array(FAS_BUNDLE_CAB_RECORD_LEN).fill(0xff);
  const text = '<EMPTY>';
  for (let i = 0; i < text.length; i++) record[i] = text.charCodeAt(i);
  return record;
}

/**
 * A preset entry is the concatenated `0x78` payload bytes; every byte is a
 * 7-bit wire value under the inferred (MED) reading that the entry is the RAW
 * payload stream, not a 7-bit-unpacked body. One `.fasBundle` produced by the
 * editor settles that open item; until then, reject a non-7-bit body rather
 * than silently reinterpreting it.
 */
function assertPresetChunk(chunk: Uint8Array, what: string): void {
  if (chunk.length !== FAS_BUNDLE_CHUNK_PAYLOAD_LEN) {
    throw new Error(`${what}: ${chunk.length} bytes, expected ${FAS_BUNDLE_CHUNK_PAYLOAD_LEN}`);
  }
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] > 0x7f) throw new Error(`${what}: byte ${i} is not 7-bit`);
  }
}

/**
 * The reference reader treats an entry as EMPTY from the CabID-side string
 * (`EMPTY` / `<EMPTY>`). This helper also accepts the same spellings in `Name`
 * or `File`, which is broader than described: a producer that puts the
 * placeholder in a different attribute still yields the all-0xFF record
 * instead of a missing-file error.
 */
function isEmptyCabReference(cabIdText: string | undefined, cab: XmlElement): boolean {
  if (cabIdText !== undefined && (FAS_BUNDLE_EMPTY_CAB_IDS as readonly string[]).includes(cabIdText)) {
    return true;
  }
  const name = xmlAttribute(cab, 'Name');
  const file = xmlAttribute(cab, 'File');
  for (const value of [name, file]) {
    if (value !== undefined && (FAS_BUNDLE_EMPTY_CAB_IDS as readonly string[]).includes(value)) return true;
  }
  return false;
}

/**
 * Parse a `.fasBundle` from its raw bytes. Unknown XML elements/attributes are
 * ignored (the reference reader looks up by name); malformed bundles, unsafe
 * entry names, duplicate ZIP entries, oversized entries and wrong payload
 * lengths throw.
 */
export function readFasBundle(bytes: Uint8Array, limits?: FasBundleLimits): FasBundle {
  const lim = resolveLimits(limits);
  const archive = readZipArchive(bytes, lim.zip);
  const manifestBytes = archive.get(FAS_BUNDLE_MANIFEST_ENTRY);
  if (manifestBytes === undefined) throw new Error('bundle: Bundle map file not found');
  if (manifestBytes.length === 0) throw new Error('bundle: bundle map file contained zero bytes');
  const root = parseXml(manifestBytes, lim.xml);
  if (root.name !== 'Bundle-Map') {
    throw new Error(`bundle: root element is <${root.name}>, expected <Bundle-Map>`);
  }
  assertElementText(root);
  const versionRaw = xmlAttribute(root, 'version');
  if (versionRaw === undefined) throw new Error('bundle: missing Bundle-Map version');
  if (!/^(0|[1-9][0-9]*)$/.test(versionRaw)) {
    throw new Error(`bundle: invalid Bundle-Map version ${JSON.stringify(versionRaw)}`);
  }
  const version = Number(versionRaw);
  if (version !== FAS_BUNDLE_VERSION) {
    throw new Error(`bundle: Bundle map contains invalid version number ${version}`);
  }

  let device: FasBundleDevice | undefined;
  let preset: { location: number; name: string; file: string } | undefined;
  const cabElements: XmlElement[] = [];

  for (const child of root.children) {
    assertElementText(child);
    if (child.name === 'Device') {
      if (device !== undefined) throw new Error('bundle: more than one <Device> element');
      device = {
        deviceId: readIntAttribute(child, 'deviceId', 0, 0xffff, 'bundle Device'),
        deviceMajor: readIntAttribute(child, 'deviceMajor', 0, 0xffffffff, 'bundle Device'),
        deviceMinor: readIntAttribute(child, 'deviceMinor', 0, 0xffffffff, 'bundle Device'),
      };
    } else if (child.name === 'Preset') {
      if (preset !== undefined) throw new Error('bundle: more than one <Preset> element');
      const file = readStringAttribute(child, 'File', '', lim.zip.maxNameLength, 'bundle Preset');
      if (file.length === 0) throw new Error('bundle: <Preset> has no File attribute');
      preset = {
        location: readIntAttribute(child, 'Location', 0, 0xffffffff, 'bundle Preset'),
        name: readStringAttribute(child, 'Name', '', lim.maxNameLength, 'bundle Preset'),
        file,
      };
    } else if (child.name === 'CabData') {
      cabElements.push(child);
      if (cabElements.length > lim.maxCabs) {
        throw new Error(`bundle: more than ${lim.maxCabs} <CabData> elements`);
      }
    }
  }

  if (preset === undefined) throw new Error('bundle: missing <Preset> element');
  assertSafeEntryName(preset.file, lim.zip.maxNameLength, 'bundle Preset File');
  if (preset.file === FAS_BUNDLE_MANIFEST_ENTRY) {
    throw new Error('bundle: <Preset File> must not be the manifest entry');
  }

  const presetBytes = archive.get(preset.file);
  if (presetBytes === undefined) throw new Error(`bundle: preset file not found: ${JSON.stringify(preset.file)}`);
  if (presetBytes.length === 0) throw new Error('bundle: preset file contained zero bytes');
  if (presetBytes.length % FAS_BUNDLE_CHUNK_PAYLOAD_LEN !== 0) {
    throw new Error(
      `bundle: preset entry is ${presetBytes.length} bytes, not a multiple of ${FAS_BUNDLE_CHUNK_PAYLOAD_LEN}`,
    );
  }
  const chunkCount = presetBytes.length / FAS_BUNDLE_CHUNK_PAYLOAD_LEN;
  if (chunkCount === 0) throw new Error('bundle: preset entry has no chunks');
  if (chunkCount > lim.maxPresetChunks) {
    throw new Error(`bundle: preset entry has ${chunkCount} chunks (maximum ${lim.maxPresetChunks})`);
  }
  const chunkPayloads: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = presetBytes.slice(i * FAS_BUNDLE_CHUNK_PAYLOAD_LEN, (i + 1) * FAS_BUNDLE_CHUNK_PAYLOAD_LEN);
    assertPresetChunk(chunk, `bundle: preset chunk ${i + 1}`);
    chunkPayloads.push(chunk);
  }

  const cabs: FasBundleCab[] = [];
  for (let index = 0; index < cabElements.length; index++) {
    const element = cabElements[index];
    const what = `bundle CabData ${index + 1}`;
    const cabIdText = xmlAttribute(element, 'CabID');
    const cabIdIsEmpty =
      cabIdText !== undefined && (FAS_BUNDLE_EMPTY_CAB_IDS as readonly string[]).includes(cabIdText);
    const file = readStringAttribute(element, 'File', '', lim.zip.maxNameLength, what);
    const name = readStringAttribute(element, 'Name', '', lim.maxNameLength, what);
    const channel = readIntAttribute(element, 'Channel', 0, 3, what);
    const slotIndex = readIntAttribute(element, 'SlotIndex', index, 0xffffffff, what);
    const bank = readIntAttribute(element, 'Bank', 0, 0xffffffff, what);
    const number = readIntAttribute(element, 'Number', 0, 0xffffffff, what);
    const cabId = cabIdIsEmpty ? 0 : readIntAttribute(element, 'CabID', 0, 0xffffffff, what);
    if (file.length > 0) {
      assertSafeEntryName(file, lim.zip.maxNameLength, `${what} File`);
      if (file === FAS_BUNDLE_MANIFEST_ENTRY) throw new Error(`${what}: File must not be the manifest entry`);
    }

    let record: Uint8Array | undefined;
    if (file.length > 0) record = archive.get(file);
    if (record === undefined) {
      if (!isEmptyCabReference(cabIdText, element)) {
        throw new Error(`${what}: cab file not found: ${JSON.stringify(file)}`);
      }
      record = emptyCabRecord();
    } else {
      if (record.length === 0) throw new Error(`${what}: cab file contained zero bytes`);
      if (record.length !== FAS_BUNDLE_CAB_RECORD_LEN) {
        throw new Error(
          `${what}: cab record is ${record.length} bytes, expected ${FAS_BUNDLE_CAB_RECORD_LEN}`,
        );
      }
    }
    cabs.push({ cabId, channel, slotIndex, bank, number, name, record });
  }

  return {
    version: 1,
    device: device ?? { deviceId: 0, deviceMajor: 0, deviceMinor: 0 },
    preset: { location: preset.location, name: preset.name, chunkPayloads },
    cabs,
  };
}

function xmlElement(
  name: string,
  attributes: ReadonlyArray<readonly [string, string]>,
  children: XmlElement[] = [],
): XmlElement {
  return {
    name,
    attributes: attributes.map(([attrName, value]) => ({ name: attrName, value })),
    children,
    text: '',
  };
}

/**
 * Build a `.fasBundle`. Entry names are generated (`preset`, `cab-0`, …) and
 * referenced verbatim from the manifest; cab records must be exactly 8,192
 * bytes and preset chunks exactly 3,074 bytes.
 */
export function writeFasBundle(bundle: FasBundle, limits?: FasBundleLimits): Uint8Array {
  const lim = resolveLimits(limits);
  if (bundle.version !== FAS_BUNDLE_VERSION) {
    throw new Error(`bundle: invalid version ${bundle.version}`);
  }
  assertUint(bundle.device.deviceId, 0xffff, 'bundle deviceId');
  assertUint(bundle.device.deviceMajor, 0xffffffff, 'bundle deviceMajor');
  assertUint(bundle.device.deviceMinor, 0xffffffff, 'bundle deviceMinor');
  assertUint(bundle.preset.location, 0xffffffff, 'bundle preset location');
  assertDisplayName(bundle.preset.name, lim.maxNameLength, 'bundle preset');
  if (bundle.preset.chunkPayloads.length === 0) throw new Error('bundle: preset has no chunks');
  if (bundle.preset.chunkPayloads.length > lim.maxPresetChunks) {
    throw new Error(`bundle: preset has ${bundle.preset.chunkPayloads.length} chunks (maximum ${lim.maxPresetChunks})`);
  }
  for (let i = 0; i < bundle.preset.chunkPayloads.length; i++) {
    assertPresetChunk(bundle.preset.chunkPayloads[i], `bundle: preset chunk ${i + 1}`);
  }
  if (bundle.cabs.length > lim.maxCabs) {
    throw new Error(`bundle: ${bundle.cabs.length} cabs (maximum ${lim.maxCabs})`);
  }
  for (let i = 0; i < bundle.cabs.length; i++) {
    const cab = bundle.cabs[i];
    assertUint(cab.cabId, 0xffffffff, `bundle cab ${i + 1} CabID`);
    assertUint(cab.channel, 3, `bundle cab ${i + 1} Channel`);
    assertUint(cab.slotIndex, 0xffffffff, `bundle cab ${i + 1} SlotIndex`);
    assertUint(cab.bank, 0xffffffff, `bundle cab ${i + 1} Bank`);
    assertUint(cab.number, 0xffffffff, `bundle cab ${i + 1} Number`);
    assertDisplayName(cab.name, lim.maxNameLength, `bundle cab ${i + 1}`);
    if (cab.record.length !== FAS_BUNDLE_CAB_RECORD_LEN) {
      throw new Error(
        `bundle: cab ${i + 1} record is ${cab.record.length} bytes, expected ${FAS_BUNDLE_CAB_RECORD_LEN}`,
      );
    }
  }

  const presetFile = 'preset';
  const cabFiles = bundle.cabs.map((_, index) => `cab-${index}`);
  assertSafeEntryName(presetFile, lim.zip.maxNameLength, 'bundle preset file');
  const deviceElement = xmlElement('Device', [
    ['deviceId', String(bundle.device.deviceId)],
    ['deviceMajor', String(bundle.device.deviceMajor)],
    ['deviceMinor', String(bundle.device.deviceMinor)],
  ]);
  const presetElement = xmlElement('Preset', [
    ['Location', String(bundle.preset.location)],
    ['Name', bundle.preset.name],
    ['File', presetFile],
  ]);
  const cabElements = bundle.cabs.map((cab, index) =>
    xmlElement('CabData', [
      ['CabID', String(cab.cabId)],
      ['Channel', String(cab.channel)],
      ['SlotIndex', String(cab.slotIndex)],
      ['Bank', String(cab.bank)],
      ['Number', String(cab.number)],
      ['Name', cab.name],
      ['File', cabFiles[index]],
    ]),
  );
  const root = xmlElement(
    'Bundle-Map',
    [['version', String(FAS_BUNDLE_VERSION)]],
    [deviceElement, presetElement, ...cabElements],
  );

  const presetBody = new Uint8Array(bundle.preset.chunkPayloads.length * FAS_BUNDLE_CHUNK_PAYLOAD_LEN);
  for (let i = 0; i < bundle.preset.chunkPayloads.length; i++) {
    presetBody.set(bundle.preset.chunkPayloads[i], i * FAS_BUNDLE_CHUNK_PAYLOAD_LEN);
  }

  const entries: ZipEntry[] = [
    { name: FAS_BUNDLE_MANIFEST_ENTRY, data: serializeXml(root) },
    { name: presetFile, data: presetBody },
    ...bundle.cabs.map((cab, index) => ({ name: cabFiles[index], data: cab.record })),
  ];
  return writeStoredZipArchive(entries, lim.zip);
}

/** The `0x46 {0x7F,0x00}` preamble that precedes a restored preset file. */
export function buildBundleRestorePreamble(modelId: number): Uint8Array {
  return buildFractalFrame(modelId, FAS_BUNDLE_RESTORE_PREAMBLE_FUNC, Uint8Array.from([0x7f, 0x00]));
}

/**
 * Recompute the `0x79` footer payload from a bundle's preset body: XOR of every
 * little-endian 16-bit word of the decoded raw patch, as 3 septets.
 */
export function bundlePresetFooterPayload(chunkPayloads: readonly Uint8Array[]): Uint8Array {
  if (chunkPayloads.length === 0) throw new Error('bundle: preset has no chunks');
  let packedLength = 0;
  for (let i = 0; i < chunkPayloads.length; i++) {
    assertPresetChunk(chunkPayloads[i], `bundle: preset chunk ${i + 1}`);
    packedLength += chunkPayloads[i].length - 2;
  }
  const packed = new Uint8Array(packedLength);
  let offset = 0;
  for (const chunk of chunkPayloads) {
    // The first two payload bytes are the chunk discriminator, not patch data.
    packed.set(chunk.subarray(2), offset);
    offset += chunk.length - 2;
  }
  const rawPatch = decode3to16(packed);
  const xor = computeRawPatchXor(rawPatch);
  return Uint8Array.from([xor & 0x7f, (xor >> 7) & 0x7f, (xor >> 14) & 0x7f]);
}

export interface BundleRestoreOptions {
  /** Model byte for the frames; defaults to the bundle's `deviceId`. */
  modelId?: number;
  /** Five-byte `0x77` header payload; the target slot encoding is device-specific. */
  headerPayload: Uint8Array;
}

/**
 * Encode a bundle's preset as the bytes of a restore file: the `0x46` preamble
 * frame followed by re-framed `0x77/0x78/0x79` bytes. Reusing the `.syx`
 * restore path for bundle import is inferred (MED; the exact editor call edge
 * was not recovered). Offline conversion only — no transport, no slot write, no
 * apply step.
 */
export function encodeBundleRestoreFile(bundle: FasBundle, options: BundleRestoreOptions): Uint8Array {
  const modelId = options.modelId ?? bundle.device.deviceId;
  if (options.headerPayload.length !== 5) {
    throw new Error(`bundle restore: header payload is ${options.headerPayload.length} bytes, expected 5`);
  }
  for (let i = 0; i < options.headerPayload.length; i++) {
    if (options.headerPayload[i] > 0x7f) {
      throw new Error(`bundle restore: header payload byte ${i} is not 7-bit`);
    }
  }
  const footerPayload = bundlePresetFooterPayload(bundle.preset.chunkPayloads);
  const parsed: ParsedPresetDump = {
    modelId,
    raw: new Uint8Array(0),
    byteLength: 0,
    headerPayload: options.headerPayload,
    chunkPayloads: bundle.preset.chunkPayloads,
    footerPayload,
  };
  const dump = serializePresetDump(parsed);
  const preamble = buildBundleRestorePreamble(modelId);
  const out = new Uint8Array(preamble.length + dump.length);
  out.set(preamble, 0);
  out.set(dump, preamble.length);
  return out;
}
