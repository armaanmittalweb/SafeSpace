// Small numeric helpers shared by the activity metrics, plus the "change from your calm
// runs" comparison every activity result carries.
import type { ActivityResult } from '../contract';

export const mean = (x: readonly number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
export function sd(x: readonly number[]): number {
  if (x.length < 2) return NaN;
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
}
export function median(x: readonly number[]): number {
  if (!x.length) return NaN;
  const s = [...x].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
}
export function quantile(x: readonly number[], q: number): number {
  if (!x.length) return NaN;
  const s = [...x].sort((a, b) => a - b);
  const p = (s.length - 1) * q;
  const lo = Math.floor(p);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (p - lo);
}
/** Least-squares slope of y against x. */
export function slope(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x), my = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  return den ? num / den : 0;
}
export const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Drops NaN / infinite values so a result only lists what was measured. */
export function finite(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) if (Number.isFinite(v)) out[k] = v;
  return out;
}

/** Calm runs needed before a change is shown. */
export const MIN_CALM_RUNS = 2;

/**
 * z of each metric against the user's calm runs of the same activity:
 * (x - mean) / max(sd, 10% of |mean|, 1e-6). The floor keeps two near-identical calm
 * runs from turning a tiny difference into a huge z. Null with fewer than MIN_CALM_RUNS.
 */
export function vsCalm(metrics: Record<string, number>, calmRuns: readonly ActivityResult[] | undefined, activity: ActivityResult['activity']): Record<string, number> | null {
  const runs = (calmRuns ?? []).filter((r) => r.activity === activity && r.completed);
  if (runs.length < MIN_CALM_RUNS) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(metrics)) {
    const xs = runs.map((r) => r.metrics[k]).filter(Number.isFinite);
    if (xs.length < MIN_CALM_RUNS) continue;
    const m = mean(xs);
    const s = Math.max(sd(xs) || 0, Math.abs(m) * 0.1, 1e-6);
    out[k] = round((v - m) / s, 2);
  }
  return Object.keys(out).length ? out : null;
}

/** Deterministic PRNG (mulberry32) so paths and trial orders can be replayed in tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
