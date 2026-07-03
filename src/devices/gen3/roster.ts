/**
 * Gen-3 effect-roster projections: the UI-facing views over the canonical
 * grid effect-id table (`EFFECT_BASES` in presetBody.ts) that editor servers
 * need — palette roster, eid → slug/instance resolution, and per-family
 * instance counts.
 *
 * Moved verbatim from the ForgeFX server (live-validated on FM3; goldens
 * frozen from its output under test/gen3/fm3/fixtures/roster.expected.json).
 * The slug is the editor "pack" key clients address block families by.
 */
import { EFFECT_BASES } from './presetBody.js';
import { AXE_FX_III_BLOCKS } from '../../gen3/axe-fx-iii/blockTypes.js';

// EFFECT_BASES base name → editor pack slug (lowercased pack key the client sends).
// Authoritative + complete: eid→slug does not depend on a def pack existing.
const BASE_SLUG: Record<string, string> = {
  Input: 'input', Output: 'output', Comp: 'comp', GEQ: 'geq', PEQ: 'peq', Amp: 'amp', Cab: 'cab',
  Reverb: 'reverb', Delay: 'delay', MultiTap: 'multitap', Chorus: 'chorus', Flanger: 'flanger',
  Rotary: 'rotary', Phaser: 'phaser', Wah: 'wah', Formant: 'formant', 'Vol/Pan': 'volume',
  Tremolo: 'tremolo', Pitch: 'pitch', Filter: 'filter', Drive: 'drive', Enhancer: 'enhancer',
  Mixer: 'mixer', Synth: 'synth', Megatap: 'megatap', Gate: 'gate', RingMod: 'ringmod',
  MultiComp: 'multicomp', 'Ten-Tap': 'tentap', Resonator: 'resonator', Looper: 'looper',
  'Plex Delay': 'plex', Send: 'send', Return: 'return', Multiplexer: 'multiplexer',
};

// Friendly palette names for the EFFECT_BASES base keys (else the base key is used as-is).
const PRETTY_NAME: Record<string, string> = {
  Comp: 'Compressor', MultiComp: 'Multiband Comp', PEQ: 'Parametric EQ', GEQ: 'Graphic EQ',
  'Vol/Pan': 'Volume/Pan', RingMod: 'Ring Modulator', MultiTap: 'Multitap Delay',
  Megatap: 'Megatap Delay', 'Ten-Tap': 'Ten-Tap Delay', Drive: 'Drive', Cab: 'Cab',
  Send: 'Send', Return: 'Return',
};

// Catalog groupCode → pack slug (for per-family instance counts from the v1.4 spec catalog).
const GROUP_SLUG: Record<string, string> = {
  IN: 'input', OUT: 'output', CMP: 'comp', GEQ: 'geq', PEQ: 'peq', AMP: 'amp', CAB: 'cab',
  REV: 'reverb', DLY: 'delay', MTD: 'multitap', CHO: 'chorus', FLG: 'flanger', ROT: 'rotary',
  PHA: 'phaser', WAH: 'wah', FRM: 'formant', VOL: 'volume', PTR: 'tremolo', PIT: 'pitch',
  FIL: 'filter', FUZ: 'drive', ENH: 'enhancer', MIX: 'mixer', SYN: 'synth', MGD: 'megatap',
  GAT: 'gate', RNG: 'ringmod', MBC: 'multicomp', TTD: 'tentap', RES: 'resonator', LPR: 'looper',
  PLX: 'plex', SND: 'send', RTN: 'return', MUX: 'multiplexer',
};

const INSTANCE_COUNT: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const b of AXE_FX_III_BLOCKS) {
    const slug = GROUP_SLUG[b.groupCode];
    if (slug) out[slug] = b.instances;
  }
  return out;
})();

/** Number of addressable instances a block family supports (default 4 if unlisted).
 *  `instance_N_id = base eid + (N-1)`; the device profile's own cap is the final arbiter. */
export const blockInstances = (slug: string): number => INSTANCE_COUNT[slug.toLowerCase()] ?? 4;

/** Full placeable-block roster from the authoritative base table:
 *  { slug, name, page = base eid }, sorted by display name. */
export function effectRoster(): { slug: string; name: string; page: number }[] {
  return Object.entries(EFFECT_BASES)
    .map(([id, base]) => ({ slug: BASE_SLUG[base] ?? base.toLowerCase(), name: PRETTY_NAME[base] ?? base, page: Number(id) }))
    .filter((e) => !!e.slug)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** effect id → { slug, instance } (1-based), or null for shunts / unknown / clear (eid 0). */
export function blockRefForEid(eid: number): { slug: string; instance: number } | null {
  if (EFFECT_BASES[eid]) {
    const slug = BASE_SLUG[EFFECT_BASES[eid]!];
    return slug ? { slug, instance: 1 } : null;
  }
  for (const [baseId, name] of Object.entries(EFFECT_BASES)) {
    const d = eid - Number(baseId);
    if (d > 0 && d <= 3) {
      const slug = BASE_SLUG[name];
      return slug ? { slug, instance: d + 1 } : null;
    }
  }
  return null;
}

/** effect id (base..base+3) → editor pack slug, from the canonical base table. */
export function slugForEffectId(eid: number): string | null {
  return blockRefForEid(eid)?.slug ?? null;
}
