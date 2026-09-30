// web/src/signal/hrv.ts (inputs agent) is the one shared beat-to-beat feature extractor. Its API:
//   cleanRR(rr) → { rr, kept, clean, rejectedFraction }
//   beatFeatures(rr, durationS?) → { hr_mean, rmssd, sdnn, nBeats, nClean, coverage, rejectedFraction, hrValid, hrvValid }
//   measurementFromRR(rr, meta) → Measurement   (every beat input uses this, the camera included)
// Import it directly; this file only re-exports the types for convenience.
export type { BeatFeatures, Cleaned } from '../signal/hrv';
