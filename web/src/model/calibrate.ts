// rest5 calibration, as in training/pipeline.py: each feature is z-scored against the
// mean and SD of the windows lying entirely in the first 5 minutes at rest, with the SD
// floored per feature (so a resting SCR count of zero does not divide by zero).
import { CHANNELS, MODELS, type Channel } from './score';

export interface Calibration {
  mean: Record<Channel, number>;
  sd: Record<Channel, number>;
  n: number;
}

export function calibrate(values: Record<Channel, number>[]): Calibration {
  const mean = {} as Record<Channel, number>;
  const sd = {} as Record<Channel, number>;
  for (const c of CHANNELS) {
    const v = values.map((w) => w[c]).filter(Number.isFinite);
    const mu = v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1);
    const s = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / (v.length - 1)) : 0;
    mean[c] = mu;
    sd[c] = Math.max(s, MODELS.calibration.sd_floor[c]);
  }
  return { mean, sd, n: values.length };
}

export function zScores(x: Record<Channel, number>, cal: Calibration): Record<Channel, number> {
  const z = {} as Record<Channel, number>;
  for (const c of CHANNELS) z[c] = (x[c] - cal.mean[c]) / cal.sd[c];
  return z;
}
