// Empatica E4 session export (the zip from E4 connect: HR.csv, IBI.csv, EDA.csv, TEMP.csv,
// ACC.csv, BVP.csv, tags.csv). The E4 is the wristband the models were trained on (WESAD),
// so every model feature is computed, per window_s window (non-overlapping), with the
// training definitions (signal/eda.ts is a tested port of training/features.py):
//
//   hr_mean, rmssd, sdnn  from IBI.csv through signal/hrv.ts (coverage-gated as in training).
//                         Training detected beats in BVP itself; the E4's own IBI.csv is used
//                         here instead (same idea, the device's detector). If IBI coverage is
//                         too low, hr_mean falls back to the mean of HR.csv (1 Hz) in the window.
//   eda_*, scr_*          EDA.csv, 4 Hz
//   temp_*                TEMP.csv, 4 Hz
//   acc_std               ACC.csv, 32 Hz, 1/64 g units; motion flagged above 0.075 g (the WESAD
//                         resting median 0.027 + 3 x 0.016, models.json typical.rest.acc_std)
//
// CSV format: line 1 = session start (unix seconds, UTC), line 2 = sample rate (Hz), then
// samples. ACC has three columns. IBI.csv: line 1 = "start, IBI", then "offset_s, ibi_s".
// Quality per window: good with EDA, TEMP and valid HRV; fair with at least HR; poor otherwise
// (or when motion is flagged).
import type { Measurement } from '../contract';
import { accFeatures, edaFeatures, tempFeatures } from '../signal/eda';
import { beatFeatures, WINDOW_S } from '../signal/hrv';
import { baseName } from './stream';
import { fmtDay, plural, type ImportOptions, type ImportResult } from './types';

export const E4_MOTION_FLAG_G = 0.075;

export interface Channel { start: number; hz: number; cols: number; data: Float64Array }

/** Parses an E4 channel CSV (EDA, TEMP, HR, BVP, ACC). */
export function parseChannel(text: string): Channel | null {
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) return null;
  const head = lines[0].split(',').map(Number);
  const hz = Number(lines[1].split(',')[0]);
  if (!Number.isFinite(head[0]) || !Number.isFinite(hz) || hz <= 0) return null;
  const cols = head.length;
  const data = new Float64Array((lines.length - 2) * cols);
  let n = 0;
  for (let i = 2; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (cols === 1) { data[n++] = Number(l); continue; }
    const c = l.split(',');
    for (let j = 0; j < cols; j++) data[n++] = Number(c[j]);
  }
  return { start: head[0] * 1000, hz, cols, data: data.slice(0, n) };
}

/** Parses IBI.csv into absolute beat end times (ms) and intervals (ms). */
export function parseIbi(text: string): { t: number[]; rr: number[] } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const start = Number(lines[0].split(',')[0]) * 1000;
  if (!Number.isFinite(start)) return null;
  const t: number[] = [], rr: number[] = [];
  for (const l of lines.slice(1)) {
    const [o, v] = l.split(',').map(Number);
    if (Number.isFinite(o) && Number.isFinite(v)) { t.push(start + o * 1000); rr.push(v * 1000); }
  }
  return { t, rr };
}

function slice(ch: Channel, from: number, windowS: number): Float64Array | null {
  const i0 = Math.round(((from - ch.start) / 1000) * ch.hz);
  const len = Math.round(windowS * ch.hz);
  if (i0 < 0 || (i0 + len) * ch.cols > ch.data.length) return null;
  return ch.data.subarray(i0 * ch.cols, (i0 + len) * ch.cols);
}

export interface E4Files { EDA?: string; TEMP?: string; ACC?: string; HR?: string; IBI?: string }
export const E4_NAMES = ['EDA.csv', 'TEMP.csv', 'ACC.csv', 'HR.csv', 'IBI.csv'];

export function parseE4(files: E4Files, opts: ImportOptions & { device?: string } = {}): ImportResult {
  const eda = files.EDA ? parseChannel(files.EDA) : null;
  const temp = files.TEMP ? parseChannel(files.TEMP) : null;
  const acc = files.ACC ? parseChannel(files.ACC) : null;
  const hr = files.HR ? parseChannel(files.HR) : null;
  const ibi = files.IBI ? parseIbi(files.IBI) : null;
  const chans = [eda, temp, acc, hr].filter((c): c is Channel => !!c);
  if (!chans.length && !ibi?.t.length) {
    throw new Error('No Empatica E4 files were found. Use the session zip from E4 connect (it contains EDA.csv, TEMP.csv, IBI.csv and others).');
  }
  const starts = chans.map((c) => c.start);
  const ends = chans.map((c) => c.start + (c.data.length / c.cols / c.hz) * 1000);
  if (ibi?.t.length) { starts.push(ibi.t[0] - ibi.rr[0]); ends.push(ibi.t[ibi.t.length - 1]); }
  const t0 = Math.min(...starts);
  const t1 = Math.max(...ends);
  const w = WINDOW_S * 1000;
  const device = opts.device ?? 'Empatica E4';
  const out: Measurement[] = [];
  let lo = 0;
  for (let s = t0; s + w <= t1 + 1; s += w) {
    const features: Measurement['features'] = {};
    let hrvOk = false;
    if (ibi) {
      while (lo < ibi.t.length && ibi.t[lo] < s) lo++;
      const rr: number[] = [];
      for (let i = lo; i < ibi.t.length && ibi.t[i] < s + w; i++) rr.push(ibi.rr[i]);
      const f = beatFeatures(rr, WINDOW_S);
      if (f.hrValid) features.hr_mean = f.hr_mean!;
      if (f.hrvValid) { features.rmssd = f.rmssd!; features.sdnn = f.sdnn!; hrvOk = true; }
    }
    if (features.hr_mean == null && hr) {
      const x = slice(hr, s, WINDOW_S);
      if (x && x.length >= WINDOW_S * 0.4) features.hr_mean = x.reduce((a, b) => a + b, 0) / x.length;
    }
    const e = eda && slice(eda, s, WINDOW_S);
    if (e && e.length > 9) Object.assign(features, edaFeatures(e, WINDOW_S));
    const tp = temp && slice(temp, s, WINDOW_S);
    if (tp && tp.length > 1) Object.assign(features, tempFeatures(tp, temp!.hz));
    const a = acc && slice(acc, s, WINDOW_S);
    let motion: Measurement['motion'];
    if (a && a.length >= 6) {
      const { acc_std } = accFeatures(a);
      features.acc_std = acc_std;
      motion = { flagged: acc_std > E4_MOTION_FLAG_G, accStd: acc_std };
    }
    if (!Object.keys(features).length) continue;
    const quality: Measurement['quality'] = motion?.flagged ? 'poor'
      : features.eda_tonic != null && features.temp_mean != null && hrvOk ? 'good'
      : features.hr_mean != null ? 'fair' : 'poor';
    const m: Measurement = { source: 'import-e4', device, startedAt: Math.round(s), durationS: WINDOW_S, quality, features };
    if (motion) m.motion = motion;
    out.push(m);
  }
  const max = opts.maxMeasurements ?? 20000;
  const kept = out.length > max ? out.slice(out.length - max) : out;
  const have = [
    eda && 'skin conductance', temp && 'skin temperature', (ibi?.t.length || hr) && 'heart rate', ibi?.t.length && 'HRV', acc && 'motion',
  ].filter(Boolean) as string[];
  const flagged = kept.filter((m) => m.motion?.flagged).length;
  let summary = `Empatica E4: ${plural(kept.length, 'one-minute window')} from ${fmtDay(t0)}, ${Math.round((t1 - t0) / 60000)} minutes recorded. Signals: ${have.join(', ')}.`;
  if (flagged) summary += ` ${plural(flagged, 'window')} had a lot of movement and ${flagged === 1 ? 'is' : 'are'} marked poor.`;
  return { measurements: kept, summary };
}

/** Which E4 channel a zip entry is, by file name. */
export function e4Channel(path: string): keyof E4Files | null {
  const n = baseName(path);
  const i = E4_NAMES.indexOf(n);
  return i < 0 ? null : (n.slice(0, -4) as keyof E4Files);
}
