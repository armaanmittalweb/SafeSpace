// Skin conductance, skin temperature and motion features for one window, ported from
// training/features.py (eda_features, temp_features, acc_features) so an imported
// Empatica E4 window means what a training window meant. tests/signal/eda.test.ts checks
// the port against scipy's output on the same input to 1e-6.
//
//   eda_tonic  mean of the tonic level (2nd-order Butterworth low-pass 1 Hz, then 0.05 Hz,
//              both zero-phase as scipy.signal.sosfiltfilt), uS
//   eda_slope  least-squares slope of the tonic level, uS/min
//   scr_count  phasic (smoothed - tonic) peaks with prominence >= 0.02 uS and >= 1 s apart,
//              per minute of window
//   scr_amp    mean prominence of those peaks, uS (0 without peaks)
//   temp_mean  mean skin temperature, degC;  temp_slope  its slope, degC/min
//   acc_std    SD (population) of |acc| in g; the E4 reports 1/64 g per unit
export const EDA_HZ = 4;
export const SCR_MIN_AMP = 0.02;

export interface Biquad { b: [number, number, number]; a: [number, number, number] }

/** 2nd-order Butterworth low-pass, bilinear transform with pre-warping (= scipy.signal.butter(2, fc, fs=fs)). */
export function butterLow2(fc: number, fs: number): Biquad {
  const k = Math.tan((Math.PI * fc) / fs);
  const q = Math.SQRT2;
  const norm = 1 / (1 + q * k + k * k);
  const b0 = k * k * norm;
  return { b: [b0, 2 * b0, b0], a: [1, 2 * (k * k - 1) * norm, (1 - q * k + k * k) * norm] };
}

/** Direct form II transposed, with initial state z (mutated copy returned). */
function filt(f: Biquad, x: Float64Array, z0: [number, number]): Float64Array {
  const [b0, b1, b2] = f.b;
  const [, a1, a2] = f.a;
  let [z1, z2] = z0;
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + z1;
    z1 = b1 * xi - a1 * yi + z2;
    z2 = b2 * xi - a2 * yi;
    y[i] = yi;
  }
  return y;
}

/** Steady-state initial conditions for a unit step (scipy.signal.sosfilt_zi for one section). */
function zi(f: Biquad): [number, number] {
  const [b0, b1, b2] = f.b;
  const [, a1, a2] = f.a;
  const g = (b0 + b1 + b2) / (1 + a1 + a2);
  const z2 = b2 - a2 * g;
  const z1 = b1 - a1 * g + z2;
  return [z1, z2];
}

/**
 * Zero-phase filtering as scipy.signal.sosfiltfilt with one section and the defaults:
 * odd extension of padlen = 9 samples at each end, steady-state initial conditions.
 */
export function filtfilt(f: Biquad, xIn: ArrayLike<number>): Float64Array {
  const n = xIn.length;
  const padlen = 9;
  if (n <= padlen) throw new RangeError(`filtfilt needs more than ${padlen} samples`);
  const ext = new Float64Array(n + 2 * padlen);
  for (let i = 0; i < padlen; i++) ext[i] = 2 * xIn[0] - xIn[padlen - i];
  for (let i = 0; i < n; i++) ext[padlen + i] = xIn[i];
  for (let i = 0; i < padlen; i++) ext[padlen + n + i] = 2 * xIn[n - 1] - xIn[n - 2 - i];
  const z = zi(f);
  const fwd = filt(f, ext, [z[0] * ext[0], z[1] * ext[0]]);
  fwd.reverse();
  const back = filt(f, fwd, [z[0] * fwd[0], z[1] * fwd[0]]);
  back.reverse();
  return back.slice(padlen, padlen + n);
}

/** Local maxima as scipy.signal._peak_finding_utils._local_maxima_1d (plateaus give their middle). */
function localMaxima(x: ArrayLike<number>): number[] {
  const peaks: number[] = [];
  let i = 1;
  const last = x.length - 1;
  while (i < last) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < last && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push((i + ahead - 1) >> 1);
        i = ahead;
      }
    }
    i++;
  }
  return peaks;
}

/**
 * scipy.signal.find_peaks(x, prominence=minProminence, distance=distance) for the case
 * used in training: distance filter by height priority first, then prominences on the
 * full signal (no wlen). Returns peak indices and their prominences.
 */
export function findPeaks(x: ArrayLike<number>, minProminence: number, distance: number): { peaks: number[]; prominences: number[] } {
  let peaks = localMaxima(x);
  if (distance > 1 && peaks.length > 1) {
    const keep = new Array<boolean>(peaks.length).fill(true);
    const order = peaks.map((_, i) => i).sort((a, b) => x[peaks[a]] - x[peaks[b]] || a - b);
    for (let o = order.length - 1; o >= 0; o--) {
      const j = order[o];
      if (!keep[j]) continue;
      let k = j - 1;
      while (k >= 0 && peaks[j] - peaks[k] < distance) { keep[k] = false; k--; }
      k = j + 1;
      while (k < peaks.length && peaks[k] - peaks[j] < distance) { keep[k] = false; k++; }
    }
    peaks = peaks.filter((_, i) => keep[i]);
  }
  const out: number[] = [];
  const proms: number[] = [];
  for (const p of peaks) {
    let leftMin = x[p];
    for (let i = p; i >= 0 && x[i] <= x[p]; i--) if (x[i] < leftMin) leftMin = x[i];
    let rightMin = x[p];
    for (let i = p; i < x.length && x[i] <= x[p]; i++) if (x[i] < rightMin) rightMin = x[i];
    const prom = x[p] - Math.max(leftMin, rightMin);
    if (prom >= minProminence) { out.push(p); proms.push(prom); }
  }
  return { peaks: out, prominences: proms };
}

/** Least-squares slope of x against time in minutes (np.polyfit(t, x, 1)[0]). */
export function slopePerMin(x: ArrayLike<number>, fs: number): number {
  const n = x.length;
  let st = 0, sx = 0;
  for (let i = 0; i < n; i++) { st += i / fs / 60; sx += x[i]; }
  const mt = st / n, mx = sx / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dt = i / fs / 60 - mt;
    num += dt * (x[i] - mx);
    den += dt * dt;
  }
  return den ? num / den : 0;
}

const SMOOTH = butterLow2(1.0, EDA_HZ);
const TONIC = butterLow2(0.05, EDA_HZ);

export interface EdaFeatures { eda_tonic: number; eda_slope: number; scr_count: number; scr_amp: number }

/** One window of EDA at 4 Hz; windowS scales scr_count to peaks per minute. */
export function edaFeatures(eda: ArrayLike<number>, windowS = eda.length / EDA_HZ): EdaFeatures {
  const x = filtfilt(SMOOTH, eda);
  const tonic = filtfilt(TONIC, x);
  const phasic = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) phasic[i] = x[i] - tonic[i];
  const { prominences } = findPeaks(phasic, SCR_MIN_AMP, EDA_HZ);
  let tsum = 0;
  for (const v of tonic) tsum += v;
  return {
    eda_tonic: tsum / tonic.length,
    eda_slope: slopePerMin(tonic, EDA_HZ),
    scr_count: (prominences.length * 60) / windowS,
    scr_amp: prominences.length ? prominences.reduce((a, b) => a + b, 0) / prominences.length : 0,
  };
}

export function tempFeatures(temp: ArrayLike<number>, fs = 4): { temp_mean: number; temp_slope: number } {
  let s = 0;
  for (let i = 0; i < temp.length; i++) s += temp[i];
  return { temp_mean: s / temp.length, temp_slope: slopePerMin(temp, fs) };
}

/** acc: x,y,z interleaved in E4 units (1/64 g). */
export function accFeatures(acc: ArrayLike<number>, unitsPerG = 64): { acc_std: number } {
  const n = Math.floor(acc.length / 3);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.hypot(acc[3 * i], acc[3 * i + 1], acc[3 * i + 2]) / unitsPerG;
    s += m; s2 += m * m;
  }
  const mu = s / n;
  return { acc_std: Math.sqrt(Math.max(0, s2 / n - mu * mu)) };
}
