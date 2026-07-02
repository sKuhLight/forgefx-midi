/**
 * Axe-Fx Standard/Ultra (gen-1) DeviceDescriptor schema helpers.
 *
 * gen-1 params carry their own display range + scaling, so encode/decode are
 * built directly from the catalog — no external param-kind resolver. The wire
 * value is the 8-bit nibble-split value (0..range.max, usually 254).
 *
 * Display-first contract: continuous 'linear' params convert display↔wire over
 * [display.min, display.max]; enum/switch params map name↔ordinal; params the
 * doc marks non-linear ('pending' scaling) refuse display conversion and pass
 * the raw wire value through (no fabricated curve — the AM4 decode-bug class).
 */

import type {
  BlockSchema,
  BlockTypeMeta,
  ParamSchema,
  Unit,
} from '../../../core/protocol-generic/types.js';

import { KNOWN_PARAMS, AXE_FX_GEN1_BLOCKS, type AxeFxGen1Param } from '../../../gen1/index.js';

/** Wire ceiling for a param (the doc's decimal max; default full 8-bit-ish 254). */
function wireMax(p: AxeFxGen1Param): number {
  return p.range.max ?? 254;
}

/** Map the doc's display unit string to a standard unit token. */
function unitFor(p: AxeFxGen1Param): Unit {
  if (p.controlType === 'enum') return 'enum';
  if (p.controlType === 'switch') return 'bool';
  const u = (p.display?.unit ?? '').toLowerCase();
  if (u.includes('db')) return 'db';
  if (u.includes('hz')) return 'hz';
  if (u === 'ms') return 'ms';
  if (u === 's' || u === 'sec') return 'seconds';
  if (u === '%') return 'percent';
  if (p.display) return 'knob'; // unitless display range (e.g. 0.00..10.00)
  return 'opaque';
}

function reverseEnum(p: AxeFxGen1Param, value: string): number | undefined {
  if (!p.enumValues) return undefined;
  const want = value.trim().toLowerCase();
  for (const [k, v] of Object.entries(p.enumValues)) {
    if (v.toLowerCase() === want) return Number(k);
  }
  return undefined;
}

export function makeEncode(p: AxeFxGen1Param): ParamSchema['encode'] {
  const wmax = wireMax(p);
  return (display: number | string): number => {
    // Enum / switch: accept the display name or a raw ordinal.
    if (p.controlType === 'enum' || p.controlType === 'switch') {
      if (typeof display === 'string') {
        const ord = reverseEnum(p, display);
        if (ord === undefined) {
          const names = p.enumValues ? Object.values(p.enumValues).join(', ') : '(none)';
          throw new Error(`${p.block}.${p.name}: unknown value "${display}". Valid: ${names}`);
        }
        return ord;
      }
      if (!Number.isInteger(display) || display < 0 || display > wmax) {
        throw new Error(`${p.block}.${p.name}: ordinal ${display} out of range 0..${wmax}`);
      }
      return display;
    }
    // Continuous.
    const num = typeof display === 'number' ? display : Number(display);
    if (!Number.isFinite(num)) throw new Error(`${p.block}.${p.name}: expected a number, got "${display}"`);
    // Non-linear / unknown curve: pass raw wire through (no fabricated scaling).
    if (p.scaling !== 'linear' || !p.display) {
      if (!Number.isInteger(num) || num < 0 || num > wmax) {
        throw new Error(
          `${p.block}.${p.name} has no decoded display curve (gen-1 non-linear param), so it takes a raw ` +
            `wire value 0..${wmax}, not a display unit. Got ${num}. Verify on the front panel after writing.`,
        );
      }
      return num;
    }
    // Linear: display [min,max] -> wire [0,wmax].
    const { min, max } = p.display;
    if (max === min) return 0;
    const wire = Math.round(((num - min) / (max - min)) * wmax);
    return Math.max(0, Math.min(wmax, wire));
  };
}

export function makeDecode(p: AxeFxGen1Param): ParamSchema['decode'] {
  const wmax = wireMax(p);
  return (wire: number): number | string => {
    if (p.controlType === 'enum' || p.controlType === 'switch') {
      return p.enumValues?.[wire] ?? wire;
    }
    if (p.scaling !== 'linear' || !p.display) return wire;
    const { min, max } = p.display;
    const display = min + (wire / wmax) * (max - min);
    return Math.round(display * 100) / 100;
  };
}

export function buildBlocks(): Record<string, BlockSchema> {
  const blocks: Record<string, { params: Record<string, ParamSchema>; aliases: Record<string, string> }> = {};
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxGen1Param;
    blocks[p.block] ??= { params: {}, aliases: {} };
    const isEnum = p.controlType === 'enum' || p.controlType === 'switch';
    blocks[p.block].params[p.name] = {
      display_name: p.docName,
      unit: unitFor(p),
      display_min: isEnum ? undefined : p.display?.min,
      display_max: isEnum ? undefined : p.display?.max,
      enum_values: p.enumValues,
      encode: makeEncode(p),
      decode: makeDecode(p),
    };
    // Alias the original doc label (e.g. "Master Vol") to the snake_case name.
    const docAlias = p.docName.trim().toLowerCase();
    if (docAlias && docAlias !== p.name) blocks[p.block].aliases[docAlias] = p.name;
  }
  const out: Record<string, BlockSchema> = {};
  for (const [block, { params, aliases }] of Object.entries(blocks)) {
    out[block] = {
      display_name: block,
      params,
      aliases: Object.keys(aliases).length ? aliases : undefined,
    };
  }
  return out;
}

export function buildBlockTypes(): Record<string, BlockTypeMeta> {
  const out: Record<string, BlockTypeMeta> = {};
  for (const b of AXE_FX_GEN1_BLOCKS) {
    // First instance is the canonical wire value for set_block (unsupported on
    // gen-1, but the metadata is harmless + lets describe_device list blocks).
    out[b.slug] = { wire_value: b.instances[0]?.blockId ?? 0, display_name: b.docName };
  }
  return out;
}
