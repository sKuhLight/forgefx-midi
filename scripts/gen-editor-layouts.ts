/**
 * Editor-layout catalog v2 generator.
 *
 * Parses the JUCE "config" layout XML embedded in each Fractal desktop editor
 * (`__block_layout.xml`, `__amp_layout*.xml`) and emits the per-device
 * `<DEV>_LAYOUTS` data files that implement the v2 schema in
 * `src/editorLayouts.ts`. Document order in the XML == on-screen order and is
 * preserved (controls left→right per row, rows top→bottom, pages in tab
 * order). Every control's editor symbol (`parameterName`) is joined against
 * the device's own parameter catalog to resolve a wire `paramId`.
 *
 * SOURCE ROOT (RE material — never hard-coded here):
 *   Set FASRE_EDITOR_XML_ROOT to the directory that holds the extracted editor
 *   config XMLs, laid out as `<root>/<device>/decompile/juce_xml.../<file>.xml`
 *   under a `juce_xml` subfolder (the `<device>` dir names are matched by the
 *   CONFIG/Device model in the XML, not by directory name).
 *   There is deliberately NO default — the generator refuses to run without it.
 *
 * SOURCES USED (path-free provenance, baked into each output header):
 *   - Axe-Fx III : Axe-Edit III config (firmware ceiling 32.05)
 *   - FM9        : FM9-Edit config       (firmware ceiling 11.00)
 *   - AM4        : AM4-Edit (mac) config
 *   - FM3        : FM3-Edit config       (firmware ceiling 12.00)
 *                  Fallback: when no model-17 XML is present under the source
 *                  root, FM3 is MIGRATED from the prior generated data and
 *                  re-emitted in the v2 shape (idempotent re-serialisation).
 *
 * Amp layouts are firmware-versioned (`__amp_layout*.xml`). All historical
 * variants are kept under the DISTORT family; exactly one is `pinned` to the
 * device's current firmware ceiling.
 *
 * Run: FASRE_EDITOR_XML_ROOT=... npx tsx scripts/gen-editor-layouts.ts
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeWidget,
  EDITOR_WIDGET_KINDS,
  type DeviceEditorLayouts,
  type EditorBlockLayout,
  type EditorLayoutVariant,
  type EditorLayoutPage,
  type EditorLayoutRow,
  type EditorLayoutControl,
  type EditorFwRange,
} from '../src/editorLayouts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// --------------------------------------------------------------------------
// Minimal dependency-free XML parser (the package ships no XML dependency).
// Handles: <?...?>, <!-- -->, <tag a="v" .../>, <tag ...>...</tag>, entities.
// --------------------------------------------------------------------------
interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}

function parseXml(text: string): XmlNode {
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = text.indexOf('>', i);
    if (gt < 0) break;
    const inner = text.slice(i + 1, gt);
    i = gt + 1;
    if (inner.startsWith('/')) {
      // closing tag
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    const sp = body.search(/\s/);
    const tag = (sp < 0 ? body : body.slice(0, sp)).trim();
    const attrs = sp < 0 ? {} : parseAttrs(body.slice(sp + 1));
    const node: XmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function findAll(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.tag === tag) out.push(c);
    findAll(c, tag, out);
  }
  return out;
}
function firstChild(node: XmlNode, tag: string): XmlNode | undefined {
  return node.children.find((c) => c.tag === tag);
}

// --------------------------------------------------------------------------
// Param-catalog resolver: parameterName -> { paramId, family } per device.
// --------------------------------------------------------------------------
type Resolver = (paramName: string, editorBlockHint: string) => { paramId: number | null; family: string | null };

async function gen3Resolver(paramsModule: string, arrayExport: string): Promise<Resolver> {
  const mod: any = await import(paramsModule);
  const arr: Array<{ name: string; paramId: number; family: string }> = mod[arrayExport];
  const byName = new Map<string, { paramId: number; family: string }>();
  for (const p of arr) if (!byName.has(p.name)) byName.set(p.name, { paramId: p.paramId, family: p.family });
  return (name) => {
    const hit = byName.get(name);
    return hit ? { paramId: hit.paramId, family: hit.family } : { paramId: null, family: null };
  };
}

async function am4Resolver(): Promise<Resolver> {
  const mod: any = await import('../src/am4/variantResolverTables.js');
  const byBlock: Record<string, Record<string, readonly number[]>> = mod.PARAMETER_NAME_TO_CACHE_ID;
  const universal: Record<string, number> = mod.UNIVERSAL_BLOCK_PARAMETERS;
  const blocks = Object.keys(byBlock).sort();
  return (name, editorBlockHint) => {
    if (universal[name] !== undefined) return { paramId: universal[name], family: null };
    // Prefer the editor block whose lowercased name best matches an am4 block key.
    const hint = editorBlockHint.toLowerCase().replace(/[^a-z0-9]/g, '');
    const preferred = blocks.find((b) => b.replace(/[^a-z0-9]/g, '') === hint);
    if (preferred) {
      const cids = byBlock[preferred][name];
      if (cids && cids.length) return { paramId: cids[0], family: null };
    }
    for (const b of blocks) {
      const cids = byBlock[b][name];
      if (cids && cids.length) return { paramId: cids[0], family: null };
    }
    return { paramId: null, family: null };
  };
}

// --------------------------------------------------------------------------
// XML -> v2 structures.
// --------------------------------------------------------------------------
function fwFrom(attrs: Record<string, string>): EditorFwRange | undefined {
  const fw: EditorFwRange = {};
  if (attrs.version_gtet) fw.gtet = attrs.version_gtet;
  if (attrs.version_lt) fw.lt = attrs.version_lt;
  return fw.gtet || fw.lt ? fw : undefined;
}

function buildControl(ec: XmlNode, resolve: Resolver, editorBlock: string): EditorLayoutControl {
  const a = ec.attrs;
  const paramName = a.parameterName ?? null;
  const rawWidget = a.type ?? '';
  const widget = normalizeWidget(rawWidget);
  const ctrl: EditorLayoutControl = {
    label: a.name ?? '',
    paramName,
    paramId: null,
    widget,
    rawWidget,
  };
  if (paramName) {
    const r = resolve(paramName, editorBlock);
    ctrl.paramId = r.paramId;
  }
  const placement: NonNullable<EditorLayoutControl['placement']> = {};
  if (a.col !== undefined) placement.col = Number(a.col);
  if (a.offsetX !== undefined) placement.offsetX = Number(a.offsetX);
  if (a.offsetY !== undefined) placement.offsetY = Number(a.offsetY);
  if (a.positionExact !== undefined) placement.positionExact = a.positionExact;
  if (Object.keys(placement).length) ctrl.placement = placement;
  if (a.effectName) {
    const rp = paramName ? resolve(paramName, editorBlock) : { paramId: null, family: null };
    ctrl.crossBlock = {
      effect: a.effectName,
      family: rp.family,
      paramName,
      paramId: rp.paramId,
    };
  }
  const fw = fwFrom(a);
  if (fw) ctrl.fw = fw;
  return ctrl;
}

function buildPages(variantNode: XmlNode, resolve: Resolver, editorBlock: string): EditorLayoutPage[] {
  const pages: EditorLayoutPage[] = [];
  for (const pageNode of variantNode.children.filter((c) => c.tag === 'Page')) {
    const pa = pageNode.attrs;
    const rows: EditorLayoutRow[] = [];
    // Sections appear as <Parameters> and <Mixer>, each holding <Row>s.
    for (const section of pageNode.children) {
      let sectionName: 'parameters' | 'mixer' | null = null;
      if (section.tag === 'Parameters') sectionName = 'parameters';
      else if (section.tag === 'Mixer') sectionName = 'mixer';
      else continue;
      for (const rowNode of section.children.filter((c) => c.tag === 'Row')) {
        const controls = rowNode.children
          .filter((c) => c.tag === 'EditorControl')
          .map((ec) => buildControl(ec, resolve, editorBlock));
        if (controls.length) rows.push({ section: sectionName, controls });
      }
    }
    const page: EditorLayoutPage = { name: pa.name ?? '', rows };
    if (pa.pageNum !== undefined) page.pageNum = Number(pa.pageNum);
    const fw = fwFrom(pa);
    if (fw) page.fw = fw;
    if (pa.value !== undefined) page.value = pa.value;
    if (pa.parameterName !== undefined) page.selectorParamName = pa.parameterName;
    if (page.rows.length) pages.push(page); // drop pages with no controls
  }
  return pages;
}

const EDITORNAME_FAMILY_ALIAS: Record<string, string> = {
  FootController: 'FC',
  IRCapture: 'IRCAPTURE',
  FeedbackSend: 'FDBKSEND',
  FeedbackReturn: 'FDBKRET',
  EffectsLoop: 'FXLOOP',
  Tuner: 'TUNER',
};

/** Family key = mode of own controls' paramName prefix; else editorName alias. */
function deriveFamily(editorName: string, ecsNode: XmlNode): string {
  const prefixes = new Map<string, number>();
  for (const ec of findAll(ecsNode, 'EditorControl')) {
    if (ec.attrs.effectName) continue; // cross-block controls belong elsewhere
    const pn = ec.attrs.parameterName;
    if (!pn) continue;
    const pfx = pn.split('_')[0];
    prefixes.set(pfx, (prefixes.get(pfx) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, v] of prefixes) if (v > bestN) { best = k; bestN = v; }
  if (best) return best;
  return EDITORNAME_FAMILY_ALIAS[editorName] ?? editorName.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Parse a `__block_layout.xml` root into families -> block layout. */
function parseBlockLayout(root: XmlNode, resolve: Resolver, skipAmp: boolean): Map<string, EditorBlockLayout> {
  const out = new Map<string, EditorBlockLayout>();
  for (const ecs of findAll(root, 'EditorControls')) {
    const editorName = ecs.attrs.name ?? '';
    if (skipAmp && editorName === 'Amp') continue; // real amp comes from __amp_layout*.xml
    const variantsGroup = firstChild(ecs, 'EffectVariants');
    if (!variantsGroup) continue;
    const variantNodes = variantsGroup.children.filter((c) => c.tag === 'EffectVariant');
    const family = deriveFamily(editorName, ecs);
    const variants: EditorLayoutVariant[] = [];
    for (const vn of variantNodes) {
      const pages = buildPages(vn, resolve, editorName);
      if (!pages.length) continue;
      const variant: EditorLayoutVariant = {
        name: vn.attrs.name ?? '',
        value: vn.attrs.value !== undefined && vn.attrs.value !== '' ? vn.attrs.value : null,
      };
      const fw = fwFrom(vn.attrs);
      if (fw) variant.fw = fw;
      variant.pages = pages;
      variants.push(variant);
    }
    if (!variants.length) continue;
    const existing = out.get(family);
    if (existing) existing.variants.push(...variants);
    else out.set(family, { editorName, family, variants });
  }
  return out;
}

/** Parse an fw lower bound out of an amp variant name like "Amp GTE 28.09". */
function ampBounds(name: string, fw?: EditorFwRange): { gte: number | null; lt: number | null } {
  const parse = (s: string | undefined): number | null => {
    if (!s) return null;
    const m = s.replace(',', '.').match(/(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    return Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
  };
  const gteN = name.match(/GTE\s*([\d.]+)/i);
  const ltN = name.match(/LT\s*([\d.]+)/i);
  return {
    gte: parse(gteN?.[1]) ?? parse(fw?.gtet),
    lt: parse(ltN?.[1]) ?? parse(fw?.lt),
  };
}

/** Merge fw-versioned amp_layout files into a single DISTORT block layout. */
function parseAmpLayouts(files: string[], resolve: Resolver, fwCeiling: number): EditorBlockLayout | null {
  const variants: EditorLayoutVariant[] = [];
  const bounds: Array<{ gte: number | null; lt: number | null }> = [];
  for (const file of files.sort()) {
    const root = parseXml(readFileSync(file, 'utf8'));
    const ecs = findAll(root, 'EditorControls').find((e) => e.attrs.name === 'Amp');
    if (!ecs) continue;
    const group = firstChild(ecs, 'EffectVariants');
    if (!group) continue;
    for (const vn of group.children.filter((c) => c.tag === 'EffectVariant')) {
      const pages = buildPages(vn, resolve, 'Amp');
      if (!pages.length) continue;
      const name = vn.attrs.name ?? '';
      const fw = fwFrom(vn.attrs);
      const variant: EditorLayoutVariant = { name, value: null };
      if (fw) variant.fw = fw;
      variant.pages = pages;
      variants.push(variant);
      bounds.push(ampBounds(name, fw));
    }
  }
  if (!variants.length) return null;
  // Pin the variant whose fw range contains the ceiling; prefer the most
  // specific (highest lower bound). Unbounded variants match everything.
  let pinIdx = -1;
  let pinScore = -1;
  bounds.forEach((b, idx) => {
    const okLow = b.gte === null || fwCeiling >= b.gte;
    const okHigh = b.lt === null || fwCeiling < b.lt;
    if (okLow && okHigh) {
      const score = b.gte ?? 0; // prefer highest matching lower bound
      if (score > pinScore) { pinScore = score; pinIdx = idx; }
    }
  });
  if (pinIdx >= 0) variants[pinIdx].pinned = true;
  return { editorName: 'Amp', family: 'DISTORT', variants };
}

// --------------------------------------------------------------------------
// Device XML discovery (matched by model, never by directory name).
// --------------------------------------------------------------------------
interface DiscoveredDevice {
  model: string;
  juceDir: string;
  configName: string;
}

function discoverDevices(root: string): DiscoveredDevice[] {
  const found: DiscoveredDevice[] = [];
  const seen = new Set<string>();
  for (const devDir of readdirSync(root)) {
    const decompile = join(root, devDir, 'decompile');
    if (!existsSync(decompile) || !statSync(decompile).isDirectory()) continue;
    for (const sub of readdirSync(decompile)) {
      if (!sub.startsWith('juce_xml')) continue;
      const juceDir = join(decompile, sub);
      const bl = join(juceDir, '__block_layout.xml');
      if (!existsSync(bl)) continue;
      const root2 = parseXml(readFileSync(bl, 'utf8'));
      const dev = findAll(root2, 'Device')[0];
      const config = findAll(root2, 'CONFIG')[0] ?? root2;
      const model = dev?.attrs.model ?? '?';
      const key = model;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ model, juceDir, configName: config.attrs.name ?? '' });
    }
  }
  return found;
}

// --------------------------------------------------------------------------
// Emission.
// --------------------------------------------------------------------------
function sortedFamilyMap(m: Map<string, EditorBlockLayout>): DeviceEditorLayouts {
  const out: Record<string, EditorBlockLayout> = {};
  for (const key of [...m.keys()].sort()) out[key] = m.get(key)!;
  return out;
}

function countStats(layouts: DeviceEditorLayouts) {
  let variants = 0, pages = 0, controls = 0, withParam = 0, joined = 0;
  for (const fam of Object.values(layouts)) {
    for (const v of fam.variants) {
      variants++;
      for (const p of v.pages) {
        pages++;
        for (const r of p.rows) {
          for (const c of r.controls) {
            controls++;
            if (c.paramName) { withParam++; if (c.paramId !== null) joined++; }
          }
        }
      }
    }
  }
  return { families: Object.keys(layouts).length, variants, pages, controls, withParam, joined };
}

/**
 * Compact deterministic serialiser: one control per line (like the prior
 * layout files), so the data files stay reviewable and diff-clean instead of
 * exploding to one scalar per line.
 */
function serialize(layouts: DeviceEditorLayouts): string {
  const j = (v: unknown) => JSON.stringify(v);
  const lines: string[] = ['{'];
  const famKeys = Object.keys(layouts);
  famKeys.forEach((fk, fi) => {
    const block = layouts[fk];
    lines.push(`  ${j(fk)}: {`);
    lines.push(`    "editorName": ${j(block.editorName)},`);
    lines.push(`    "family": ${j(block.family)},`);
    lines.push(`    "variants": [`);
    block.variants.forEach((v, vi) => {
      const head: string[] = [`"name": ${j(v.name)}`, `"value": ${j(v.value)}`];
      if (v.fw) head.push(`"fw": ${j(v.fw)}`);
      if (v.pinned) head.push(`"pinned": true`);
      lines.push(`      { ${head.join(', ')}, "pages": [`);
      v.pages.forEach((p, pi) => {
        const ph: string[] = [`"name": ${j(p.name)}`];
        if (p.pageNum !== undefined) ph.push(`"pageNum": ${p.pageNum}`);
        if (p.fw) ph.push(`"fw": ${j(p.fw)}`);
        if (p.value !== undefined) ph.push(`"value": ${j(p.value)}`);
        if (p.selectorParamName !== undefined) ph.push(`"selectorParamName": ${j(p.selectorParamName)}`);
        lines.push(`        { ${ph.join(', ')}, "rows": [`);
        p.rows.forEach((r, ri) => {
          lines.push(`          { "section": ${j(r.section)}, "controls": [`);
          r.controls.forEach((c) => lines.push(`            ${j(c)},`));
          lines.push(`          ] }${ri < p.rows.length - 1 ? ',' : ''}`);
        });
        lines.push(`        ] }${pi < v.pages.length - 1 ? ',' : ''}`);
      });
      lines.push(`      ] }${vi < block.variants.length - 1 ? ',' : ''}`);
    });
    lines.push(`    ]`);
    lines.push(`  }${fi < famKeys.length - 1 ? ',' : ''}`);
  });
  lines.push('}');
  return lines.join('\n');
}

function emit(
  filePath: string,
  constName: string,
  header: string,
  layouts: DeviceEditorLayouts,
): void {
  const content = `${header}\n/* eslint-disable */\nimport type { DeviceEditorLayouts } from '${relImport(filePath)}';\n\nexport const ${constName}: DeviceEditorLayouts = ${serialize(layouts)};\n`;
  writeFileSync(filePath, content);
}

/** Relative import path from a generated file to src/editorLayouts.js. */
function relImport(filePath: string): string {
  const fromDir = dirname(filePath);
  const target = join(REPO, 'src', 'editorLayouts.js');
  let rel = relative(fromDir, target).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

// --------------------------------------------------------------------------
// FM3 migration (no editor XML available — migrate the prior genuine data).
// --------------------------------------------------------------------------
async function migrateFm3(): Promise<DeviceEditorLayouts | null> {
  const modPath = '../src/gen3/fm3/layouts.generated.js';
  let mod: any;
  try {
    mod = await import(modPath);
  } catch {
    return null;
  }
  const existing = mod.FM3_LAYOUTS;
  if (!existing) return null;
  const out: Record<string, EditorBlockLayout> = {};
  for (const key of Object.keys(existing).sort()) {
    const block = existing[key];
    // Already v2? (has `variants`) -> pass through unchanged.
    if (Array.isArray(block.variants)) {
      out[key] = block as EditorBlockLayout;
      continue;
    }
    // v1 shape: { editorName, pages: [{ name, controls: [{label,paramName,paramId,col}] }] }
    const pages: EditorLayoutPage[] = (block.pages ?? [])
      .map((p: any) => {
        const controls: EditorLayoutControl[] = (p.controls ?? []).map((c: any) => {
          const ctrl: EditorLayoutControl = {
            label: c.label ?? '',
            paramName: c.paramName ?? null,
            paramId: c.paramId ?? null,
            widget: 'unknown',
            rawWidget: '',
          };
          if (c.col !== undefined) ctrl.placement = { col: c.col };
          return ctrl;
        });
        const rows: EditorLayoutRow[] = controls.length ? [{ section: 'parameters', controls }] : [];
        return { name: p.name ?? '', rows };
      })
      .filter((p: EditorLayoutPage) => p.rows.length); // drop empty pages
    if (!pages.length) continue; // drop blocks that carried no controls
    out[key] = { editorName: block.editorName ?? key, family: key, variants: [{ name: 'default', value: null, pages }] };
  }
  return out;
}

// --------------------------------------------------------------------------
// Main.
// --------------------------------------------------------------------------
const MODEL_TO_DEVICE: Record<string, { key: string; label: string; ceiling: number }> = {
  '16': { key: 'axe-fx-iii', label: 'Axe-Fx III', ceiling: 32.05 },
  '17': { key: 'fm3', label: 'FM3', ceiling: 12.0 },
  '18': { key: 'fm9', label: 'FM9', ceiling: 11.0 },
  '21': { key: 'am4', label: 'AM4', ceiling: 0 },
};

function headerFor(deviceLabel: string, sourceNote: string, constName: string): string {
  return [
    `// GENERATED by scripts/gen-editor-layouts.ts — DO NOT EDIT BY HAND.`,
    `// ${deviceLabel} editor block-editor UI layouts (v2 schema, see src/editorLayouts.ts).`,
    `//`,
    `// ${sourceNote}`,
    `//`,
    `// Keyed by catalog family symbol. Each block carries its block-type variants`,
    `// (keyed by the editor's block-type selector value), each variant its pages`,
    `// (tabs), each page its rows, each row its controls in editor order. Every`,
    `// control's paramId is the join of its editor parameterName against the`,
    `// device parameter catalog (null when the name has no catalog entry).`,
    `// Firmware-versioned amp variants are all retained; the one pinned to the`,
    `// current firmware ceiling carries \`pinned: true\`. Access:`,
    `// \`${constName}.REVERB.variants[0].pages\`.`,
  ].join('\n');
}

async function main() {
  const root = process.env.FASRE_EDITOR_XML_ROOT;
  if (!root) {
    console.error('FATAL: set FASRE_EDITOR_XML_ROOT to the editor-config XML source root.');
    process.exit(2);
  }
  if (!existsSync(root)) {
    console.error(`FATAL: FASRE_EDITOR_XML_ROOT does not exist: ${root}`);
    process.exit(2);
  }

  const devices = discoverDevices(root);
  console.log('Discovered editor configs (by model):');
  for (const d of devices) console.log(`  model ${d.model} -> ${MODEL_TO_DEVICE[d.model]?.label ?? '?'}  [${d.configName}]  ${d.juceDir}`);

  const targets: Array<{ file: string; constName: string; label: string }> = [];

  for (const d of devices) {
    const dev = MODEL_TO_DEVICE[d.model];
    if (!dev) continue;

    let resolve: Resolver;
    let outFile: string;
    let constName: string;
    if (dev.key === 'am4') {
      resolve = await am4Resolver();
      outFile = join(REPO, 'src', 'am4', 'editorLayouts.generated.ts');
      constName = 'AM4_LAYOUTS';
    } else if (dev.key === 'fm9') {
      resolve = await gen3Resolver('../src/gen3/fm9/params.js', 'FM9_PARAMS');
      outFile = join(REPO, 'src', 'gen3', 'fm9', 'layouts.generated.ts');
      constName = 'FM9_LAYOUTS';
    } else if (dev.key === 'fm3') {
      resolve = await gen3Resolver('../src/gen3/fm3/params.js', 'FM3_PARAMS');
      outFile = join(REPO, 'src', 'gen3', 'fm3', 'layouts.generated.ts');
      constName = 'FM3_LAYOUTS';
    } else {
      resolve = await gen3Resolver('../src/gen3/axe-fx-iii/params.js', 'PARAMS');
      outFile = join(REPO, 'src', 'gen3', 'axe-fx-iii', 'layouts.generated.ts');
      constName = 'AXE3_LAYOUTS';
    }

    const ampFiles = readdirSync(d.juceDir)
      .filter((f) => f.startsWith('__amp_layout') && f.endsWith('.xml'))
      .map((f) => join(d.juceDir, f));

    const blRoot = parseXml(readFileSync(join(d.juceDir, '__block_layout.xml'), 'utf8'));
    const map = parseBlockLayout(blRoot, resolve, ampFiles.length > 0);

    if (ampFiles.length) {
      const amp = parseAmpLayouts(ampFiles, resolve, dev.ceiling);
      if (amp) map.set('DISTORT', amp);
    }

    const layouts = sortedFamilyMap(map);
    const stats = countStats(layouts);
    const rate = stats.withParam ? ((stats.joined / stats.withParam) * 100).toFixed(1) : 'n/a';
    const sourceNote =
      dev.key === 'am4'
        ? `Source: ${d.configName} config (AM4-mac). Amp is inline (no separate amp layout).`
        : `Source: ${d.configName} config (firmware ceiling ${dev.ceiling.toFixed(2)}). Amp layout is firmware-versioned; historical variants retained.`;
    emit(outFile, constName, headerFor(dev.label, sourceNote, constName), layouts);
    console.log(
      `\n${dev.label}: families=${stats.families} variants=${stats.variants} pages=${stats.pages} ` +
        `controls=${stats.controls} paramCtrls=${stats.withParam} joined=${stats.joined} (${rate}%)`,
    );
    console.log(`  -> ${outFile}`);
    targets.push({ file: outFile, constName, label: dev.label });
  }

  // FM3 fallback: migrate prior generated data when no model-17 XML was found.
  const fm3FromXml = devices.some((d) => MODEL_TO_DEVICE[d.model]?.key === 'fm3');
  const fm3 = fm3FromXml ? null : await migrateFm3();
  if (fm3) {
    const stats = countStats(fm3);
    const rate = stats.withParam ? ((stats.joined / stats.withParam) * 100).toFixed(1) : 'n/a';
    const file = join(REPO, 'src', 'gen3', 'fm3', 'layouts.generated.ts');
    const note =
      'Source: prior genuine FM3-Edit extraction, migrated to the v2 schema. No FM3 ' +
      'editor config XML is present in the current source tree, so widgets are ' +
      "'unknown' and each block is a single 'default' variant. Regeneration is idempotent.";
    emit(file, 'FM3_LAYOUTS', headerFor('FM3', note, 'FM3_LAYOUTS'), fm3);
    console.log(
      `\nFM3 (migrated): families=${stats.families} variants=${stats.variants} pages=${stats.pages} ` +
        `controls=${stats.controls} paramCtrls=${stats.withParam} joined=${stats.joined} (${rate}%)`,
    );
    console.log(`  -> ${file}`);
  } else if (!fm3FromXml) {
    console.warn('\nWARN: could not migrate FM3 (no existing FM3_LAYOUTS module found).');
  }

  // Sanity: widget kinds all in the known set.
  console.log(`\nWidget kinds: ${EDITOR_WIDGET_KINDS.join(', ')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
