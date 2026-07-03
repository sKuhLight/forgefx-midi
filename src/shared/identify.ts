/**
 * Fractal device identification — the fn 0x00 broadcast handshake and the
 * cross-family model registry.
 *
 * Every Fractal unit answers a fn 0x00 frame addressed to the wildcard model
 * 0x7F with its own header, whose model byte (f[4]) identifies it. This is the
 * detection path live-validated on FM3/Axe-Fx III/FM9/AM4 by the ForgeFX
 * server (handshake golden under `test/gen3/fm3/fixtures/telemetry.expected.json`).
 *
 * Pure and transport-agnostic: builders/parsers only. Consumers own the
 * request/response orchestration (send the broadcast, wait ~1.5 s for a
 * header-shaped reply, fall back to `modelFromPortName` for silent USB-MIDI
 * units — e.g. an Axe-Fx III on Windows, which exposes no serial node and may
 * not answer the broadcast).
 */
import { fractalChecksum } from './checksum.js';

/** Wildcard model byte: "who is there?" (fn 0x00 broadcast). */
export const MODEL_BROADCAST = 0x7f;

export const FN_IDENTIFY = 0x00;

/** One entry in the cross-family model registry. */
export interface DeviceModel {
  name: string;
  short: string;
  /** 1 = Axe-Fx Std/Ultra, 2 = Axe-Fx II family, 3 = III/FM3/FM9/VP4, 4 = AM4. */
  gen: number;
  /** Per-device live-codec key (null = recognized, no live codec wired). */
  codec: 'fm3' | 'fm9' | 'axe3' | 'vp4' | 'am4' | null;
}

/** Model byte (SysEx header f[4], fn 0x00 handshake reply) → device. */
export const DEVICE_MODELS: Record<number, DeviceModel> = {
  0x00: { name: 'Axe-Fx Standard', short: 'Axe-Fx', gen: 1, codec: null },
  0x01: { name: 'Axe-Fx Ultra', short: 'Ultra', gen: 1, codec: null },
  0x03: { name: 'Axe-Fx II', short: 'Axe-Fx II', gen: 2, codec: null },
  0x05: { name: 'FX8', short: 'FX8', gen: 2, codec: null },
  0x06: { name: 'Axe-Fx II XL', short: 'II XL', gen: 2, codec: null },
  0x07: { name: 'Axe-Fx II XL+', short: 'II XL+', gen: 2, codec: null },
  0x08: { name: 'AX8', short: 'AX8', gen: 2, codec: null },
  0x0a: { name: 'FX8 Mk II', short: 'FX8 II', gen: 2, codec: null },
  0x10: { name: 'Axe-Fx III', short: 'Axe-Fx III', gen: 3, codec: 'axe3' },
  0x11: { name: 'FM3', short: 'FM3', gen: 3, codec: 'fm3' },
  0x12: { name: 'FM9', short: 'FM9', gen: 3, codec: 'fm9' },
  0x14: { name: 'VP4', short: 'VP4', gen: 3, codec: null }, // own value codec, no grid — flip to 'vp4' when a live driver lands
  0x15: { name: 'AM4', short: 'AM4', gen: 4, codec: 'am4' }, // 4-slot, own codec, separate device path
};

/** Build the fn 0x00 identify broadcast: `F0 00 01 74 7F 00 cs F7`. */
export function buildIdentifyBroadcast(): number[] {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL_BROADCAST, FN_IDENTIFY];
  return [...body, fractalChecksum(body), 0xf7];
}

/** True when a frame carries the Fractal manufacturer header (any model, any fn). */
export function isFractalHeaderFrame(frame: readonly number[]): boolean {
  return frame[0] === 0xf0 && frame[1] === 0x00 && frame[2] === 0x01 && frame[3] === 0x74 && frame.length > 5;
}

/** Model byte from a handshake reply (or any Fractal-headed frame); null if not one. */
export function parseIdentifyResponse(frame: readonly number[]): { modelId: number } | null {
  if (!isFractalHeaderFrame(frame)) return null;
  return { modelId: frame[4]! };
}

/**
 * Best-effort model byte from a MIDI/serial port name (e.g. "Axe-Fx III MIDI
 * In" → 0x10). Fallback when the fn 0x00 broadcast is silent. Only devices
 * with a live codec are matched, longest name first so "Axe-Fx III" wins over
 * the substring "Axe-Fx II".
 */
export function modelFromPortName(portName: string): number | null {
  const n = portName.toLowerCase();
  const byLongestName = Object.entries(DEVICE_MODELS)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => b[1].name.length - a[1].name.length);
  for (const [model, info] of byLongestName) {
    if (info.codec && n.includes(info.name.toLowerCase())) return model;
  }
  return null;
}
