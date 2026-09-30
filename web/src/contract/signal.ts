// web/src/signal/hrv.ts (inputs agent) — shared beat-to-beat feature extraction, used by every input.
//
//   export function cleanRR(rr: number[]): { rr: number[]; dropped: number }
//     drops RR outside 300–2000 ms, then any interval differing > 20% from the median of its
//     neighbours (up to 2 each side).
//   export function hrvFeatures(rr: number[]): HrvFeatures | null
//     cleans first; null when fewer than MIN_BEATS intervals survive.

export interface HrvFeatures {
  /** 60000 / mean clean RR */
  hr_mean: number;
  /** ms */
  rmssd: number;
  /** ms */
  sdnn: number;
  /** clean intervals used */
  n: number;
  /** intervals dropped as artefacts */
  dropped: number;
}

/** Amendment (app agent): fewer clean intervals than this and hrvFeatures returns null. */
export const MIN_BEATS = 10;
