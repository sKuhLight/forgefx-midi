/**
 * Setlist (`.fas-setlist`) and song (`.fas-songs`) XML files.
 *
 *   <Setlists version="1" deviceId="17" deviceMajor="13" deviceMinor="0">
 *     <Setlist id="0" name="Set 1">
 *       <SongId id="0"/>
 *       <SongId id="3"/>
 *     </Setlist>
 *   </Setlists>
 *
 *   <All-Songs version="1" deviceId="17" deviceMajor="13" deviceMinor="0">
 *     <Song id="0" name="Song 1"/>
 *   </All-Songs>
 *
 * `<SongId>` document order is the setlist order. The songs file carries only
 * id + name; the preset/scene content of a song is not in either file — on the
 * unit it lives in parameter tables (six sections per song). This module models
 * that pid mapping as pure arithmetic; it does not build or send `func 0x01`
 * frames.
 *
 * Parsing is strict: only the documented elements and attributes, `version`
 * must be 1, names are length-bounded, and unknown markup throws. No entity
 * expansion (see xml.ts).
 */

import {
  parseXml,
  serializeXml,
  xmlAttribute,
  isWhitespaceText,
  DEFAULT_XML_LIMITS,
  type XmlElement,
  type XmlLimits,
} from '../../shared/xml.js';

export const FAS_SETLIST_ROOT = 'Setlists';
export const FAS_SONGS_ROOT = 'All-Songs';
export const FAS_SETLIST_VERSION = 1;
export const SONG_SECTION_COUNT = 6;
export const SONG_SECTION_NAME_SLOTS = 5;
export const SONG_NAME_SLOTS = 5;

/** Parameter value types observed for the song/setlist tables. */
export const SONG_PARAM_TYPES = Object.freeze({
  sectionPreset: 9,
  sectionScene: 9,
  sectionName: 0x0f,
  songName: 0x0f,
});

export interface FasDeviceHeader {
  readonly deviceId: number;
  readonly deviceMajor: number;
  readonly deviceMinor: number;
}

export interface FasSetlist {
  readonly id: number;
  readonly name: string;
  /** Song ids in setlist order (document order). */
  readonly songIds: readonly number[];
}

export interface FasSetlistsFile {
  readonly version: 1;
  readonly device: FasDeviceHeader;
  readonly setlists: readonly FasSetlist[];
}

export interface FasSong {
  readonly id: number;
  readonly name: string;
}

export interface FasSongsFile {
  readonly version: 1;
  readonly device: FasDeviceHeader;
  readonly songs: readonly FasSong[];
}

export interface FasSetlistLimits {
  xml?: Partial<XmlLimits>;
  maxSetlists?: number;
  maxSongs?: number;
  maxSongRefs?: number;
  maxNameLength?: number;
}

interface ResolvedSetlistLimits {
  xml: XmlLimits;
  maxSetlists: number;
  maxSongs: number;
  maxSongRefs: number;
  maxNameLength: number;
}

const DEFAULT_SETLIST_LIMITS = {
  maxSetlists: 4096,
  maxSongs: 65_536,
  maxSongRefs: 65_536,
  maxNameLength: 255,
};

function resolveLimits(limits?: FasSetlistLimits): ResolvedSetlistLimits {
  return {
    xml: { ...DEFAULT_XML_LIMITS, ...limits?.xml },
    maxSetlists: limits?.maxSetlists ?? DEFAULT_SETLIST_LIMITS.maxSetlists,
    maxSongs: limits?.maxSongs ?? DEFAULT_SETLIST_LIMITS.maxSongs,
    maxSongRefs: limits?.maxSongRefs ?? DEFAULT_SETLIST_LIMITS.maxSongRefs,
    maxNameLength: limits?.maxNameLength ?? DEFAULT_SETLIST_LIMITS.maxNameLength,
  };
}

const HEADER_ATTRIBUTES = new Set(['version', 'deviceId', 'deviceMajor', 'deviceMinor']);

function assertUint(value: number, max: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${what}: ${value} is out of range (0..${max})`);
  }
}

function parseDecimal(raw: string, max: number, what: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${what}: not a decimal integer: ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    throw new Error(`${what}: ${raw} is out of range (0..${max})`);
  }
  return value;
}

function requireAttribute(element: XmlElement, name: string, what: string): string {
  const value = xmlAttribute(element, name);
  if (value === undefined) throw new Error(`${what}: missing ${name} attribute`);
  return value;
}

function readName(element: XmlElement, maxLength: number, what: string): string {
  const value = requireAttribute(element, 'name', what);
  if (value.length > maxLength) {
    throw new Error(`${what}: name is ${value.length} characters (maximum ${maxLength})`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new Error(`${what}: name contains a control character at ${i}`);
  }
  return value;
}

function assertNameForWrite(name: string, maxLength: number, what: string): void {
  if (name.length > maxLength) {
    throw new Error(`${what}: name is ${name.length} characters (maximum ${maxLength})`);
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) throw new Error(`${what}: name contains a control character at ${i}`);
  }
}

function assertElementText(element: XmlElement): void {
  if (!isWhitespaceText(element.text)) {
    throw new Error(`${element.name}: unexpected text content`);
  }
}

function assertAllowedAttributes(element: XmlElement, allowed: readonly string[], what: string): void {
  for (const attr of element.attributes) {
    if (!allowed.includes(attr.name)) {
      throw new Error(`${what}: unsupported attribute ${JSON.stringify(attr.name)}`);
    }
  }
}

function readHeader(root: XmlElement, expectedRoot: string): FasDeviceHeader {
  if (root.name !== expectedRoot) {
    throw new Error(`xml: root element is <${root.name}>, expected <${expectedRoot}>`);
  }
  assertElementText(root);
  for (const attr of root.attributes) {
    if (!HEADER_ATTRIBUTES.has(attr.name)) {
      throw new Error(`${expectedRoot}: unsupported attribute ${JSON.stringify(attr.name)}`);
    }
  }
  const versionRaw = requireAttribute(root, 'version', expectedRoot);
  const version = parseDecimal(versionRaw, 0xffff, `${expectedRoot} version`);
  if (version !== FAS_SETLIST_VERSION) {
    throw new Error(`${expectedRoot}: unsupported version ${version}`);
  }
  const deviceIdRaw = xmlAttribute(root, 'deviceId');
  const majorRaw = xmlAttribute(root, 'deviceMajor');
  const minorRaw = xmlAttribute(root, 'deviceMinor');
  return {
    deviceId: deviceIdRaw === undefined ? 0 : parseDecimal(deviceIdRaw, 0xffff, `${expectedRoot} deviceId`),
    deviceMajor: majorRaw === undefined ? 0 : parseDecimal(majorRaw, 0xffffffff, `${expectedRoot} deviceMajor`),
    deviceMinor: minorRaw === undefined ? 0 : parseDecimal(minorRaw, 0xffffffff, `${expectedRoot} deviceMinor`),
  };
}

function assertNoChildren(element: XmlElement, what: string): void {
  if (element.children.length !== 0) throw new Error(`${what}: unexpected child element <${element.children[0].name}>`);
}

/** Parse `.fas-setlist` bytes. */
export function parseFasSetlists(bytes: Uint8Array, limits?: FasSetlistLimits): FasSetlistsFile {
  const lim = resolveLimits(limits);
  const root = parseXml(bytes, lim.xml);
  const device = readHeader(root, FAS_SETLIST_ROOT);
  const setlists: FasSetlist[] = [];
  const seenIds = new Set<number>();
  let songRefs = 0;
  for (const child of root.children) {
    if (child.name !== 'Setlist') throw new Error(`Setlists: unsupported element <${child.name}>`);
    if (setlists.length >= lim.maxSetlists) {
      throw new Error(`Setlists: more than ${lim.maxSetlists} setlists`);
    }
    assertElementText(child);
    assertAllowedAttributes(child, ['id', 'name'], 'Setlist');
    const id = parseDecimal(requireAttribute(child, 'id', 'Setlist'), 0xffffffff, 'Setlist id');
    if (seenIds.has(id)) throw new Error(`Setlists: duplicate setlist id ${id}`);
    seenIds.add(id);
    const name = readName(child, lim.maxNameLength, 'Setlist');
    const songIds: number[] = [];
    for (const songChild of child.children) {
      if (songChild.name !== 'SongId') throw new Error(`Setlist ${id}: unsupported element <${songChild.name}>`);
      assertElementText(songChild);
      assertAllowedAttributes(songChild, ['id'], `Setlist ${id} SongId`);
      assertNoChildren(songChild, `Setlist ${id} SongId`);
      songRefs += 1;
      if (songRefs > lim.maxSongRefs) throw new Error(`Setlists: more than ${lim.maxSongRefs} song references`);
      songIds.push(parseDecimal(requireAttribute(songChild, 'id', 'SongId'), 0xffffffff, `Setlist ${id} SongId`));
    }
    setlists.push({ id, name, songIds });
  }
  return { version: 1, device, setlists };
}

/** Parse `.fas-songs` bytes. */
export function parseFasSongs(bytes: Uint8Array, limits?: FasSetlistLimits): FasSongsFile {
  const lim = resolveLimits(limits);
  const root = parseXml(bytes, lim.xml);
  const device = readHeader(root, FAS_SONGS_ROOT);
  const songs: FasSong[] = [];
  const seenIds = new Set<number>();
  for (const child of root.children) {
    if (child.name !== 'Song') throw new Error(`All-Songs: unsupported element <${child.name}>`);
    if (songs.length >= lim.maxSongs) throw new Error(`All-Songs: more than ${lim.maxSongs} songs`);
    assertElementText(child);
    assertAllowedAttributes(child, ['id', 'name'], 'Song');
    assertNoChildren(child, 'Song');
    const id = parseDecimal(requireAttribute(child, 'id', 'Song'), 0xffffffff, 'Song id');
    if (seenIds.has(id)) throw new Error(`All-Songs: duplicate song id ${id}`);
    seenIds.add(id);
    songs.push({ id, name: readName(child, lim.maxNameLength, 'Song') });
  }
  return { version: 1, device, songs };
}

function headerElement(rootName: string, device: FasDeviceHeader, children: XmlElement[]): XmlElement {
  assertUint(device.deviceId, 0xffff, 'deviceId');
  assertUint(device.deviceMajor, 0xffffffff, 'deviceMajor');
  assertUint(device.deviceMinor, 0xffffffff, 'deviceMinor');
  return {
    name: rootName,
    attributes: [
      { name: 'version', value: String(FAS_SETLIST_VERSION) },
      { name: 'deviceId', value: String(device.deviceId) },
      { name: 'deviceMajor', value: String(device.deviceMajor) },
      { name: 'deviceMinor', value: String(device.deviceMinor) },
    ],
    children,
    text: '',
  };
}

/** Serialize a `.fas-setlist` document. */
export function serializeFasSetlists(file: FasSetlistsFile): Uint8Array {
  if (file.version !== FAS_SETLIST_VERSION) throw new Error(`Setlists: unsupported version ${file.version}`);
  const seenIds = new Set<number>();
  const children: XmlElement[] = file.setlists.map((setlist) => {
    assertUint(setlist.id, 0xffffffff, 'Setlist id');
    if (seenIds.has(setlist.id)) throw new Error(`Setlists: duplicate setlist id ${setlist.id}`);
    seenIds.add(setlist.id);
    assertNameForWrite(setlist.name, DEFAULT_SETLIST_LIMITS.maxNameLength, `Setlist ${setlist.id}`);
    const songIds: XmlElement[] = setlist.songIds.map((songId) => {
      assertUint(songId, 0xffffffff, `Setlist ${setlist.id} SongId`);
      return { name: 'SongId', attributes: [{ name: 'id', value: String(songId) }], children: [], text: '' };
    });
    return {
      name: 'Setlist',
      attributes: [
        { name: 'id', value: String(setlist.id) },
        { name: 'name', value: setlist.name },
      ],
      children: songIds,
      text: '',
    };
  });
  return serializeXml(headerElement(FAS_SETLIST_ROOT, file.device, children));
}

/** Serialize a `.fas-songs` document. */
export function serializeFasSongs(file: FasSongsFile): Uint8Array {
  if (file.version !== FAS_SETLIST_VERSION) throw new Error(`All-Songs: unsupported version ${file.version}`);
  const seenIds = new Set<number>();
  const children: XmlElement[] = file.songs.map((song) => {
    assertUint(song.id, 0xffffffff, 'Song id');
    if (seenIds.has(song.id)) throw new Error(`All-Songs: duplicate song id ${song.id}`);
    seenIds.add(song.id);
    assertNameForWrite(song.name, DEFAULT_SETLIST_LIMITS.maxNameLength, `Song ${song.id}`);
    return {
      name: 'Song',
      attributes: [
        { name: 'id', value: String(song.id) },
        { name: 'name', value: song.name },
      ],
      children: [],
      text: '',
    };
  });
  return serializeXml(headerElement(FAS_SONGS_ROOT, file.device, children));
}

// ── Device-side parameter tables (mapping only, no frames) ──────────

function assertSongIndex(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${what}: ${value} is not a non-negative integer`);
}

function assertSection(section: number): void {
  if (!Number.isInteger(section) || section < 0 || section >= SONG_SECTION_COUNT) {
    throw new Error(`song section ${section} is out of range (0..${SONG_SECTION_COUNT - 1})`);
  }
}

function assertPid(pid: number, what: string): number {
  if (!Number.isInteger(pid) || pid < 0 || pid > 0xffff) {
    throw new Error(`${what}: computed pid ${pid} is outside the 16-bit parameter range`);
  }
  return pid;
}

/** pid that stores the preset reference of one song section. */
export function songSectionPresetPid(song: number, section: number): number {
  assertSongIndex(song, 'songSectionPresetPid');
  assertSection(section);
  return assertPid((song + 0x893) * 6 + section, 'songSectionPresetPid');
}

/**
 * pid that stores the second value of one song section. The preset/scene pair
 * reading is inferred (the two parallel tables differ by 769); only the pid
 * arithmetic itself is recovered.
 */
export function songSectionScenePid(song: number, section: number): number {
  assertSongIndex(song, 'songSectionScenePid');
  assertSection(section);
  return assertPid(song * 6 + section + 0x3673, 'songSectionScenePid');
}

/** pid for one of the five name slots of a song section. */
export function songSectionNamePid(song: number, section: number, slot: number): number {
  assertSongIndex(song, 'songSectionNamePid');
  assertSection(section);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SONG_SECTION_NAME_SLOTS) {
    throw new Error(`songSectionNamePid: slot ${slot} is out of range (0..${SONG_SECTION_NAME_SLOTS - 1})`);
  }
  return assertPid(((song * 6 + section) + 0x74a) * 5 + slot, 'songSectionNamePid');
}

/** pid for one of the five name slots of a song. */
export function songNamePid(song: number, slot: number): number {
  assertSongIndex(song, 'songNamePid');
  if (!Number.isInteger(slot) || slot < 0 || slot >= SONG_NAME_SLOTS) {
    throw new Error(`songNamePid: slot ${slot} is out of range (0..${SONG_NAME_SLOTS - 1})`);
  }
  return assertPid((song + 0x6ca) * 5 + slot, 'songNamePid');
}
