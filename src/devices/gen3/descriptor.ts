/**
 * Axe-Fx III DeviceDescriptor — now produced by the modern Fractal
 * family factory. The III is one config among III / FM3 / FM9 (see
 * `./configs/axe-fx-iii.ts` and `./factory.ts`). This module keeps the
 * historical `AXEFX3_DESCRIPTOR` export name + path so the enumerating
 * scripts and server-all keep importing it unchanged.
 *
 * Registration order in `packages/server-all/src/server/index.ts` MUST
 * put the modern Fractal devices BEFORE AM4 — their port-name regexes
 * (`/axe-?fx ?iii/i`, `/fm ?3/i`, `/fm ?9/i`) are more specific than AM4's
 * catch-all `/Fractal/i`, and the dispatcher uses registration order as
 * the tiebreaker (DECISIONS.md row 40).
 */
import { createModernFractalDescriptor } from './factory.js';
import { AXE_FX_III_CONFIG } from './configs/axe-fx-iii.js';

export const AXEFX3_DESCRIPTOR = createModernFractalDescriptor(AXE_FX_III_CONFIG);
