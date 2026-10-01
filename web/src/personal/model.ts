// A personal stress model per activity, trained in the browser from the person's own stress
// sessions: activity runs at rest are calm (0), runs during the challenge are stressed (1).
//
// Model: L2-regularised logistic regression on standardised features (the same kind of
// model as the wrist signals), fitted by Newton's method (IRLS), which converges in a few
// steps for this size. Evaluation: leave-one-session-out; every held-out prediction is
// pooled and scored with balanced accuracy. ready = balanced accuracy >= 0.7 over >= 6
// held-out runs (contract). The stored coefficients are converted back to raw units, so
// scoring needs no standardisation parameters.
import type { ActivityId, PersonalModel, StressSession } from '../contract';
import { labelledRuns, type LabelledRun } from '../session/summary';

/** Features per activity: a few that move with arousal and are measured on every device. */
export const PERSONAL_FEATURES: Record<ActivityId, string[]> = {
  typing: ['interKeyMeanMs', 'interKeyCv', 'errorRate', 'corrections'],
  'follow-dot': ['meanErrorPct', 'jerk', 'overCorrectionsPerMin'],
  'target-taps': ['timeToTapMs', 'accuracyPct', 'errorRadii'],
  stroop: ['rtIncongruentMs', 'interferenceMs', 'errorRate'],
  'beat-the-clock': ['meanRtMs', 'accuracy'],
  'paced-breathing': ['rsaBpm', 'hrChange'],
  'steady-hand': ['rms', 'bandShare'],
  'tap-rhythm': ['asyncSdMs', 'intervalCv'],
};

export const L2 = 1.0;
export const READY_BA = 0.7;
export const READY_N = 6;

const sig = (x: number) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

export interface Fit { w: number[]; b: number; mu: number[]; sd: number[] }

/** Solves A x = y (small, symmetric positive definite) by Gaussian elimination with pivoting. */
function solve(A: number[][], y: number[]): number[] {
  const n = y.length;
  const M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (M[i][i] || 1e-12));
}

/** Fits on rows X (raw units) with labels y. The intercept is not penalised. */
export function fitLogistic(X: number[][], y: number[], l2 = L2): Fit {
  const d = X[0].length, n = X.length;
  const mu = Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[j], 0) / n);
  const sd = Array.from({ length: d }, (_, j) => {
    const v = X.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / n;
    return Math.sqrt(v) || 1;
  });
  const Z = X.map((r) => r.map((x, j) => (x - mu[j]) / sd[j]));
  let beta = new Array(d + 1).fill(0); // [b, w...]
  for (let it = 0; it < 50; it++) {
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    const g = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = [1, ...Z[i]];
      const p = sig(xi.reduce((a, x, k) => a + x * beta[k], 0));
      const wgt = Math.max(p * (1 - p), 1e-9);
      for (let a = 0; a <= d; a++) {
        g[a] += (p - y[i]) * xi[a];
        for (let c = 0; c <= d; c++) H[a][c] += wgt * xi[a] * xi[c];
      }
    }
    for (let a = 1; a <= d; a++) { g[a] += l2 * beta[a]; H[a][a] += l2; }
    const step = solve(H, g);
    beta = beta.map((v, k) => v - step[k]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return { b: beta[0], w: beta.slice(1), mu, sd };
}

export function predictFit(f: Fit, x: number[]): number {
  return sig(f.b + x.reduce((a, v, j) => a + f.w[j] * ((v - f.mu[j]) / f.sd[j]), 0));
}

export function balancedAccuracy(y: number[], p: number[]): number {
  let tp = 0, tn = 0, P = 0, N = 0;
  y.forEach((t, i) => { if (t) { P++; if (p[i] >= 0.5) tp++; } else { N++; if (p[i] < 0.5) tn++; } });
  if (!P || !N) return NaN;
  return (tp / P + tn / N) / 2;
}

/** Rows that have every feature. */
function matrix(rows: LabelledRun[], feats: string[]) {
  const ok = rows.filter((r) => feats.every((f) => Number.isFinite(r.metrics[f])));
  return { rows: ok, X: ok.map((r) => feats.map((f) => r.metrics[f])), y: ok.map((r) => r.y) };
}

export function trainFromRuns(activity: ActivityId, runs: LabelledRun[], now = Date.now()): PersonalModel | null {
  const feats = PERSONAL_FEATURES[activity].filter((f) => runs.filter((r) => Number.isFinite(r.metrics[f])).length >= Math.max(2, runs.length * 0.8));
  if (!feats.length) return null;
  const { rows, X, y } = matrix(runs, feats);
  if (!y.includes(0) || !y.includes(1)) return null;
  // Leave one session out.
  const sessions = [...new Set(rows.map((r) => r.sessionId))];
  const yt: number[] = [], pt: number[] = [];
  for (const s of sessions) {
    const tr = rows.map((r, i) => (r.sessionId !== s ? i : -1)).filter((i) => i >= 0);
    const te = rows.map((r, i) => (r.sessionId === s ? i : -1)).filter((i) => i >= 0);
    const ytr = tr.map((i) => y[i]);
    if (!ytr.includes(0) || !ytr.includes(1)) continue;
    const f = fitLogistic(tr.map((i) => X[i]), ytr);
    for (const i of te) { yt.push(y[i]); pt.push(predictFit(f, X[i])); }
  }
  const ba = balancedAccuracy(yt, pt);
  const full = fitLogistic(X, y);
  // Back to raw units: w_raw = w / sd, b_raw = b - sum(w * mu / sd).
  const coef = full.w.map((w, j) => w / full.sd[j]);
  const intercept = full.b - full.w.reduce((a, w, j) => a + (w * full.mu[j]) / full.sd[j], 0);
  const n = yt.length;
  const balancedAccuracy_ = Number.isFinite(ba) ? Math.round(ba * 1000) / 1000 : 0;
  return {
    activity, features: feats, coef, intercept, trainedOn: now,
    heldOut: { balancedAccuracy: balancedAccuracy_, n },
    ready: n >= READY_N && balancedAccuracy_ >= READY_BA,
  };
}

/** Contract: train(activity, sessions) -> PersonalModel | null (null without both classes). */
export function train(activity: ActivityId, sessions: StressSession[]): PersonalModel | null {
  return trainFromRuns(activity, labelledRuns(sessions, activity));
}

/** Contract: a score in -1..+1 (2p - 1), like the wrist pens. NaN when a model feature is missing from the run. */
export function scoreWith(model: PersonalModel, metrics: Record<string, number>): number {
  let z = model.intercept;
  for (let j = 0; j < model.features.length; j++) {
    const v = metrics[model.features[j]];
    if (!Number.isFinite(v)) return NaN;
    z += model.coef[j] * v;
  }
  return 2 * sig(z) - 1;
}
