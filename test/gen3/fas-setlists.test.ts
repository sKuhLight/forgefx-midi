/**
 * `.fas-setlist` / `.fas-songs` XML tests plus the song parameter-table map.
 * Fixtures are synthetic; no frames are built for the device-side tables.
 */
import {
  FAS_SETLIST_VERSION,
  SONG_NAME_SLOTS,
  SONG_PARAM_TYPES,
  SONG_SECTION_COUNT,
  SONG_SECTION_NAME_SLOTS,
  parseFasSetlists,
  parseFasSongs,
  serializeFasSetlists,
  serializeFasSongs,
  songNamePid,
  songSectionNamePid,
  songSectionPresetPid,
  songSectionScenePid,
  type FasSetlistsFile,
  type FasSongsFile,
} from '../../src/devices/gen3/fasSetlists.js';

export const FAS_SETLIST_CASE_COUNT = 29;

function fail(msg: string): never {
  throw new Error(`[gen3/fasSetlists] ${msg}`);
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function text(data: Uint8Array): string {
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

const DEVICE = { deviceId: 0x11, deviceMajor: 13, deviceMinor: 0 };

function setlistXml(body: string, version = '1', attrs = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\r\n<Setlists version="${version}" deviceId="17" deviceMajor="13" deviceMinor="0"${attrs}>${body}</Setlists>`;
}

function songsXml(body: string, version = '1'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\r\n<All-Songs version="${version}" deviceId="17" deviceMajor="13" deviceMinor="0">${body}</All-Songs>`;
}

export function runFasSetlistTests(): void {
  // 1 ── setlists round-trip
  const setlists: FasSetlistsFile = {
    version: 1,
    device: DEVICE,
    setlists: [
      { id: 0, name: 'Set 1', songIds: [0, 3] },
      { id: 4, name: 'Set 2', songIds: [2] },
    ],
  };
  const setlistsParsed = parseFasSetlists(serializeFasSetlists(setlists));
  if (setlistsParsed.setlists.length !== 2) fail('setlist count');
  if (setlistsParsed.device.deviceId !== 0x11) fail('setlist device');

  // 2 ── SongId document order is authoritative
  const ordered = parseFasSetlists(
    bytes(setlistXml('<Setlist id="0" name="S"><SongId id="3"/><SongId id="0"/><SongId id="2"/></Setlist>')),
  );
  if (ordered.setlists[0].songIds.join(',') !== '3,0,2') fail(`setlist order ${ordered.setlists[0].songIds}`);

  // 3 ── songs round-trip
  const songs: FasSongsFile = {
    version: 1,
    device: DEVICE,
    songs: [
      { id: 0, name: 'Song 1' },
      { id: 9, name: 'Song 9' },
    ],
  };
  const songsParsed = parseFasSongs(serializeFasSongs(songs));
  if (songsParsed.songs.length !== 2 || songsParsed.songs[1].id !== 9) fail('songs round-trip');

  // 4 ── empty setlists file is valid
  const emptySetlists = parseFasSetlists(bytes(setlistXml('')));
  if (emptySetlists.setlists.length !== 0) fail('empty setlists');

  // 5 ── empty songs file is valid
  if (parseFasSongs(bytes(songsXml(''))).songs.length !== 0) fail('empty songs');

  // 6 ── missing device attributes default to 0
  const noDevice = parseFasSetlists(bytes('<Setlists version="1"><Setlist id="0" name="S"/></Setlists>'));
  if (noDevice.device.deviceId !== 0 || noDevice.device.deviceMajor !== 0 || noDevice.device.deviceMinor !== 0) {
    fail('device defaults');
  }

  // 7 ── names with XML metacharacters round-trip
  const special: FasSetlistsFile = {
    version: 1,
    device: DEVICE,
    setlists: [{ id: 0, name: "A&B <x> \"q\" 'z'", songIds: [] }],
  };
  if (parseFasSetlists(serializeFasSetlists(special)).setlists[0].name !== "A&B <x> \"q\" 'z'") {
    fail('setlist name escaping');
  }

  // 8 ── version must be 1
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('', '2'))),
    /unsupported version 2/,
    'setlist version',
  );
  expectThrow(() => parseFasSongs(bytes(songsXml('', '3'))), /unsupported version 3/, 'songs version');

  // 9 ── root element must match
  expectThrow(
    () => parseFasSetlists(bytes('<All-Songs version="1"/>')),
    /root element/,
    'setlist root',
  );

  // 10 ── unknown root attributes are rejected
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('', '1', ' bogus="1"'))),
    /unsupported attribute "bogus"/,
    'root attribute',
  );

  // 11 ── unknown child elements are rejected
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Extra/>'))),
    /unsupported element <Extra>/,
    'unknown child',
  );
  expectThrow(
    () => parseFasSongs(bytes(songsXml('<Extra/>'))),
    /unsupported element <Extra>/,
    'unknown song child',
  );

  // 12 ── unknown attributes on Setlist / SongId / Song are rejected
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Setlist id="0" name="S" bogus="1"/>'))),
    /unsupported attribute "bogus"/,
    'Setlist attribute',
  );
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Setlist id="0" name="S"><SongId id="0" bogus="1"/></Setlist>'))),
    /unsupported attribute "bogus"/,
    'SongId attribute',
  );
  expectThrow(
    () => parseFasSongs(bytes(songsXml('<Song id="0" name="S" bogus="1"/>'))),
    /unsupported attribute "bogus"/,
    'Song attribute',
  );

  // 13 ── ids and names are required
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Setlist name="S"/>'))),
    /missing id attribute/,
    'Setlist id required',
  );
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Setlist id="0"/>'))),
    /missing name attribute/,
    'Setlist name required',
  );
  expectThrow(
    () => parseFasSongs(bytes(songsXml('<Song name="S"/>'))),
    /missing id attribute/,
    'Song id required',
  );

  // 14 ── duplicate setlist ids are rejected
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Setlist id="1" name="A"/><Setlist id="1" name="B"/>'))),
    /duplicate setlist id/,
    'duplicate setlist id',
  );

  // 15 ── duplicate song ids are rejected
  expectThrow(
    () => parseFasSongs(bytes(songsXml('<Song id="1" name="A"/><Song id="1" name="B"/>'))),
    /duplicate song id/,
    'duplicate song id',
  );

  // 16 ── decimal ids are strict
  for (const bad of ['01', '-1', 'x', '']) {
    expectThrow(
      () => parseFasSetlists(bytes(setlistXml(`<Setlist id="${bad}" name="S"/>`))),
      /decimal integer|out of range/,
      `id ${JSON.stringify(bad)}`,
    );
  }

  // 17 ── non-whitespace text is rejected
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Setlist id="0" name="S">text</Setlist>'))),
    /unexpected text/,
    'setlist text',
  );

  // 18 ── maxSetlists
  expectThrow(
    () => parseFasSetlists(
      bytes(setlistXml('<Setlist id="0" name="A"/><Setlist id="1" name="B"/>')),
      { maxSetlists: 1 },
    ),
    /more than 1 setlists/,
    'maxSetlists',
  );

  // 19 ── maxSongs
  expectThrow(
    () => parseFasSongs(bytes(songsXml('<Song id="0" name="A"/><Song id="1" name="B"/>')), { maxSongs: 1 }),
    /more than 1 songs/,
    'maxSongs',
  );

  // 20 ── maxSongRefs
  expectThrow(
    () => parseFasSetlists(
      bytes(setlistXml('<Setlist id="0" name="S"><SongId id="0"/><SongId id="1"/></Setlist>')),
      { maxSongRefs: 1 },
    ),
    /more than 1 song references/,
    'maxSongRefs',
  );

  // 21 ── name length limit
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml(`<Setlist id="0" name="${'x'.repeat(20)}"/>`)), { maxNameLength: 4 }),
    /maximum 4/,
    'name length',
  );

  // 22 ── no DOCTYPE / entity expansion path
  expectThrow(
    () => parseFasSetlists(bytes('<!DOCTYPE x [<!ENTITY a "b">]><Setlists version="1">&a;</Setlists>')),
    /DOCTYPE/,
    'DOCTYPE',
  );

  // 23 ── the serializer rejects duplicate ids
  expectThrow(
    () => serializeFasSetlists({
      version: 1,
      device: DEVICE,
      setlists: [{ id: 1, name: 'A', songIds: [] }, { id: 1, name: 'B', songIds: [] }],
    }),
    /duplicate setlist id/,
    'serialize duplicate setlist',
  );
  expectThrow(
    () => serializeFasSongs({
      version: 1,
      device: DEVICE,
      songs: [{ id: 1, name: 'A' }, { id: 1, name: 'B' }],
    }),
    /duplicate song id/,
    'serialize duplicate song',
  );

  // 24 ── SongId must not carry child elements
  expectThrow(
    () => parseFasSetlists(bytes(setlistXml('<Setlist id="0" name="S"><SongId id="0"><X/></SongId></Setlist>'))),
    /unexpected child element/,
    'SongId child',
  );

  // 25 ── song section preset pids (exact recovered arithmetic)
  if (songSectionPresetPid(0, 0) !== 13_170) fail(`preset pid 0/0 = ${songSectionPresetPid(0, 0)}`);
  if (songSectionPresetPid(0, 1) !== 13_171) fail('preset pid 0/1');
  if (songSectionPresetPid(1, 0) !== 13_176) fail('preset pid 1/0');

  // 26 ── song section second-value and name pids
  if (songSectionScenePid(0, 0) !== 13_939) fail(`scene pid 0/0 = ${songSectionScenePid(0, 0)}`);
  if (songSectionScenePid(1, 0) !== 13_945) fail('scene pid 1/0');
  if (songSectionNamePid(0, 0, 0) !== 9_330) fail(`section name pid ${songSectionNamePid(0, 0, 0)}`);
  if (songSectionNamePid(0, 0, 4) !== 9_334) fail('section name slot 4');
  if (songSectionNamePid(1, 0, 0) !== 9_360) fail('section name song 1');

  // 27 ── song name pids
  if (songNamePid(0, 0) !== 8_690) fail(`song name pid ${songNamePid(0, 0)}`);
  if (songNamePid(0, 4) !== 8_694) fail('song name slot 4');
  if (songNamePid(1, 0) !== 8_695) fail('song name song 1');

  // 28 ── pid inputs are range-checked
  expectThrow(() => songSectionPresetPid(0, 6), /out of range/, 'section range');
  expectThrow(() => songSectionNamePid(0, 0, 5), /out of range/, 'slot range');
  expectThrow(() => songNamePid(-1, 0), /non-negative/, 'negative song');
  expectThrow(() => songSectionPresetPid(9000, 0), /16-bit/, 'pid overflow');

  // 29 ── constants match the parameter-table model
  if (SONG_SECTION_COUNT !== 6) fail('SONG_SECTION_COUNT');
  if (SONG_SECTION_NAME_SLOTS !== 5 || SONG_NAME_SLOTS !== 5) fail('name slot counts');
  if (
    SONG_PARAM_TYPES.sectionPreset !== 9 ||
    SONG_PARAM_TYPES.sectionScene !== 9 ||
    SONG_PARAM_TYPES.sectionName !== 0x0f ||
    SONG_PARAM_TYPES.songName !== 0x0f
  ) {
    fail('SONG_PARAM_TYPES');
  }
  if (FAS_SETLIST_VERSION !== 1) fail('FAS_SETLIST_VERSION');
  if (!text(serializeFasSetlists(setlists)).includes('<SongId id="0"/>')) fail('serialized SongId form');
}
