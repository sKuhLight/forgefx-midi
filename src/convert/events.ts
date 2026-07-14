/**
 * Conversion-event schema for the cross-device preset converter (P2).
 *
 * `convertPreset()` (see `engine.ts`) returns a `ConversionResult` carrying the
 * target IR plus an ordered list of `ConversionEvent`s. Every lossy or
 * best-effort decision the engine makes emits an event, so the UI layers
 * (ForgeFX / Axis fake-grid) can show the user exactly what changed and how
 * confident the converter is. This module is the UI CONTRACT: the event kinds,
 * their payloads, and the single `severityOf()` classifier live here so every
 * consumer reads one source of truth.
 *
 * Events are pure data (no functions, no Date/random). The engine appends them
 * in pipeline order; `severityOf()` derives a severity band for filtering /
 * colouring without the consumer re-implementing the rules.
 */

import type { ConverterFamily, ConverterDeviceId } from './families.js';
import type { ConverterDecodeDepth } from './ir.js';
import type { LineageConfidence } from './lineageIndex.js';

/** Severity band for an event, derived by `severityOf()`. */
export type ConversionSeverity = 'info' | 'warn' | 'loss';

/** A block was removed entirely; the target cannot carry it. */
export interface BlockDroppedEvent {
  kind: 'block-dropped';
  blockKey: string;
  family: ConverterFamily;
  /**
   *   - `family-missing`     — the target device has no such block family.
   *   - `capacity-exceeded`  — the target ran out of placeable positions.
   *   - `instance-limit`     — the target allows fewer instances of the family
   *                            (e.g. AM4 single-per-family) than the source had.
   */
  reason: 'family-missing' | 'capacity-exceeded' | 'instance-limit';
}

/**
 * A block's type/model was mapped to a target-device model. Emitted for EVERY
 * resolved block — including exact matches — so the UI has full provenance;
 * `confidence` drives the severity.
 */
export interface TypeSubstitutedEvent {
  kind: 'type-substituted';
  blockKey: string;
  family: ConverterFamily;
  sourceTypeName: string;
  targetTypeName: string;
  confidence: LineageConfidence;
  /** Fuzzy score, present only for `confidence: 'fuzzy'`. */
  score?: number;
}

/**
 * A block survived family/capacity but its type could not be resolved on the
 * target (no roster data for the family). The block is KEPT with an undefined
 * `typeName` (default) so the fake-grid can offer a type picker.
 */
export interface TypeUnresolvedEvent {
  kind: 'type-unresolved';
  blockKey: string;
  family: ConverterFamily;
  sourceTypeName: string;
}

/** A parameter value was clamped to the target's valid range. */
export interface ParamClampedEvent {
  kind: 'param-clamped';
  blockKey: string;
  nativeName: string;
  conceptKey?: string;
  sourceValue: number;
  targetValue: number;
  targetMin?: number;
  targetMax?: number;
}

/** A parameter was not carried onto the target. */
export interface ParamDroppedEvent {
  kind: 'param-dropped';
  blockKey: string;
  nativeName: string;
  /**
   *   - `no-concept-mapping` — the param has no cross-device concept key and
   *                            source/target vocabularies differ.
   *   - `target-lacks-param` — the concept exists but the target device has no
   *                            column for it.
   */
  reason: 'no-concept-mapping' | 'target-lacks-param';
}

/** A parameter was carried but no target range data exists to validate it. */
export interface ParamUnverifiedEvent {
  kind: 'param-unverified';
  blockKey: string;
  nativeName: string;
  value: number;
}

/** Routing structure was reduced (parallel flattened / grid → chain / slots). */
export interface RoutingSimplifiedEvent {
  kind: 'routing-simplified';
  detail: string;
  affectedBlockKeys: string[];
}

/** A block mapped cleanly by family/type but had no free position to land in. */
export interface BlockUnplacedEvent {
  kind: 'block-unplaced';
  blockKey: string;
  family: ConverterFamily;
  reason: string;
}

/** Scenes beyond the target's capacity were truncated. */
export interface SceneCollapsedEvent {
  kind: 'scene-collapsed';
  sourceScenes: number;
  targetScenes: number;
}

/** A block's channels beyond the target's per-block capacity were truncated. */
export interface ChannelCollapsedEvent {
  kind: 'channel-collapsed';
  blockKey: string;
  sourceChannels: number;
  targetChannels: number;
}

/** Blanket caveat: the SOURCE preset was only partially decoded. */
export interface SourcePartialEvent {
  kind: 'source-partial';
  decodeDepth: ConverterDecodeDepth;
  detail: string;
}

/** The discriminated union of every conversion event. */
export type ConversionEvent =
  | BlockDroppedEvent
  | TypeSubstitutedEvent
  | TypeUnresolvedEvent
  | ParamClampedEvent
  | ParamDroppedEvent
  | ParamUnverifiedEvent
  | RoutingSimplifiedEvent
  | BlockUnplacedEvent
  | SceneCollapsedEvent
  | ChannelCollapsedEvent
  | SourcePartialEvent;

/** Every event kind, for exhaustiveness checks / UI enumeration. */
export type ConversionEventKind = ConversionEvent['kind'];

/**
 * Classify an event into a severity band. One place, so the rule is uniform:
 *   - `info` — faithful / non-destructive (exact + lineage type matches,
 *              unverified params, informational).
 *   - `warn` — best-effort but imperfect (fuzzy/fallback types, unresolved
 *              types, clamped params, flattened routing, partial source).
 *   - `loss` — data removed (dropped/unplaced blocks, dropped params,
 *              collapsed scenes/channels).
 */
export function severityOf(event: ConversionEvent): ConversionSeverity {
  switch (event.kind) {
    case 'block-dropped':
    case 'block-unplaced':
    case 'param-dropped':
    case 'scene-collapsed':
    case 'channel-collapsed':
      return 'loss';
    case 'type-substituted':
      return event.confidence === 'exact' || event.confidence === 'lineage'
        ? 'info'
        : 'warn';
    case 'type-unresolved':
    case 'param-clamped':
    case 'routing-simplified':
    case 'source-partial':
      return 'warn';
    case 'param-unverified':
      return 'info';
  }
}

/** True when the event's severity is `'loss'`. Convenience for filtering. */
export function isLoss(event: ConversionEvent): boolean {
  return severityOf(event) === 'loss';
}
