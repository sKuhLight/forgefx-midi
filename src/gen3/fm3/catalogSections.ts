/**
 * Catalog section inventory: every section of the editor cache the FM3 catalog (firmware 12.0) was derived from, with the
 * catalog family the section belongs to (`null` = a system table no family claims; a further
 * instance tag lists its family too) and the section's declared record count (special table
 * records included).
 *
 * A profile classifies an unassigned section of a newer cache against this list: a listed tag is a
 * known `system` section, an unlisted tag is `new` (a block the catalog firmware does not have).
 *
 * Measured on the FM3 editor's caches for firmware 12.0 and 13.0: both carry these 45 tags (fw 13.0 changes record
 * counts of some families, e.g. CHORUS, DELAY, FUZZ, MIXER, but adds or removes no section). One fw 12.0 cache written
 * by a newer editor build holds 10 records in tag 56 instead of 8; the role of a section depends on its tag only.
 *
 * Structural data only (tags, families, counts); the families agree with `FM3_RANGE_SECTIONS` and the
 * null tags with `FM3_UNMAPPED_SECTIONS`.
 */
export const FM3_CATALOG_SECTIONS: readonly { tag: number; family: string | null; records: number }[] = [
  { tag: 1, family: 'GLOBAL', records: 187 },
  { tag: 2, family: 'CONTROLLERS', records: 130 },
  { tag: 3, family: 'MOD', records: 25 },
  { tag: 4, family: null, records: 7 },
  { tag: 7, family: 'COMP', records: 37 },
  { tag: 8, family: 'GEQ', records: 20 },
  { tag: 9, family: 'PEQ', records: 33 },
  { tag: 10, family: 'DISTORT', records: 144 },
  { tag: 11, family: 'CABINET', records: 110 },
  { tag: 12, family: 'REVERB', records: 71 },
  { tag: 13, family: 'DELAY', records: 88 },
  { tag: 14, family: 'MULTITAP', records: 121 },
  { tag: 15, family: 'PLEX', records: 96 },
  { tag: 16, family: 'CHORUS', records: 29 },
  { tag: 17, family: 'FLANGER', records: 33 },
  { tag: 18, family: 'ROTARY', records: 21 },
  { tag: 19, family: 'PHASER', records: 35 },
  { tag: 20, family: 'WAH', records: 25 },
  { tag: 21, family: 'FORMANT', records: 12 },
  { tag: 22, family: 'TREMOLO', records: 22 },
  { tag: 23, family: 'PITCH', records: 114 },
  { tag: 24, family: 'FILTER', records: 37 },
  { tag: 25, family: 'FUZZ', records: 43 },
  { tag: 26, family: 'ENHANCER', records: 12 },
  { tag: 28, family: 'MIXER', records: 17 },
  { tag: 29, family: 'FDBKSEND', records: 2 },
  { tag: 30, family: 'FDBKRET', records: 6 },
  { tag: 31, family: 'SYNTH', records: 42 },
  { tag: 33, family: 'MEGATAP', records: 35 },
  { tag: 35, family: 'GATE', records: 19 },
  { tag: 36, family: 'RINGMOD', records: 13 },
  { tag: 37, family: 'MULTICOMP', records: 37 },
  { tag: 38, family: 'TENTAP', records: 48 },
  { tag: 39, family: 'RESONATOR', records: 40 },
  { tag: 40, family: 'VOLUME', records: 15 },
  { tag: 41, family: 'INPUT', records: 10 },
  { tag: 42, family: 'INPUT', records: 10 },
  { tag: 46, family: 'OUTPUT', records: 26 },
  { tag: 47, family: 'OUTPUT', records: 26 },
  { tag: 50, family: 'LOOPER', records: 24 },
  { tag: 53, family: null, records: 257 },
  { tag: 54, family: 'MULTIPLEXER', records: 7 },
  { tag: 56, family: null, records: 8 },
  { tag: 57, family: 'PRESET', records: 50 },
  { tag: 58, family: null, records: 350 },
];
