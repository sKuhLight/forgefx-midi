/**
 * Transport entry point (`forgefx-midi/core/midi`).
 *
 * Both native bindings stay lazy: node-midi is loaded via `createRequire`
 * inside `transport.ts` only when a MIDI port is listed/opened, and
 * `serialport` via dynamic `import()` inside `serialTransport.ts` only when
 * a serial connect is attempted. Importing this barrel never touches either.
 */
export * from './transport.js';
export * from './serialTransport.js';
export * from './serialFraming.js';
