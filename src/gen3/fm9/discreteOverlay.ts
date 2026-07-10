// FM9 discrete-ordinal classification overlay (param firmware symbol -> maxOrdinal).
// Ported from upstream fractal-midi 0.6.1 src/gen3/fm9/roundtripDiscrete.generated.ts;
// CLASSIFICATION ONLY, applied as an overlay over our NEWER ranges/rosters (never
// overwriting our range values). NOT a *.generated.ts file: we have no generator for
// it here, so it is a committed, hand-maintained source table. Re-port from upstream
// if that oracle is regenerated.
//
// Upstream provenance: derived from the device's OWN full hardware roundtrip sweep
// (chihotta-roundtrip-2026-06-18, FM9, modelByte 0x12). A param is roundtrip-DISCRETE
// iff across its SET->READ sweep every gotWire is a non-negative integer, monotonic
// non-decreasing in sentWire, and at the max sentWire (65534) gotWire <= 1024 AND
// < sentWire (clearly quantized to a small ordinal, not pass-through) AND max
// gotWire >= 1. maxOrdinal = gotWire at the max sentWire.
//
// These params are routed DISCRETE (float32(ordinal), sub 09 00) instead of
// CONTINUOUS — the wire builder is unchanged; only the catalog kind-classification
// differs, so the gen-3 byte-identity anchor stays intact.
/* eslint-disable */

export const FM9_ROUNDTRIP_DISCRETE: Readonly<Record<string, number>> = {
  "CABINET_TYPE1": 15,
  "CABINET_TYPE2": 15,
  "CABINET_ZOOM": 1,
  "CHORUS_VOICES": 4,
  "DELAY_BITREDUCE": 24,
  "DELAY_KILLDRY": 1,
  "FILTER_APORDER": 12,
  "FUZZ_BITREDUCE": 24,
  "FUZZ_NDQTY": 4,
  "FUZZ_PDQTY": 4,
  "MEGATAP_FDBKTAP": 64,
  "MEGATAP_NUMTAPS": 64,
  "MOD_ENDPT": 78,
  "PHASER_FBTAP": 11,
  "PITCH_CUSTOMNOTES": 8,
  "PITCH_CUSTOMSCALE1": 31,
  "PITCH_CUSTOMSCALE2": 31,
  "PITCH_NOTE2": 5,
  "PITCH_NOTE3": 6,
  "PITCH_NOTE5": 8,
  "PITCH_NOTE6": 9,
  "PITCH_NOTE7": 10,
  "PITCH_NOTE8": 11,
  "PITCH_NUMREPEATS": 31,
  "PITCH_NUMSTEPS": 16,
  "PLEX_NUMDLINES": 4,
  "PLEX_SHIMMERINTENS": 10,
  "REVERB_BASETYPE": 8,
  "REVERB_DENSITY": 8,
  "REVERB_KILLDRY": 1,
  "REVERB_NUMSPRINGS": 6,
  "REVERB_TONETYPE": 3,
  "TENTAP_DECAYSTYLE": 1,
  "TENTAP_NUMTAPS": 10,
};
