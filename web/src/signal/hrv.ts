// Heart rate and HRV from beat-to-beat (RR) intervals. Shared by every beat source:
// the camera, Bluetooth straps, the Polar H10 ECG and the file imports.
//
// Cleaning follows docs/rebuild/contract.md:
//   1. drop RR outside 300..2000 ms (200..30 bpm);
//   2. drop any RR differing by more than 20% from the median of its neighbours
//      (up to NEIGHBOURS beats each side that survived step 1, not counting itself).
// Features follow training/features.py (ibi_features) so a window here means what a
// window meant to the models: hr_mean from all clean beats, rmssd from successive
// differences between beats that are both clean and adjacent, sdnn = sample SD
// (ddof 1) of the clean beats. Coverage (clean beats / beats expected in the window)
// gates validity the same way: HR needs >= 40%, HRV needs >= 60% and >= 10 differences.
import models from '../model/models.json';
import type { BeatSeries, InputSource, Measurement, Quality } from '../contract/records';
import { MIN_BEATS, type HrvFeatures } from '../contract/signal';

export const RR_MIN_MS = 300;
export const RR_MAX_MS = 2000;
export const MAX_REL_DEV = 0.2;
export const NEIGHBOURS = 5;
export const HR_MIN_COVERAGE = 0.4;
export const HRV_MIN_COVERAGE = 0.6;
export const HRV_MIN_DIFFS = 10;
/** Window length and stride the models were trained on (models.json). */
export const WINDOW_S: number = (models as { window_s: number }).window_s;
export const STRIDE_S: number = (models as { stride_s: number }).stride_s;

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  let a = 0;
  for (const x of xs) a += x;
  return a / xs.length;
}
/** Sample standard deviation (n - 1), NaN below two values. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let a = 0;
  for (const x of xs) a += (x - m) ** 2;
  return Math.sqrt(a / (xs.length - 1));
}

export interface Cleaned {
  /** Clean intervals in order (contract: cleanRR(rr) -> {rr, dropped}). */
  rr: number[];
  /** Number of intervals rejected. */
  dropped: number;
  /** kept[i] is true when input[i] survived cleaning. */
  kept: boolean[];
  /** Share of the input rejected, 0..1 (0 for an empty input). */
  rejectedFraction: number;
}

export function cleanRR(rr: readonly number[]): Cleaned {
  const n = rr.length;
  const inRange = rr.map((x) => Number.isFinite(x) && x >= RR_MIN_MS && x <= RR_MAX_MS);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (inRange[i]) idx.push(i);
  const kept = new Array<boolean>(n).fill(false);
  for (let j = 0; j < idx.length; j++) {
    const nb: number[] = [];
    for (let k = Math.max(0, j - NEIGHBOURS); k <= Math.min(idx.length - 1, j + NEIGHBOURS); k++) {
      if (k !== j) nb.push(rr[idx[k]]);
    }
    // With fewer than two neighbours there is nothing to compare against: keep the beat.
    if (nb.length < 2) { kept[idx[j]] = true; continue; }
    const m = median(nb);
    kept[idx[j]] = Math.abs(rr[idx[j]] - m) <= MAX_REL_DEV * m;
  }
  const clean = rr.filter((_, i) => kept[i]);
  return { rr: clean, dropped: n - clean.length, kept, rejectedFraction: n ? (n - clean.length) / n : 0 };
}

export interface BeatFeatures {
  hr_mean: number | null;
  rmssd: number | null;
  sdnn: number | null;
  nBeats: number;
  nClean: number;
  /** clean beats / beats expected in durationS at the clean median RR; 1 when no duration given. */
  coverage: number;
  rejectedFraction: number;
  hrValid: boolean;
  hrvValid: boolean;
}

/**
 * Features for one window of RR intervals (ms). durationS is the window length; when
 * omitted, the sum of the intervals is used (i.e. the beats are assumed contiguous).
 */
export function beatFeatures(rr: readonly number[], durationS?: number): BeatFeatures {
  const c = cleanRR(rr);
  const out: BeatFeatures = {
    hr_mean: null, rmssd: null, sdnn: null, nBeats: rr.length, nClean: c.rr.length,
    coverage: 0, rejectedFraction: c.rejectedFraction, hrValid: false, hrvValid: false,
  };
  if (c.rr.length < 3) return out;
  const dur = durationS ?? rr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) / 1000;
  const expected = (dur * 1000) / median(c.rr);
  out.coverage = expected > 0 ? Math.min(c.rr.length / expected, 1.5) : 0;
  if (out.coverage >= HR_MIN_COVERAGE) {
    out.hr_mean = 60000 / mean(c.rr);
    out.hrValid = true;
  }
  if (out.coverage >= HRV_MIN_COVERAGE) {
    const dd: number[] = [];
    for (let i = 1; i < rr.length; i++) if (c.kept[i] && c.kept[i - 1]) dd.push(rr[i] - rr[i - 1]);
    if (dd.length >= HRV_MIN_DIFFS) {
      out.rmssd = Math.sqrt(mean(dd.map((d) => d * d)));
      out.sdnn = sd(c.rr);
      out.hrvValid = true;
    }
  }
  return out;
}

/**
 * Contract helper (contract/signal.ts): cleans, then HR and HRV over all clean intervals
 * with no coverage gate; null under MIN_BEATS clean intervals. rmssd uses only pairs of
 * adjacent clean intervals.
 */
export function hrvFeatures(rr: readonly number[]): HrvFeatures | null {
  const c = cleanRR(rr);
  if (c.rr.length < MIN_BEATS) return null;
  const dd: number[] = [];
  for (let i = 1; i < rr.length; i++) if (c.kept[i] && c.kept[i - 1]) dd.push(rr[i] - rr[i - 1]);
  return {
    hr_mean: 60000 / mean(c.rr),
    rmssd: dd.length ? Math.sqrt(mean(dd.map((d) => d * d))) : NaN,
    sdnn: sd(c.rr),
    n: c.rr.length,
    dropped: c.dropped,
  };
}

export const hrMean = (rr: readonly number[], durationS?: number) => beatFeatures(rr, durationS).hr_mean;
export const rmssd = (rr: readonly number[], durationS?: number) => beatFeatures(rr, durationS).rmssd;
export const sdnn = (rr: readonly number[], durationS?: number) => beatFeatures(rr, durationS).sdnn;

/** good: >= 90% coverage and <= 5% rejected; fair: >= 60% and <= 20%; else poor. */
export function beatQuality(f: Pick<BeatFeatures, 'coverage' | 'rejectedFraction' | 'nClean'>): { quality: Quality; why: string | null } {
  if (f.nClean < 3) return { quality: 'poor', why: 'Too few clean beats' };
  if (f.coverage >= 0.9 && f.rejectedFraction <= 0.05) return { quality: 'good', why: null };
  if (f.coverage >= HRV_MIN_COVERAGE && f.rejectedFraction <= 0.2) {
    return { quality: 'fair', why: f.rejectedFraction > 0.05 ? `${Math.round(f.rejectedFraction * 100)}% of beats looked wrong and were left out` : 'Some beats were missed' };
  }
  return { quality: 'poor', why: f.coverage < HRV_MIN_COVERAGE ? 'Many beats were missed' : `${Math.round(f.rejectedFraction * 100)}% of beats looked wrong and were left out` };
}

/** Epoch-ms time at which each interval ends: t0 is the first beat, rr[i] ends at t0 + sum(rr[0..i]). */
export function beatTimes(series: BeatSeries): number[] {
  const out: number[] = [];
  let t = series.t0;
  for (const r of series.rr) { t += r; out.push(t); }
  return out;
}

export interface BeatWindow { start: number; end: number; rr: number[] }

/**
 * Cuts timed intervals into windows of windowS seconds every strideS seconds, keeping
 * only windows that lie entirely inside [from, to] (as in training). An interval belongs
 * to the window its end time falls in. Times are epoch ms.
 */
export function windowBeats(
  times: readonly number[], rr: readonly number[],
  opts: { windowS?: number; strideS?: number; from?: number; to?: number } = {},
): BeatWindow[] {
  const w = (opts.windowS ?? WINDOW_S) * 1000;
  const s = (opts.strideS ?? STRIDE_S) * 1000;
  if (times.length === 0) return [];
  const from = opts.from ?? times[0] - rr[0];
  const to = opts.to ?? times[times.length - 1];
  const out: BeatWindow[] = [];
  let lo = 0;
  for (let start = from; start + w <= to + 1e-6; start += s) {
    const end = start + w;
    while (lo < times.length && times[lo] < start) lo++;
    const win: number[] = [];
    for (let i = lo; i < times.length && times[i] < end; i++) win.push(rr[i]);
    out.push({ start, end, rr: win });
  }
  return out;
}

/** Turns one window of intervals into a contract Measurement. */
export function measurementFromRR(
  rr: readonly number[],
  meta: { source: InputSource; device: string | null; startedAt: number; durationS: number; keepBeats?: boolean; accStd?: number | null; motionFlagged?: boolean },
): Measurement {
  const f = beatFeatures(rr, meta.durationS);
  const q = beatQuality(f);
  const features: Measurement['features'] = {};
  if (f.hr_mean != null) features.hr_mean = f.hr_mean;
  if (f.rmssd != null) features.rmssd = f.rmssd;
  if (f.sdnn != null) features.sdnn = f.sdnn;
  if (meta.accStd != null) features.acc_std = meta.accStd;
  const m: Measurement = { source: meta.source, device: meta.device, startedAt: meta.startedAt, durationS: meta.durationS, quality: q.quality, features };
  if (meta.keepBeats) m.beats = { t0: meta.startedAt, rr: [...rr] };
  if (meta.accStd !== undefined || meta.motionFlagged !== undefined) m.motion = { flagged: !!meta.motionFlagged, accStd: meta.accStd ?? null };
  return m;
}

/**
 * Heart rate only, from periodic bpm readings (a strap that sends no RR intervals,
 * or an import with HR samples). Samples outside 30..220 bpm are ignored.
 */
export function measurementFromHr(
  bpm: readonly number[],
  meta: { source: InputSource; device: string | null; startedAt: number; durationS: number; expected?: number },
): Measurement {
  const ok = bpm.filter((b) => Number.isFinite(b) && b >= 30 && b <= 220);
  const features: Measurement['features'] = {};
  if (ok.length) features.hr_mean = mean(ok);
  const coverage = meta.expected ? ok.length / meta.expected : ok.length ? 1 : 0;
  const quality: Quality = ok.length === 0 ? 'poor' : coverage >= 0.9 ? 'good' : coverage >= 0.5 ? 'fair' : 'poor';
  return { source: meta.source, device: meta.device, startedAt: meta.startedAt, durationS: meta.durationS, quality, features };
}

/**
 * Resting heart rate from a set of window heart rates (e.g. the rest phase, or a day of
 * imported windows): the mean of the lowest quarter (at least one window), rounded to 0.1.
 * Null with no finite values.
 */
export function restingHr(hrMeans: readonly number[]): number | null {
  const v = hrMeans.filter((x) => Number.isFinite(x) && x >= 30 && x <= 220).sort((a, b) => a - b);
  if (!v.length) return null;
  const k = Math.max(1, Math.floor(v.length / 4));
  return Math.round(mean(v.slice(0, k)) * 10) / 10;
}

/** Resting HR straight from a beat series: windows it, then restingHr over the window HRs. */
export function restingHrFromBeats(series: BeatSeries, windowS = WINDOW_S): number | null {
  const times = beatTimes(series);
  const wins = windowBeats(times, series.rr, { windowS, strideS: windowS / 4 });
  const hrs = wins.map((w) => beatFeatures(w.rr, windowS).hr_mean).filter((x): x is number => x != null);
  if (!hrs.length) {
    const f = beatFeatures(series.rr);
    return f.hr_mean == null ? null : Math.round(f.hr_mean * 10) / 10;
  }
  return restingHr(hrs);
}
