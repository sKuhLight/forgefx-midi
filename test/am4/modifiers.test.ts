/**
 * AM4 modifier model — pins the field roster against the resolver table and
 * sanity-checks the recovered enums.
 *
 * The field roster (AM4_MOD_FIELDS) and the resolver table
 * (VARIANT_RESOLVER_BY_EFFECT_TYPE[3]) come from two independent extractions
 * of the editor cache; this asserts they agree so neither can drift.
 */
import {
  AM4_MOD_FIELDS,
  AM4_MOD_RESOLVER,
  AM4_MODIFIER_SOURCES,
  AM4_MOD_OPERATIONS,
  AM4_MOD_CHANNELS,
  AM4_MOD_AUTOENGAGE_MODES,
  AM4_MOD_DAMPING_CURVES,
  AM4_MOD_SLOT_COUNT,
  am4ModCacheId,
  type Am4ModField,
} from '../../src/am4/index.js';

export const AM4_MODIFIER_CASE_COUNT = 6;

export function runAm4ModifierTests(): void {
  const fields = Object.entries(AM4_MOD_FIELDS) as [Am4ModField, (typeof AM4_MOD_FIELDS)[Am4ModField]][];

  // 1. Every field's (symbol, cacheId) matches the resolver table exactly.
  const resolverById = new Map(AM4_MOD_RESOLVER.map((e) => [e.cache_id, e.parameterName]));
  for (const [name, def] of fields) {
    const resolverSymbol = resolverById.get(def.cacheId);
    if (resolverSymbol !== def.symbol) {
      throw new Error(
        `[am4/modifiers] ${name}: cacheId ${def.cacheId} → resolver '${resolverSymbol}', ` +
          `roster says '${def.symbol}'`,
      );
    }
  }

  // 2. Roster covers the whole modifier resolver table (no field dropped).
  const rosterCacheIds = new Set(fields.map(([, d]) => d.cacheId));
  for (const e of AM4_MOD_RESOLVER) {
    if (!rosterCacheIds.has(e.cache_id)) {
      throw new Error(`[am4/modifiers] resolver ${e.parameterName} (id ${e.cache_id}) missing from roster`);
    }
  }

  // 3. cacheIds are the contiguous run 10..34 (the modifier param block).
  const ids = fields.map(([, d]) => d.cacheId).sort((a, b) => a - b);
  const expected = Array.from({ length: 25 }, (_, i) => i + 10);
  if (ids.join(',') !== expected.join(',')) {
    throw new Error(`[am4/modifiers] cacheIds not 10..34: ${ids.join(',')}`);
  }

  // 4. The binding pair is present and typed as references.
  if (AM4_MOD_FIELDS.targetEffectId.kind !== 'ref' || AM4_MOD_FIELDS.targetParam.kind !== 'ref') {
    throw new Error('[am4/modifiers] targetEffectId/targetParam must be ref-kind');
  }
  if (am4ModCacheId('source') !== 10 || am4ModCacheId('source2') !== 30) {
    throw new Error('[am4/modifiers] source/source2 cacheIds wrong');
  }

  // 5. Enum shapes match what the cache reported.
  if (AM4_MODIFIER_SOURCES.length !== 13) {
    throw new Error(`[am4/modifiers] expected 13 sources, got ${AM4_MODIFIER_SOURCES.length}`);
  }
  AM4_MODIFIER_SOURCES.forEach((s, i) => {
    if (s.ordinal !== i) throw new Error(`[am4/modifiers] source ordinal gap at ${i}`);
  });
  if (
    AM4_MOD_OPERATIONS.length !== 3 ||
    AM4_MOD_CHANNELS.length !== 5 ||
    AM4_MOD_AUTOENGAGE_MODES.length !== 7 ||
    AM4_MOD_DAMPING_CURVES.length !== 2
  ) {
    throw new Error('[am4/modifiers] enum length mismatch');
  }

  // 6. Slot count.
  if (AM4_MOD_SLOT_COUNT !== 16) {
    throw new Error(`[am4/modifiers] expected 16 slots, got ${AM4_MOD_SLOT_COUNT}`);
  }
}
