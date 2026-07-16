/**
 * Per-device preset → IR adapters. Each lifts a device's decoded preset into
 * the device-agnostic `ConverterPreset` IR, as deep as that device's current
 * decode allows (gen-3 full, AM4 partial, VP4 / gen-2 skeleton).
 */

export { liftGen3Preset } from './gen3.js';
export { liftAm4Preset } from './am4.js';
export { liftVp4Preset } from './vp4.js';
export { liftGen2Preset } from './gen2.js';
