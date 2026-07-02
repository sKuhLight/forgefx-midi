/**
 * Modern Fractal family descriptor exports (Axe-Fx III / FM3 / FM9).
 *
 * Importing this file brings in the MIDI connector side-effect (via
 * `./midi.js`) so `ensureConnection('axe-fx-iii' | 'fm3' | 'fm9')` routes
 * through the matching connector.
 *
 * Device registration (registerDevice) is intentionally NOT a side effect
 * here — the caller (server-all/src/server/index.ts) iterates
 * `MODERN_FRACTAL_DESCRIPTORS` and calls `registerMcpDevice(...)`
 * explicitly, matching AM4 / II / Hydrasynth. This keeps test scripts
 * that import a descriptor clean (no global registry mutations on import).
 */
import './midi.js';

import type { DeviceDescriptor } from '../../core/protocol-generic/types.js';
import { createModernFractalDescriptor } from './factory.js';
import { AXE_FX_III_CONFIG } from './configs/axe-fx-iii.js';
import { FM3_CONFIG } from './configs/fm3.js';
import { FM9_CONFIG } from './configs/fm9.js';
import { VP4_CONFIG } from './configs/vp4.js';

export { AXEFX3_DESCRIPTOR } from './descriptor.js';
import { AXEFX3_DESCRIPTOR } from './descriptor.js';
export const FM3_DESCRIPTOR: DeviceDescriptor = createModernFractalDescriptor(FM3_CONFIG);
export const FM9_DESCRIPTOR: DeviceDescriptor = createModernFractalDescriptor(FM9_CONFIG);
export const VP4_DESCRIPTOR: DeviceDescriptor = createModernFractalDescriptor(VP4_CONFIG);

/**
 * Every descriptor this package ships, in registration order (most-
 * specific port_match first — all are narrower than AM4's catch-all
 * `/Fractal/i`). server-all and the enumerating test scripts iterate this
 * so a newly-added modern Fractal device is covered automatically rather
 * than silently skipped.
 */
export const MODERN_FRACTAL_DESCRIPTORS: readonly DeviceDescriptor[] = [
  AXEFX3_DESCRIPTOR,
  FM3_DESCRIPTOR,
  FM9_DESCRIPTOR,
  VP4_DESCRIPTOR,
];

export {
  describeAxeFxIIIPortStatus,
  describeFM3PortStatus,
  describeFM9PortStatus,
  describeVP4PortStatus,
} from './midi.js';
