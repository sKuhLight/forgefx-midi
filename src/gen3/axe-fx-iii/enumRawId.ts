/**
 * Gen-3 enum set-by-name resolver: name → broadcast/GET ORDINAL.
 *
 * There is ONE ordinal space, not two. A discrete type/model SELECT carries its
 * value as `float32(read-ordinal)` at payload pos 12 (see `encode5SeptetFloat32`
 * / `buildSetParameter`), so the read-leg ordinal IS the set value. The
 * "two-leg / raw-id permutation" framing was an artifact of reading that float's
 * high septets as a `packValue16` integer at pos 15 (lossy: ordinals 16,17,18,19
 * all collapse to 524). Confirmed FM3 fw 12.00 (BoodieTraps) + our FM9 reverb
 * capture, 2026-06-08; writeup in `docs/_private/DREW-MSG2-VERIFIED-PLAN-2026-06-08.md`.
 *
 * `resolveGen3EnumOrdinal(symbol, name)` is the set-by-name source: it reverse-
 * maps the same enum vocabulary the READ leg uses (case/word-order tolerant), so
 * a name the device labels on read is the exact name accepted on write. The
 * catalog's enum `encode` returns that ordinal; the writer emits `float32(ordinal)`.
 *
 * DEPRECATED (kept only until the legacy goldens are migrated): the
 * `GEN3_ENUM_ORDINAL_TO_RAW_ID` table + `resolveGen3EnumNameToRawId` modelled a
 * non-existent raw-id space. Two of its three shipped entries actually
 * MIS-SELECTED (REVERB 45→529 wires float32 40.0; FUZZ 15→523 wires 14.0). Do
 * NOT add entries; do NOT use for new code. Pure data + offline lookup, no MIDI.
 */

import { resolveEnumValues, resolveEffectTypeEnum } from './enumOverlay.js';

/** Normalize an enum label for tolerant matching (case + whitespace). */
export function normalizeLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The normalized forms an enum label should match. The AM4 `cacheEnums` arrays
 * (the read-leg name source) use "Category, Modifier" order, e.g.
 * "Spring, Medium" / "Hall, Music"; natural phrasing reverses it,
 * "Medium Spring" / "Music Hall". We accept the canonical form, the
 * comma-stripped form, and (for single-comma labels) the comma-swapped form, so
 * either word order resolves. The caller tries exact match first, so this only
 * ever broadens, never overrides, a precise match.
 */
export function enumLabelForms(s: string): Set<string> {
  const forms = new Set<string>();
  const n = normalizeLabel(s);
  forms.add(n);
  forms.add(normalizeLabel(n.replace(/,/g, ' ')));
  const ci = s.indexOf(',');
  if (ci >= 0 && s.indexOf(',', ci + 1) < 0) {
    const before = s.slice(0, ci);
    const after = s.slice(ci + 1);
    // Word-order swap: "Spring, Medium" ↔ "Medium Spring".
    forms.add(normalizeLabel(`${after} ${before}`));
    // The post-comma segment alone, so "Recording Studio A" matches the
    // catalog's "Room, Recording Studio A" (Category, Specific labels). Exact
    // match is tried first and ties break to the lowest ordinal, so this only
    // broadens — it never overrides a precise match.
    forms.add(normalizeLabel(after));
  }
  return forms;
}

/**
 * Look up the READ-leg enum vocabulary for a gen-3 param symbol. Prefers the
 * full overlay (the III, whose params are tagged `unit: 'enum'`); falls back
 * to the strict effect-type-only overlay (the FM3/FM9 device-true catalogs).
 * Returns the ordinal → label map, or undefined when the param is not an enum.
 */
function lookupVocabulary(paramSymbol: string): Readonly<Record<number, string>> | undefined {
  return (resolveEnumValues(paramSymbol) ?? resolveEffectTypeEnum(paramSymbol))?.values;
}

/**
 * Resolve an enum NAME to its broadcast/GET ORDINAL via the offline overlay.
 * Case/whitespace tolerant. Returns the ordinal + the canonical label it
 * matched, or undefined (with the available labels as suggestions) when no
 * label matches. Returns `noEnum: true` when the param carries no vocabulary.
 *
 * This ordinal IS the discrete-SET value (`buildSetParameter` emits
 * `float32(ordinal)` at payload pos 12), so name→ordinal is the COMPLETE
 * set-by-name path, not half of one. It is equally usable for "did the user
 * name a real value?" validation. There is no second leg: the retired
 * `GEN3_ENUM_ORDINAL_TO_RAW_ID` table modelled a non-existent raw-id space
 * (see the top docstring).
 */
export function resolveGen3EnumOrdinal(
  paramSymbol: string,
  name: string,
):
  | { noEnum: true }
  | { ordinal: number; matchedLabel: string }
  | { ordinal: undefined; suggestions: readonly string[] } {
  const vocab = lookupVocabulary(paramSymbol);
  if (vocab === undefined) return { noEnum: true };
  const target = normalizeLabel(name);
  const labels: string[] = [];
  // Pass 1: exact (case/whitespace) match — most precise, never ambiguous.
  for (const [ordStr, label] of Object.entries(vocab)) {
    labels.push(label);
    if (normalizeLabel(label) === target) {
      return { ordinal: Number(ordStr), matchedLabel: label };
    }
  }
  // Pass 2: category/modifier word-order tolerance (comma swap/strip), so
  // "Medium Spring" matches the array's canonical "Spring, Medium".
  const inputForms = enumLabelForms(name);
  for (const [ordStr, label] of Object.entries(vocab)) {
    const labelForms = enumLabelForms(label);
    for (const f of labelForms) {
      if (inputForms.has(f)) return { ordinal: Number(ordStr), matchedLabel: label };
    }
  }
  return { ordinal: undefined, suggestions: labels };
}
