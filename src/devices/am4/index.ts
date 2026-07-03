/**
 * AM4 descriptor entry point (`forgefx-midi/devices/am4`).
 * Entry export: `AM4_DESCRIPTOR`.
 */
export * from './descriptor.js';

// Side-effect import: registers the AM4 connector factory with the shared
// connection registry. Previously guaranteed transitively (wireOps imported
// midi.ts for the message describer); explicit since the describer moved to
// describe.ts. Browser-harmless — the factory is only invoked by
// ensureConnection(), which browser runtimes never call.
import './midi.js';
