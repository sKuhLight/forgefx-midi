/**
 * Core device-descriptor layer entry point (`forgefx-midi/core`).
 *
 * Transport-agnostic primitives shared by every device descriptor:
 * the descriptor/dispatch type contracts, param-kind + concept-key
 * registries, error formatting, the loudness corpus, buffer-dirty
 * tracking, safe-edit primitives, the per-port connection registry,
 * and grid audibility analysis.
 *
 * The MIDI transports live under `forgefx-midi/core/midi` (separate
 * subpath so this barrel never references the native-binding modules).
 */
export * from './protocol-generic/types.js';
export * from './protocol-generic/paramKind.js';
export * from './protocol-generic/concept-keys.js';
export * from './protocol-generic/dispatcher/errorFormat.js';
export * from './fractal-shared/loudness.js';
export * from './server-shared/bufferDirty.js';
export * from './server-shared/safeEdit.js';
export * from './server-shared/connections.js';
export * from './routing/audibility.js';
