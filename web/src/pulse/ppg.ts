// Fingertip pulse from camera frames (photoplethysmography), as pure functions so it can be
// tested against synthetic signals. The camera input (src/inputs/camera.ts) feeds it the mean
// colour of the centre of each frame; nothing else about the frame is kept.
//
//   frames ─ resample to FS on a uniform grid (gaps > MAX_GAP_MS marked invalid)
//          ─ choose red or green (whichever has the cleaner pulse), invert (more blood = darker)
//          ─ detrend (remove a 2-s moving average) and band-pass 0.7–3.5 Hz (zero-phase Butterworth)
//          ─ dominant pulse frequency from the spectrum ─ peaks with a refractory period
//          ─ beat-to-beat intervals, never across a gap or a motion burst
//          ─ quality from signal-to-noise, saturation, finger coverage and motion.
import type { Quality } from '../contract/records';

export interface Frame { t: number; r: number; g: number; b: number }
/** Acceleration magnitude without gravity, m/s². */
export interface MotionSample { t: number; a: number }

export const FS = 60;
export const MAX_GAP_MS = 250;
export const LO_HZ = 0.7;
export const HI_HZ = 3.5;

export interface Grid {
  t0: number;
  fs: number;
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  /** 1 where a real frame is within MAX_GAP_MS/2 */
  valid: Uint8Array;
}

/** Linear interpolation of the frames onto a uniform grid. */
export function resample(frames: readonly Frame[], fs = FS): Grid {
  const n = frames.length < 2 ? 0 : Math.floor(((frames[frames.length - 1].t - frames[0].t) / 1000) * fs) + 1;
  const t0 = frames.length ? frames[0].t : 0;
  const r = new Float64Array(n), g = new Float64Array(n), b = new Float64Array(n), valid = new Uint8Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i * 1000) / fs;
    while (j < frames.length - 2 && frames[j + 1].t <= t) j++;
    const a = frames[j], c = frames[j + 1];
    const span = c.t - a.t;
    const w = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    r[i] = a.r + (c.r - a.r) * w;
    g[i] = a.g + (c.g - a.g) * w;
    b[i] = a.b + (c.b - a.b) * w;
    valid[i] = span <= MAX_GAP_MS ? 1 : 0;
  }
  return { t0, fs, r, g, b, valid };
}

// ---- filters ----

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }
function butter2(kind: 'low' | 'high', fc: number, fs: number): Biquad {
  const k = Math.tan((Math.PI * fc) / fs);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + k / q + k * k);
  const a1 = 2 * (k * k - 1) * norm;
  const a2 = (1 - k / q + k * k) * norm;
  if (kind === 'low') {
    const b0 = k * k * norm;
    return { b0, b1: 2 * b0, b2: b0, a1, a2 };
  }
  return { b0: norm, b1: -2 * norm, b2: norm, a1, a2 };
}
function runBiquad(x: Float64Array, f: Biquad): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = f.b0 * x[i] + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const reverse = (x: Float64Array) => { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[x.length - 1 - i]; return y; };

/** Centred moving average over `win` samples. */
export function movingAverage(x: Float64Array, win: number): Float64Array {
  const n = x.length, y = new Float64Array(n), h = Math.max(1, Math.floor(win / 2));
  let s = 0, lo = 0, hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    while (hi < b) s += x[++hi];
    while (lo < a) s -= x[lo++];
    y[i] = s / (hi - lo + 1);
  }
  return y;
}

/** Detrend, then zero-phase band-pass (2nd-order Butterworth high- and low-pass, run forwards and backwards). */
export function bandpass(x: Float64Array, fs: number, lo = LO_HZ, hi = HI_HZ): Float64Array {
  if (x.length < 8) return new Float64Array(x.length);
  const trend = movingAverage(x, Math.round(fs * 2));
  const d = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) d[i] = x[i] - trend[i];
  // Reflect-pad one second each side against edge transients.
  const pad = Math.min(x.length - 1, Math.round(fs));
  const p = new Float64Array(d.length + 2 * pad);
  for (let i = 0; i < pad; i++) { p[pad - 1 - i] = 2 * d[0] - d[i + 1]; p[pad + d.length + i] = 2 * d[d.length - 1] - d[d.length - 2 - i]; }
  p.set(d, pad);
  const hp = butter2('high', lo, fs), lp = butter2('low', hi, fs);
  let y = runBiquad(runBiquad(p, hp), lp);
  y = reverse(runBiquad(runBiquad(reverse(y), hp), lp));
  return y.slice(pad, pad + x.length);
}

// ---- spectrum ----

export interface Spectrum { f0: number; snrDb: number; ratio: number }

/** Dominant pulse frequency in LO..HI Hz (Hann-windowed DFT at 0.01 Hz steps) and how much of the band's power sits at it. */
export function spectrum(x: Float64Array, fs: number, mask?: Uint8Array): Spectrum {
  const n = x.length;
  if (n < fs * 3) return { f0: NaN, snrDb: -Infinity, ratio: 0 };
  // Decimate for speed: the band tops out at 3.5 Hz, so ~15 Hz is plenty.
  const step = Math.max(1, Math.floor(fs / 15));
  const m = Math.floor(n / step);
  const xs = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const v = x[i * step];
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1));
    xs[i] = mask && !mask[i * step] ? 0 : v * w;
  }
  const fsd = fs / step;
  const freqs: number[] = [], pow: number[] = [];
  for (let f = LO_HZ; f <= HI_HZ + 1e-9; f += 0.01) {
    let re = 0, im = 0;
    const wstep = (2 * Math.PI * f) / fsd;
    for (let i = 0; i < m; i++) { re += xs[i] * Math.cos(wstep * i); im -= xs[i] * Math.sin(wstep * i); }
    freqs.push(f); pow.push(re * re + im * im);
  }
  let k = 0;
  for (let i = 1; i < pow.length; i++) if (pow[i] > pow[k]) k = i;
  let f0 = freqs[k];
  // A strong dicrotic wave can make the 2nd harmonic win; prefer the fundamental when it is nearly as strong.
  const half = f0 / 2;
  if (half >= LO_HZ) {
    const kh = Math.round((half - LO_HZ) / 0.01);
    let best = kh;
    for (let i = Math.max(0, kh - 4); i <= Math.min(pow.length - 1, kh + 4); i++) if (pow[i] > pow[best]) best = i;
    if (pow[best] > 0.45 * pow[k]) { f0 = freqs[best]; }
  }
  const near = (f: number, c: number) => Math.abs(f - c) <= 0.1 || Math.abs(f - 2 * c) <= 0.1 || Math.abs(f - 3 * c) <= 0.1;
  let inP = 0, tot = 0;
  for (let i = 0; i < pow.length; i++) { tot += pow[i]; if (near(freqs[i], f0)) inP += pow[i]; }
  const ratio = tot > 0 ? inP / tot : 0;
  return { f0, ratio, snrDb: 10 * Math.log10(Math.max(ratio, 1e-6) / Math.max(1 - ratio, 1e-6)) };
}

// ---- motion ----

/** Rolling RMS over `win` samples. */
function rollingRms(x: Float64Array, win: number): Float64Array {
  const sq = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) sq[i] = x[i] * x[i];
  const m = movingAverage(sq, win);
  for (let i = 0; i < m.length; i++) m[i] = Math.sqrt(m[i]);
  return m;
}
function percentile(x: ArrayLike<number>, p: number): number {
  const s = Array.from(x).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** 1 where the pulse wave is swamped by movement: the 1-s RMS of the detrended raw signal is > 3× its quiet level,
 * or the phone's accelerometer moved (1-s SD of |a| above 0.5 m/s²). Dilated by half a second. */
export function motionMask(raw: Float64Array, grid: Grid, motion?: readonly MotionSample[]): Uint8Array {
  const fs = grid.fs, n = raw.length, mask = new Uint8Array(n);
  const trend = movingAverage(raw, Math.round(fs * 2));
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = raw[i] - trend[i];
  const rms = rollingRms(d, Math.round(fs));
  const quiet = percentile(rms, 0.3);
  for (let i = 0; i < n; i++) if (rms[i] > 3 * quiet) mask[i] = 1;
  if (motion && motion.length > 4) {
    const ms = [...motion].sort((a, b) => a.t - b.t);
    let lo = 0;
    for (let i = 0; i < n; i += Math.max(1, Math.round(fs / 10))) {
      const t = grid.t0 + (i * 1000) / fs;
      while (lo < ms.length && ms[lo].t < t - 500) lo++;
      const win: number[] = [];
      for (let j = lo; j < ms.length && ms[j].t <= t + 500; j++) win.push(ms[j].a);
      if (win.length >= 3 && sd(win) > 0.5) for (let k = i; k < Math.min(n, i + Math.round(fs / 10)); k++) mask[k] = 1;
    }
  }
  const h = Math.round(fs / 2), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (mask[i]) for (let k = Math.max(0, i - h); k <= Math.min(n - 1, i + h); k++) out[k] = 1;
  return out;
}
function sd(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

// ---- peaks ----

/** Peak times (ms, sub-sample by parabolic interpolation) of the band-passed wave, with a refractory period
 * of 0.55 of the dominant period. Peaks in invalid or moving stretches are dropped. */
export function detectPeaks(y: Float64Array, grid: Grid, f0: number, bad: Uint8Array): number[] {
  const fs = grid.fs;
  const refr = Math.max(0.28, 0.55 / (Number.isFinite(f0) ? f0 : 1.2)) * fs;
  // Local amplitude: a peak must reach 30% of the 3-s rolling RMS × √2 (the amplitude of a sine with that RMS).
  const env = rollingRms(y, Math.round(fs * 3));
  const cands: number[] = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (y[i] > y[i - 1] && y[i] >= y[i + 1] && y[i] > 0.3 * Math.SQRT2 * env[i] && !bad[i]) cands.push(i);
  }
  const kept: number[] = [];
  for (const i of cands) {
    const last = kept[kept.length - 1];
    if (last !== undefined && i - last < refr) { if (y[i] > y[last]) kept[kept.length - 1] = i; }
    else kept.push(i);
  }
  return kept.map((i) => {
    const a = y[i - 1], b = y[i], c = y[i + 1];
    const den = a - 2 * b + c;
    const off = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
    return grid.t0 + ((i + off) * 1000) / fs;
  });
}

/** Refines each beat time by matching the whole beat against the window's average beat (cross-correlation,
 * ±90 ms, parabolic sub-sample peak). Uses every sample of a beat instead of the few at its crest, which
 * is what makes beat-to-beat intervals (and so HRV) usable on a noisy camera signal. */
export function refineBeats(y: Float64Array, grid: Grid, beats: number[], bad: Uint8Array): number[] {
  if (beats.length < 6) return beats;
  const fs = grid.fs;
  const idx = (t: number) => ((t - grid.t0) / 1000) * fs;
  const gaps = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  const period = gaps[gaps.length >> 1] / 1000;
  const pre = Math.round(0.3 * period * fs), post = Math.round(0.45 * period * fs), L = pre + post + 1;
  const tpl = new Float64Array(L);
  let used = 0;
  for (const b of beats) {
    const c = Math.round(idx(b));
    if (c - pre < 0 || c + post >= y.length) continue;
    for (let k = 0; k < L; k++) tpl[k] += y[c - pre + k];
    used++;
  }
  if (used < 4) return beats;
  let mu = 0;
  for (let k = 0; k < L; k++) { tpl[k] /= used; mu += tpl[k]; }
  mu /= L;
  for (let k = 0; k < L; k++) tpl[k] -= mu;
  const maxLag = Math.round(0.09 * fs);
  return beats.map((b) => {
    const c = Math.round(idx(b));
    if (c - pre - maxLag - 1 < 0 || c + post + maxLag + 1 >= y.length || bad[c]) return b;
    const score = (lag: number) => { let s = 0; for (let k = 0; k < L; k++) s += tpl[k] * y[c + lag - pre + k]; return s; };
    let best = 0, bestS = -Infinity;
    const sc: number[] = [];
    for (let lag = -maxLag - 1; lag <= maxLag + 1; lag++) sc.push(score(lag));
    for (let lag = -maxLag; lag <= maxLag; lag++) { const v = sc[lag + maxLag + 1]; if (v > bestS) { bestS = v; best = lag; } }
    const a = sc[best + maxLag], m = sc[best + maxLag + 1], z = sc[best + maxLag + 2];
    const den = a - 2 * m + z;
    const off = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - z)) / den)) : 0;
    return grid.t0 + ((c + best + off) * 1000) / fs;
  });
}

/** How alike the beats are: power of each beat's best fit to the average beat against what is left over, in dB.
 * This is what limits beat timing (and so HRV), whatever the heart rate. */
export function beatSnrDb(y: Float64Array, grid: Grid, beats: number[], bad: Uint8Array): number {
  if (beats.length < 6) return -Infinity;
  const fs = grid.fs;
  const idx = (t: number) => Math.round(((t - grid.t0) / 1000) * fs);
  const gaps = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b);
  const period = gaps[gaps.length >> 1] / 1000;
  const pre = Math.round(0.3 * period * fs), post = Math.round(0.45 * period * fs), L = pre + post + 1;
  const segs: Float64Array[] = [];
  for (const b of beats) {
    const c = idx(b);
    if (c - pre < 0 || c + post >= y.length || bad[c]) continue;
    const seg = y.slice(c - pre, c + post + 1);
    let m = 0; for (let k = 0; k < L; k++) m += seg[k]; m /= L;
    for (let k = 0; k < L; k++) seg[k] -= m;
    segs.push(seg);
  }
  if (segs.length < 5) return -Infinity;
  const tpl = new Float64Array(L);
  for (const s of segs) for (let k = 0; k < L; k++) tpl[k] += s[k] / segs.length;
  let tt = 0; for (let k = 0; k < L; k++) tt += tpl[k] * tpl[k];
  let pFit = 0, pRes = 0;
  for (const s of segs) {
    let st = 0; for (let k = 0; k < L; k++) st += s[k] * tpl[k];
    const a = tt > 0 ? st / tt : 0;
    for (let k = 0; k < L; k++) { const f = a * tpl[k]; pFit += f * f; pRes += (s[k] - f) ** 2; }
  }
  return 10 * Math.log10(Math.max(pFit, 1e-12) / Math.max(pRes, 1e-12));
}

// ---- the whole window ----

export interface Optical {
  /** share of samples with the red mean above 250 (clipped) */
  saturated: number;
  /** share of samples too dark to carry a pulse (red mean under 20) */
  dark: number;
  /** share of samples where red dominates green and blue, as it does through a lit fingertip */
  covered: number;
}

export interface Analysis {
  /** beat times, ms */
  beats: number[];
  /** intervals between consecutive beats, ms; NaN marks a break (gap or motion) so HRV never spans one */
  rr: number[];
  f0: number;
  snrDb: number;
  /** beat-shape consistency, dB (see beatSnrDb) */
  beatSnrDb: number;
  optical: Optical;
  /** share of the window lost to movement or dropped frames */
  motionFrac: number;
  /** the pulse wave used (band-passed, inverted), for drawing */
  wave: Float64Array;
  grid: Grid;
  /** optical and motion quality (beat coverage is judged separately by signal/hrv) */
  quality: Quality;
  why: string | null;
}

export interface AnalyzeOptions { torch: boolean; motion?: readonly MotionSample[] }

export function analyze(frames: readonly Frame[], opts: AnalyzeOptions): Analysis {
  const grid = resample(frames);
  const n = grid.r.length;
  let sat = 0, dark = 0, cov = 0;
  for (let i = 0; i < n; i++) {
    const r = grid.r[i], g = grid.g[i], b = grid.b[i];
    if (r > 250) sat++;
    if (r < 20) dark++;
    if (r > 1.4 * g && r > 1.4 * b) cov++;
  }
  const optical: Optical = { saturated: n ? sat / n : 1, dark: n ? dark / n : 1, covered: n ? cov / n : 0 };

  // Red usually carries the pulse through a fingertip; green does on some phones. Pick the cleaner one.
  const neg = (x: Float64Array) => { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) y[i] = -x[i]; return y; };
  const rawR = neg(grid.r), rawG = neg(grid.g);
  const bad = motionMask(rawR, grid, opts.motion);
  for (let i = 0; i < n; i++) if (!grid.valid[i]) bad[i] = 1;
  const good = new Uint8Array(n);
  for (let i = 0; i < n; i++) good[i] = bad[i] ? 0 : 1;
  const yR = bandpass(rawR, grid.fs), yG = bandpass(rawG, grid.fs);
  const sR = spectrum(yR, grid.fs, good), sG = spectrum(yG, grid.fs, good);
  const useG = sG.ratio > sR.ratio + 0.05;
  const y = useG ? yG : yR;
  const sp = useG ? sG : sR;

  let badN = 0;
  for (let i = 0; i < n; i++) badN += bad[i];
  const motionFrac = n ? badN / n : 1;

  const beats = refineBeats(y, grid, detectPeaks(y, grid, sp.f0, bad), bad);
  const rr: number[] = [];
  const isBadBetween = (a: number, b: number) => {
    const i0 = Math.max(0, Math.floor(((a - grid.t0) / 1000) * grid.fs)), i1 = Math.min(n - 1, Math.ceil(((b - grid.t0) / 1000) * grid.fs));
    for (let i = i0; i <= i1; i++) if (bad[i]) return true;
    return false;
  };
  for (let i = 1; i < beats.length; i++) {
    if (isBadBetween(beats[i - 1], beats[i])) { if (rr.length && !Number.isNaN(rr[rr.length - 1])) rr.push(NaN); continue; }
    rr.push(beats[i] - beats[i - 1]);
  }

  const bSnr = beatSnrDb(y, grid, beats, bad);
  const { quality, why } = judge(sp.snrDb, bSnr, optical, motionFrac, opts.torch, n / grid.fs);
  return { beats, rr, f0: sp.f0, snrDb: sp.snrDb, beatSnrDb: bSnr, optical, motionFrac, wave: y, grid, quality, why };
}

/** Share of the band's power at the pulse and its harmonics, in dB against the rest, needed for 'good'. */
export const GOOD_SNR_DB = 6;
/** Beat-shape consistency needed for 'good' (see beatSnrDb). */
export const GOOD_BEAT_SNR_DB = 19;

/** Optical and motion quality. The reason is written for the person holding the phone. */
export function judge(snrDb: number, beatSnr: number, o: Optical, motionFrac: number, torch: boolean, seconds: number): { quality: Quality; why: string | null } {
  if (seconds < 3) return { quality: 'poor', why: 'Starting up' };
  if (o.covered < 0.6 || o.dark > 0.5) {
    return { quality: 'poor', why: o.dark > 0.5 && o.covered >= 0.6 ? 'Too dark. Move somewhere brighter, or use a phone with a flash.' : torch ? 'Cover the lens and the flash with your fingertip.' : 'Cover the camera with your fingertip.' };
  }
  if (motionFrac > 0.25) return { quality: 'poor', why: 'Keep your hand still.' };
  if (o.saturated > 0.3) return { quality: 'poor', why: 'Press more lightly. The image is washed out.' };
  if (snrDb < -3) return { quality: 'poor', why: 'No clear pulse yet. Rest your fingertip lightly without pressing.' };
  let q: Quality = snrDb >= GOOD_SNR_DB && beatSnr >= GOOD_BEAT_SNR_DB && motionFrac <= 0.1 && o.saturated <= 0.1 ? 'good' : 'fair';
  let why: string | null = q === 'good' ? null : motionFrac > 0.1 ? 'Some movement. Keep your hand still.' : o.saturated > 0.1 ? 'Press a little more lightly.' : 'The pulse is faint. Keep still and rest your fingertip lightly.';
  if (!torch && q === 'good') { q = 'fair'; why = 'No flash on this camera, so the reading is rougher.'; }
  return { quality: q, why };
}

/** The worse of two qualities. */
export const worst = (a: Quality, b: Quality): Quality => (a === 'poor' || b === 'poor' ? 'poor' : a === 'fair' || b === 'fair' ? 'fair' : 'good');
