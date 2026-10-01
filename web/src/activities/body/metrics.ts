// Paced breathing, Steady hand and Tap the rhythm.
import type { Beat } from '../../contract';
import { finite, mean, median, round, sd, slope } from '../stats';

// ---------- Paced breathing ----------

/** Six breaths a minute: 4 s in, 6 s out (a longer out-breath is the usual resonance-breathing guide). */
export const BREATH = { inS: 4, outS: 6 } as const;
export const BREATH_S = BREATH.inS + BREATH.outS;

/** Where the guide is at time t (s): phase and 0..1 lung fill. */
export function breathAt(tS: number): { phase: 'in' | 'out'; fill: number; cycle: number; left: number } {
  const cycle = Math.floor(tS / BREATH_S);
  const u = tS - cycle * BREATH_S;
  if (u < BREATH.inS) {
    const x = u / BREATH.inS;
    return { phase: 'in', fill: 0.5 - 0.5 * Math.cos(Math.PI * x), cycle, left: Math.ceil(BREATH.inS - u) };
  }
  const x = (u - BREATH.inS) / BREATH.outS;
  return { phase: 'out', fill: 0.5 + 0.5 * Math.cos(Math.PI * x), cycle, left: Math.ceil(BREATH_S - u) };
}

/**
 * Metrics for a breathing run. With beats from a live connection: heart rate at the start
 * and end (first and last 30 s), and RSA amplitude = mean over complete breaths of (max -
 * min) instantaneous heart rate within the breath (from RR when present, else reported HR).
 */
export function breathingMetrics(beats: readonly Beat[], startedAt: number, durationS: number, completedS: number): Record<string, number> {
  const out: Record<string, number> = { breaths: Math.floor(completedS / BREATH_S), completedPct: round(Math.min(1, completedS / durationS) * 100, 0) };
  const b = beats.filter((x) => x.t >= startedAt && x.t <= startedAt + completedS * 1000);
  if (b.length < 5) return out;
  const inst = b.map((x) => ({ t: (x.t - startedAt) / 1000, hr: x.rr ? 60000 / x.rr : x.hr })).filter((x) => x.hr > 30 && x.hr < 220);
  const first = inst.filter((x) => x.t < 30).map((x) => x.hr);
  const last = inst.filter((x) => x.t > completedS - 30).map((x) => x.hr);
  const swings: number[] = [];
  for (let c = 0; (c + 1) * BREATH_S <= completedS; c++) {
    const w = inst.filter((x) => x.t >= c * BREATH_S && x.t < (c + 1) * BREATH_S).map((x) => x.hr);
    if (w.length >= 4) swings.push(Math.max(...w) - Math.min(...w));
  }
  return finite({
    ...out,
    hrStart: round(mean(first)),
    hrEnd: round(mean(last)),
    hrChange: round(mean(last) - mean(first)),
    rsaBpm: round(mean(swings)),
  });
}

// ---------- Steady hand ----------

export interface MotionSample { t: number; x: number; y: number; z: number }

/**
 * Tremor from the phone's accelerometer (m/s^2, gravity removed by the browser or by a
 * 0.5-s moving-average high-pass here). rms = RMS of the high-passed magnitude; peakHz =
 * the strongest frequency in 2..15 Hz (plain DFT); bandShare = share of 2..15 Hz power in
 * 8..12 Hz, where normal physiological tremor sits and grows with arousal and fatigue.
 */
export function tremorMetrics(s: readonly MotionSample[]): Record<string, number> {
  if (s.length < 32) return {};
  const dur = (s[s.length - 1].t - s[0].t) / 1000;
  const fs = (s.length - 1) / dur;
  const half = Math.max(1, Math.round(fs * 0.25));
  const hp = (k: 'x' | 'y' | 'z') => s.map((_, i) => {
    const w = s.slice(Math.max(0, i - half), i + half + 1);
    return s[i][k] - mean(w.map((p) => p[k]));
  });
  const x = hp('x'), y = hp('y'), z = hp('z');
  const mag = x.map((v, i) => Math.hypot(v, y[i], z[i]));
  // Spectrum on the dominant axis signal (sum of axes keeps sign; magnitude would double frequencies).
  const sig = x.map((v, i) => v + y[i] + z[i]);
  let best = 0, bestHz = NaN, total = 0, band = 0;
  for (let f = 2; f <= Math.min(15, fs / 2 - 0.5); f += 0.25) {
    let re = 0, im = 0;
    for (let i = 0; i < sig.length; i++) { const a = (2 * Math.PI * f * i) / fs; re += sig[i] * Math.cos(a); im -= sig[i] * Math.sin(a); }
    const p = re * re + im * im;
    total += p;
    if (f >= 8 && f <= 12) band += p;
    if (p > best) { best = p; bestHz = f; }
  }
  return finite({
    rms: round(Math.sqrt(mean(mag.map((m) => m * m))), 3),
    p95: round([...mag].sort((a, b) => a - b)[Math.floor(mag.length * 0.95)], 3),
    peakHz: round(bestHz, 2),
    bandShare: total ? round(band / total, 3) : NaN,
    sampleHz: round(fs, 0),
  });
}

// ---------- Tap the rhythm ----------

export const RHYTHM = { periodMs: 750, pacedBeats: 8, freeTaps: 16 } as const;

/**
 * Synchronise-then-continue tapping. Paced part: asynchrony = tap - nearest beat (negative
 * = early). Free part (no beat): intervals between taps, their variability (CV), drift
 * (slope of interval against tap number, ms per tap) and mean error against the beat period.
 */
export function rhythmMetrics(beatTimes: readonly number[], pacedTaps: readonly number[], freeTaps: readonly number[], periodMs: number = RHYTHM.periodMs): Record<string, number> {
  const asyn: number[] = [];
  for (const t of pacedTaps) {
    let best = Infinity;
    for (const b of beatTimes) if (Math.abs(t - b) < Math.abs(best)) best = t - b;
    if (Math.abs(best) < periodMs / 2) asyn.push(best);
  }
  const iv = freeTaps.slice(1).map((t, i) => t - freeTaps[i]).filter((d) => d > periodMs * 0.4 && d < periodMs * 2.2);
  const m = mean(iv);
  return finite({
    pacedTaps: pacedTaps.length,
    asyncMeanMs: round(mean(asyn)),
    asyncSdMs: round(sd(asyn)),
    freeTaps: freeTaps.length,
    intervalMeanMs: round(m),
    intervalMedianMs: round(median(iv)),
    intervalCv: round(sd(iv) / m, 3),
    driftMsPerTap: iv.length >= 3 ? round(slope(iv.map((_, i) => i), iv), 2) : NaN,
    tempoErrorPct: round(((m - periodMs) / periodMs) * 100, 1),
  });
}
