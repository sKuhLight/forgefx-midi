/**
 * FM9 + Axe-Fx III block-template + scaffold HARVESTER (generator for full-body
 * preset synthesis, presetSynth.ts) — the FM9/III analogue of
 * harvest-fm3-block-templates.ts (FORGEFXMID-44).
 *
 * For each device it decodes the single committed "Devs Gift Of Tone" fixture
 * (test/gen3/{fm9,axe-fx-iii}/fixtures/devs-gift-of-tone.syx — byte-identical to
 * the archived source preset), enumerates the placed blocks FROM THE GRID (not
 * from decodeGen3Body's block list, which under-counts late-chain blocks —
 * FORGEFXMID-41), locates each block record via its eid signature
 * (`findBlockHeader`, the sig sits 12 bytes below the walk header), and captures
 * the EXACT decompressed-body byte slice of its walk record:
 *
 *   template = body[recordStart .. recordStart + (23 + cols*rows)*2]
 *
 * i.e. the 23-word walk header + per-channel param array, VERBATIM — the clone
 * source the synthesizer overlays a type + params onto (so header words 18-22 and
 * every uncataloged slot carry the device's real defaults). Templates are keyed by
 * BASE GRID EFFECT ID (the sig), which is how the grid + readBlockParams identify a
 * block. cols = header word15, rows = header word16 — the authoritative record
 * geometry, read straight from the real body (never fabricated).
 *
 * The same fixture supplies the DEFAULT SCAFFOLD: its prelude
 * [0x000 .. firstEffectBlockOffset] (word0/1 + scene-name region + grid + fixed
 * setup + scene controllers + the 32 modifier slots) and its trailing region
 * [lastEffectBlockEnd .. decompSize] (the controller/global tail). buildGen3Body
 * overwrites scene names + grid in the prelude and appends a fresh block chain,
 * keeping the modifier/scene-controller prelude + trailing verbatim.
 *
 * NOTE: only ONE preset per device is available, so a device's templates cover
 * exactly the families that preset places (both Devs presets place the same 9:
 * Input/Output/PEQ/Amp/Cab/Delay/Wah/Vol-Pan/Drive). Every other family has no
 * template + no geometry → it stays skipped+reported at synthesis (needs a rig
 * capture that places it), exactly like the untemplated FM3 families.
 *
 * Run: npx tsx scripts/harvest-gen3-block-templates.ts
 * Output: src/devices/gen3/fm9/blockTemplates.generated.ts
 *         src/devices/gen3/axe-fx-iii/blockTemplates.generated.ts   (DO NOT hand-edit).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeGen3PresetDump,
  decodeGen3Body,
  EFFECT_BASES,
  MODEL_FM9,
  MODEL_AXE_FX_III,
} from '../src/devices/gen3/presetBody.js';
import { gen3BlockParamModel } from '../src/devices/gen3/blockParams.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const BLOCK_HEADER_WORDS = 23;
const HEADER_PRELUDE_GAP = 12; // sig (findBlockHeader anchor) sits this far below the walk header

interface DeviceCfg {
  key: string; // token used for constant names, e.g. FM9 / AXE3
  model: number;
  fixtureRel: string; // relative to REPO
  fixtureName: string; // sourceFixture label baked into the templates
  outRel: string;
}

const DEVICES: DeviceCfg[] = [
  {
    key: 'FM9',
    model: MODEL_FM9,
    fixtureRel: 'test/gen3/fm9/fixtures/devs-gift-of-tone.syx',
    fixtureName: 'devs-gift-of-tone.syx',
    outRel: 'src/devices/gen3/fm9/blockTemplates.generated.ts',
  },
  {
    key: 'AXE3',
    model: MODEL_AXE_FX_III,
    fixtureRel: 'test/gen3/axe-fx-iii/fixtures/devs-gift-of-tone.syx',
    fixtureName: 'devs-gift-of-tone.syx',
    outRel: 'src/devices/gen3/axe-fx-iii/blockTemplates.generated.ts',
  },
];

const u16 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8)) & 0xffff;

function eidBase(eid: number): number | null {
  if (eid in EFFECT_BASES) return eid;
  for (const baseStr of Object.keys(EFFECT_BASES)) {
    const base = Number(baseStr);
    if (eid > base && eid <= base + 3) return base;
  }
  return null;
}

/** First of two consecutive 25x1 modifier records = block-chain start (mirror
 *  presetBody.findBlockChainStart). */
function findChainStart(data: Uint8Array): number {
  const size = (BLOCK_HEADER_WORDS + 25) * 2;
  for (let off = 0x200; off < data.length - 70; off += 2) {
    if (u16(data, off + 30) !== 25 || u16(data, off + 32) !== 1) continue;
    const next = off + size;
    if (next + 34 <= data.length && u16(data, next + 30) === 25 && u16(data, next + 32) === 1) return off;
  }
  return -1;
}

interface Harvested {
  baseEid: number;
  displayName: string;
  cols: number;
  rows: number;
  typeValue: number | null;
  bytes: number[];
  recordStart: number;
}

function harvestDevice(cfg: DeviceCfg): void {
  const syxBytes = new Uint8Array(readFileSync(join(REPO, cfg.fixtureRel)));
  const decoded = decodeGen3PresetDump(syxBytes, cfg.model);
  const body = decoded.decompressed_body;
  const { tables, layout } = gen3BlockParamModel(cfg.model);

  // eid → walk type_id (provenance only; decodeGen3Body under-counts so this is best-effort).
  const walkTypeBySig = new Map<number, number>();
  for (const b of decodeGen3Body(body, cfg.model).blocks ?? []) {
    const sig = u16(body, b.offset - HEADER_PRELUDE_GAP);
    const tid = b.type_id ?? (b.channels?.A?.type_id as number | undefined);
    if (tid != null) walkTypeBySig.set(sig, tid);
  }

  // Grid-referenced base eids (the placed families).
  const gridBases = new Set<number>();
  for (const c of decoded.grid ?? []) {
    if (c.is_shunt) continue;
    if (c.effect_id <= 0 || c.effect_id > 1000) continue;
    const b = eidBase(c.effect_id);
    if (b != null) gridBases.add(b);
  }

  // Locate each placed block's record by CHAIN WALK (robust: the eid sits 12
  // bytes below each walk header regardless of whether the 8-zero findBlockHeader
  // signature holds — Axe-Fx III Output carries a 0xffff scene word there, so
  // findBlockHeader can't anchor it). First record per base wins (the base
  // template); the walk simultaneously fixes the scaffold prelude/trailing split.
  const templates = new Map<number, Harvested>();
  const chainStart = findChainStart(body);
  if (chainStart < 0) throw new Error(`[${cfg.key}] could not locate block-chain start`);
  let firstEffect = -1;
  let lastEffectEnd = -1;
  let pos = chainStart;
  while (pos + BLOCK_HEADER_WORDS * 2 + 2 <= body.length) {
    const cols = u16(body, pos + 30);
    const rows = u16(body, pos + 32);
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    const size = (BLOCK_HEADER_WORDS + cols * rows) * 2;
    if (cols === 25 && rows === 1) { pos += size; continue; } // modifier slot
    const sig = u16(body, pos - HEADER_PRELUDE_GAP);
    const base = eidBase(sig);
    if (base != null && gridBases.has(base)) {
      if (firstEffect < 0) firstEffect = pos;
      lastEffectEnd = pos + size;
      if (!templates.has(base)) {
        const slice = body.subarray(pos, pos + size);
        // cross-check: cols vs catalog stride (max real paramId+1) — reported, not fatal
        const fam = tables.familyByEffectId[String(base)];
        const params = fam ? tables.paramsByFamily[fam] : undefined;
        let catStride = -1;
        if (params) for (const p of params) if (p.paramId < 0xff00 && p.paramId > catStride) catStride = p.paramId;
        catStride = catStride >= 0 ? catStride + 1 : -1;
        const note = catStride >= 0 && catStride !== cols ? `  (catalog stride ${catStride} != cols ${cols})` : '';
        console.log(`  [${cfg.key}] eid ${String(sig).padStart(3)} ${String(EFFECT_BASES[base]).padEnd(10)} ${cols}x${rows} ${size}B fam=${fam ?? '-'}${note}`);
        templates.set(base, {
          baseEid: base,
          displayName: EFFECT_BASES[base] ?? `eid_${base}`,
          cols,
          rows,
          typeValue: walkTypeBySig.get(sig) ?? null,
          bytes: Array.from(slice),
          recordStart: pos,
        });
      }
    }
    pos += size;
  }
  if (firstEffect < 0) throw new Error(`[${cfg.key}] chain walk found no placed effect blocks`);
  const decompSize = decoded.decompressed_size;
  const prelude = Array.from(body.subarray(0, firstEffect));
  const trailing = Array.from(body.subarray(lastEffectEnd, decompSize));
  const scaffoldSyx = Array.from(syxBytes);

  const bases = [...templates.keys()].sort((a, b) => a - b);
  const ifaceName = `${cfg.key === 'AXE3' ? 'Axe3' : 'Fm9'}BlockTemplate`;
  const banner =
    `// GENERATED — ${cfg.key} full-body preset-synthesis block templates + default scaffold.\n` +
    `// DO NOT EDIT BY HAND. Regenerate: npx tsx scripts/harvest-gen3-block-templates.ts\n` +
    `// Source: the committed real preset fixture ${cfg.fixtureRel},\n` +
    `// decoded via decodeGen3PresetDump. Each template is the VERBATIM walk-record byte\n` +
    `// slice body[recordStart .. recordStart+(23+cols*rows)*2] for a block family (the\n` +
    `// clone source the synthesizer overlays a type + params onto). Templates are keyed\n` +
    `// by BASE GRID EFFECT ID (the eid signature). cols=word15, rows=word16 straight from\n` +
    `// the real body. The default scaffold is that fixture's prelude [0x000..firstEffect]\n` +
    `// + trailing [lastEffectEnd..decompSize].\n` +
    `/* eslint-disable */\n\n`;

  const iface =
    `export interface ${ifaceName} {\n` +
    `  /** Base grid effect id this record is anchored to (the sig@offset-12). */\n` +
    `  readonly baseEid: number;\n` +
    `  /** Grid family display name (EFFECT_BASES), e.g. "Amp", "Drive", "Vol/Pan". */\n` +
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

  const entries = bases
    .map((base) => {
      const t = templates.get(base)!;
      return (
        `  ${base}: {\n` +
        `    baseEid: ${base}, displayName: ${JSON.stringify(t.displayName)},\n` +
        `    cols: ${t.cols}, rows: ${t.rows}, typeValue: ${t.typeValue === null ? 'null' : t.typeValue},\n` +
        `    sourceFixture: ${JSON.stringify(cfg.fixtureName)},\n` +
        `    bytes: [${t.bytes.join(',')}],\n` +
        `  },`
      );
    })
    .join('\n');

  const out =
    banner +
    iface +
    `/** Canonical ${cfg.key} block templates keyed by BASE GRID EFFECT ID. */\n` +
    `export const ${cfg.key}_BLOCK_TEMPLATES: Readonly<Record<number, ${ifaceName}>> = {\n` +
    entries +
    `\n};\n\n` +
    `/** Base grid effect ids with a harvested template (synthesizable families). */\n` +
    `export const ${cfg.key}_TEMPLATE_EIDS: readonly number[] = ${JSON.stringify(bases)};\n\n` +
    `/** Body offset of the first placed effect block (= prelude length = chain start). */\n` +
    `export const ${cfg.key}_SCAFFOLD_CHAIN_START = ${firstEffect};\n` +
    `export const ${cfg.key}_SCAFFOLD_FIXTURE = ${JSON.stringify(cfg.fixtureName)};\n` +
    `/** Default scaffold prelude [0x000..firstEffect], carried verbatim (scene names +\n` +
    ` *  grid overwritten by the synthesizer; modifier/scene-controller region kept). */\n` +
    `export const ${cfg.key}_SCAFFOLD_PRELUDE: readonly number[] = [${prelude.join(',')}];\n` +
    `/** Default scaffold trailing region [lastEffectEnd..decompSize], carried verbatim. */\n` +
    `export const ${cfg.key}_SCAFFOLD_TRAILING: readonly number[] = [${trailing.join(',')}];\n` +
    `/** Full default scaffold .syx dump carried verbatim — the raw-patch header + SysEx\n` +
    ` *  framing authorGen3PresetFromIRFull re-parses when NO caller base is supplied. */\n` +
    `export const ${cfg.key}_SCAFFOLD_SYX: readonly number[] = [${scaffoldSyx.join(',')}];\n`;

  mkdirSync(dirname(join(REPO, cfg.outRel)), { recursive: true });
  writeFileSync(join(REPO, cfg.outRel), out);
  console.log(
    `  [${cfg.key}] wrote ${cfg.outRel}: ${bases.length} templates, chainStart 0x${firstEffect.toString(16)}, ` +
      `prelude ${prelude.length}B, trailing ${trailing.length}B (decompSize ${decompSize})`,
  );
}

for (const cfg of DEVICES) {
  console.log(`== ${cfg.key} ==`);
  harvestDevice(cfg);
}
