/**
 * FM3 block-template + scaffold HARVESTER (generator for full-body preset
 * synthesis, presetSynth.ts).
 *
 * Decodes the FM3 preset fixtures in `test/gen3/fm3/fixtures/*.syx`, and for
 * each decoded block captures the EXACT decompressed-body byte slice of its
 * walk record:
 *
 *   template = body[block.offset .. block.offset + (23 + cols*rows)*2]
 *
 * i.e. the 23-word walk header + the per-channel param array, VERBATIM. This is
 * the clone source the synthesizer overlays a type + params onto (never a
 * zero-build: the header words 18-22 and every uncataloged param slot carry the
 * device's real, plausible defaults). Templates are keyed by the walk display
 * name (e.g. "Amp", "Drive", "Vol/Pan"); one canonical template per family is
 * emitted, chosen from a fixed FIXTURE PREFERENCE ORDER so no single preset
 * dominates the identity round-trip (a synthesized preset overlays its own
 * params onto a DIFFERENT fixture's template, exercising the overlay path).
 *
 * One fixture is also captured as the DEFAULT SCAFFOLD: its prelude
 * [0x000 .. 0x120E] (word0/1 + scene-name region + grid + fixed setup + scene
 * controllers + the 32 modifier slots) and its trailing region
 * [lastBlockEnd .. decompSize]. buildGen3Body overwrites scene names + grid in
 * the prelude and appends a fresh block chain, but keeps the modifier/scene-
 * controller prelude and the trailing region verbatim.
 *
 * The eid signature (`[eid u16][8 zero bytes]`) that `findBlockHeader`
 * (blockParams.ts) locates sits 12 bytes BELOW block.offset — OUTSIDE the
 * captured template — so templates never carry their own eid; the synthesizer
 * writes each block's grid eid signature at placement time.
 *
 * Run: npx tsx scripts/harvest-fm3-block-templates.ts
 * Output: src/devices/gen3/fm3/blockTemplates.generated.ts (DO NOT hand-edit).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../src/devices/gen3/presetDump.js';
import { decodeRawPatch } from '../src/devices/gen3/presetHuffman.js';
import { decodeGen3Body, MODEL_FM3, EFFECT_BASES } from '../src/devices/gen3/presetBody.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIX = join(REPO, 'test/gen3/fm3/fixtures');
const OUT_DIR = join(REPO, 'src/devices/gen3/fm3');
const OUT = join(OUT_DIR, 'blockTemplates.generated.ts');

const BLOCK_HEADER_WORDS = 23;

/** Preference order: the first fixture that carries a family provides its
 *  canonical template. preset-5 is deliberately LAST so its own blocks are not
 *  the template source when it is used as the identity round-trip subject. */
const FIXTURE_PREFERENCE = [
  'preset-96.syx',
  'preset-42.syx',
  'preset-45.syx',
  'preset-62.syx',
  'preset-63.syx',
  'preset-67.syx',
  'preset-79.syx',
  'preset-82.syx',
  'preset-55.syx',
  'preset-5.syx',
];

/** The default scaffold fixture (prelude + trailing carrier). */
const SCAFFOLD_FIXTURE = 'preset-96.syx';

interface Harvested {
  baseEid: number;
  displayName: string;
  cols: number;
  rows: number;
  typeValue: number | null;
  sourceFixture: string;
  bytes: number[];
}

/** Base grid effect id for an eid (instances 1..4 occupy base..base+3). */
function eidBase(eid: number): number | null {
  if (eid in EFFECT_BASES) return eid;
  for (const baseStr of Object.keys(EFFECT_BASES)) {
    const base = Number(baseStr);
    if (eid > base && eid <= base + 3) return base;
  }
  return null;
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) & 0xffff;

function decodeBody(file: string): { body: Uint8Array; decompSize: number } {
  const bytes = new Uint8Array(readFileSync(join(FIX, file)));
  const parsed = parsePresetDump(bytes, 0, MODEL_FM3);
  const dec = decodeRawPatch(parsed.chunkPayloads);
  return { body: dec.body, decompSize: dec.decompSize };
}

function main(): void {
  const files = readdirSync(FIX).filter((f) => f.endsWith('.syx')).sort();
  const missingPref = FIXTURE_PREFERENCE.filter((f) => !files.includes(f));
  if (missingPref.length) throw new Error(`preference lists absent fixtures: ${missingPref.join(', ')}`);

  // Harvest one canonical template per BASE GRID EID (from the sig@offset-12),
  // honoring the preference order. Keying by eid (not the cols-based walk display
  // name) disambiguates families that share a record geometry — e.g. the cols-10
  // record is Input (eid 37) here, NOT Vol/Pan (eid 102); the cols-26 record is
  // Output (eid 42), NOT PEQ (eid 54) — which the grid + readBlockParams key on.
  const templates = new Map<number, Harvested>();
  const seenGeometries = new Map<number, Set<string>>(); // baseEid -> "cols x rows" set
  for (const file of FIXTURE_PREFERENCE) {
    const { body } = decodeBody(file);
    const decoded = decodeGen3Body(body, MODEL_FM3);
    for (const b of decoded.blocks ?? []) {
      const sigEid = u16(body, b.offset - 12);
      const base = eidBase(sigEid);
      if (base == null) continue; // eid signature not a known grid family
      const geoms = seenGeometries.get(base) ?? new Set<string>();
      geoms.add(`${b.cols}x${b.rows}`);
      seenGeometries.set(base, geoms);
      if (templates.has(base)) continue; // earlier-preference fixture already won
      const size = (BLOCK_HEADER_WORDS + b.cols * b.rows) * 2;
      const slice = body.subarray(b.offset, b.offset + size);
      if (slice.length !== size) continue; // truncated (should not happen)
      templates.set(base, {
        baseEid: base,
        displayName: b.block,
        cols: b.cols,
        rows: b.rows,
        typeValue: b.type_id ?? null,
        sourceFixture: file,
        bytes: Array.from(slice),
      });
    }
  }

  // Capture the default scaffold's prelude + trailing.
  const { body: scafBody, decompSize: scafSize } = decodeBody(SCAFFOLD_FIXTURE);
  const scafDecoded = decodeGen3Body(scafBody, MODEL_FM3);
  const scafBlocks = scafDecoded.blocks ?? [];
  if (scafBlocks.length === 0) throw new Error('scaffold has no blocks');
  const first = scafBlocks[0];
  const PRELUDE_END = 0x120e;
  if (first.offset !== PRELUDE_END) {
    throw new Error(`scaffold first block at 0x${first.offset.toString(16)}, expected 0x120e`);
  }
  const last = scafBlocks[scafBlocks.length - 1];
  const lastEnd = last.offset + (BLOCK_HEADER_WORDS + last.cols * last.rows) * 2;
  const prelude = Array.from(scafBody.subarray(0, PRELUDE_END));
  const trailing = Array.from(scafBody.subarray(lastEnd, scafSize));
  // Capture the FULL scaffold `.syx` dump bytes verbatim — the raw-patch header
  // + SysEx framing are needed to synthesize a preset with NO caller-supplied
  // base (authorGen3PresetFromIRFull parses these back out).
  const scaffoldSyx = Array.from(readFileSync(join(FIX, SCAFFOLD_FIXTURE)));

  // Emit.
  const bases = [...templates.keys()].sort((a, b) => a - b);
  const banner =
    `// GENERATED — FM3 full-body preset-synthesis block templates + default scaffold.\n` +
    `// DO NOT EDIT BY HAND. Regenerate: npx tsx scripts/harvest-fm3-block-templates.ts\n` +
    `// Source: the 10 real FM3 preset fixtures under test/gen3/fm3/fixtures/*.syx,\n` +
    `// decoded via decodeGen3Body. Each template is the VERBATIM walk-record byte\n` +
    `// slice body[offset .. offset+(23+cols*rows)*2] for a block family (the clone\n` +
    `// source the synthesizer overlays a type + params onto). The default scaffold is\n` +
    `// ${SCAFFOLD_FIXTURE}: prelude [0x000..0x120E] + trailing [lastBlockEnd..decompSize].\n` +
    `/* eslint-disable */\n\n`;

  const iface =
    `export interface Fm3BlockTemplate {\n` +
    `  /** Base grid effect id this record is anchored to (the sig@offset-12). */\n` +
    `  readonly baseEid: number;\n` +
    `  /** Walk display name (blockColsMap), e.g. "Amp", "Drive", "Vol/Pan". Used\n` +
    `   *  only for the type-location lookup; the grid IDENTITY is baseEid. */\n` +
    `  readonly displayName: string;\n` +
    `  /** Header word 15 (param columns) / word 16 (rows) — the family geometry. */\n` +
    `  readonly cols: number;\n` +
    `  readonly rows: number;\n` +
    `  /** The block's decoded type id in its source fixture (provenance only). */\n` +
    `  readonly typeValue: number | null;\n` +
    `  /** Fixture the template was captured from. */\n` +
    `  readonly sourceFixture: string;\n` +
    `  /** The verbatim walk record: 23-word header + cols*rows param words, LE bytes. */\n` +
    `  readonly bytes: readonly number[];\n` +
    `}\n\n`;

  const templateEntries = bases
    .map((base) => {
      const t = templates.get(base)!;
      return (
        `  ${base}: {\n` +
        `    baseEid: ${base}, displayName: ${JSON.stringify(t.displayName)},\n` +
        `    cols: ${t.cols}, rows: ${t.rows}, typeValue: ${t.typeValue === null ? 'null' : t.typeValue},\n` +
        `    sourceFixture: ${JSON.stringify(t.sourceFixture)},\n` +
        `    bytes: [${t.bytes.join(',')}],\n` +
        `  },`
      );
    })
    .join('\n');

  const geomReport = [...seenGeometries.entries()]
    .filter(([, g]) => g.size > 1)
    .map(([base, g]) => `${templates.get(base)?.displayName ?? base}(${base}): ${[...g].join(', ')}`)
    .join('; ');

  const body =
    banner +
    iface +
    `/** Canonical FM3 block templates keyed by BASE GRID EFFECT ID. */\n` +
    `export const FM3_BLOCK_TEMPLATES: Readonly<Record<number, Fm3BlockTemplate>> = {\n` +
    templateEntries +
    `\n};\n\n` +
    `/** Base grid effect ids with a harvested template (synthesizable families). */\n` +
    `export const FM3_TEMPLATE_EIDS: readonly number[] = ${JSON.stringify(bases)};\n\n` +
    `/** Base eids observed with MORE THAN ONE geometry across fixtures (only the\n` +
    ` *  canonical/first-preference geometry has a template; other variants are\n` +
    ` *  unsupported). ${geomReport || '(none)'} */\n` +
    `export const FM3_MULTI_GEOMETRY_EIDS: readonly number[] = ${JSON.stringify(
      [...seenGeometries.entries()].filter(([, g]) => g.size > 1).map(([base]) => base),
    )};\n\n` +
    `/** Default scaffold: prelude [0x000..0x120E] carried verbatim (scene names +\n` +
    ` *  grid are overwritten by the synthesizer; the modifier/scene-controller region\n` +
    ` *  is kept). */\n` +
    `export const FM3_SCAFFOLD_FIXTURE = ${JSON.stringify(SCAFFOLD_FIXTURE)};\n` +
    `export const FM3_SCAFFOLD_PRELUDE: readonly number[] = [${prelude.join(',')}];\n` +
    `/** Default scaffold trailing region [lastBlockEnd..decompSize], carried verbatim. */\n` +
    `export const FM3_SCAFFOLD_TRAILING: readonly number[] = [${trailing.join(',')}];\n` +
    `/** Full default scaffold .syx dump (${SCAFFOLD_FIXTURE}) carried verbatim — the\n` +
    ` *  raw-patch header + SysEx framing that authorGen3PresetFromIRFull re-parses to\n` +
    ` *  synthesize a preset when NO caller base is supplied. */\n` +
    `export const FM3_SCAFFOLD_SYX: readonly number[] = [${scaffoldSyx.join(',')}];\n`;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, body);

  // Console report.
  console.log(`Wrote ${OUT}`);
  console.log(`Templates (${bases.length}):`);
  for (const base of bases) {
    const t = templates.get(base)!;
    console.log(`  eid ${String(base).padStart(3)} ${t.displayName.padEnd(11)} ${t.cols}x${t.rows} ${t.bytes.length}B  from ${t.sourceFixture}`);
  }
  console.log(`Multi-geometry families (only canonical geometry templated): ${geomReport || '(none)'}`);
  console.log(`Scaffold ${SCAFFOLD_FIXTURE}: prelude ${prelude.length}B trailing ${trailing.length}B (decompSize ${scafSize})`);
}

main();
