// The contract's scoring rules, on top of the unchanged model code (model/score.ts, model/calibrate.ts):
// z-score each feature against the user's own Baseline, readSignal per measured signal, fuse the
// signals actually measured. No score before a baseline; camera HRV only at quality 'good'.
import type { Baseline, CheckIn, Measurement } from '../contract/records';
import { calibrate, zScores, type Calibration } from '../model/calibrate';
import { CHANNELS, fuse, MODELS, readSignal, SIGNALS, type Channel, type Feature, type Signal } from '../model/score';

export const BASELINE_NEEDED = 3;
export const SIGNAL_FEATURES: Record<Signal, Feature[]> = Object.fromEntries(
  SIGNALS.map((s) => [s, MODELS.signals[s].features.map((f) => f.name)]),
) as Record<Signal, Feature[]>;

const has = (m: Measurement, fs: Feature[]) => fs.every((f) => Number.isFinite(m.features[f]));

/** Whether a reading's HRV may be used at all (the contract: a camera only at 'good'). */
export const hrvTrusted = (m: Measurement) => has(m, SIGNAL_FEATURES.hrv) && (m.source !== 'camera' || m.quality === 'good');

export interface NotMeasured { signal: Signal; reason: string }

/** Which signals a reading can be scored on, and a plain reason for each one it cannot. */
export function signalsIn(m: Measurement | null, b: Baseline | null = null): { used: Signal[]; notUsed: NotMeasured[] } {
  const used: Signal[] = [];
  const notUsed: NotMeasured[] = [];
  const wearable = 'It needs a wearable that measures it, such as an Empatica E4.';
  for (const s of SIGNALS) {
    if (!m) { notUsed.push({ signal: s, reason: 'No measurement in this check-in.' }); continue; }
    if (!has(m, SIGNAL_FEATURES[s])) {
      notUsed.push({
        signal: s,
        reason: s === 'eda' || s === 'temp' ? wearable
          : s === 'hr' ? 'Too few clean beats to read a heart rate.'
          : m.source === 'manual' ? 'Nothing was measured.'
          : 'Too few clean beats in a row to read it.',
      });
      continue;
    }
    if (s === 'hrv' && !hrvTrusted(m)) {
      notUsed.push({ signal: s, reason: `Needs a good signal; the camera's was ${m.quality}. Heart rate still counts.` });
      continue;
    }
    if (b && baselineReady(b) && !baselineHas(b, s)) {
      notUsed.push({ signal: s, reason: 'Your baseline has no resting reading of it yet.' });
      continue;
    }
    used.push(s);
  }
  return { used, notUsed };
}

function channelsOf(m: Measurement, withHrv: boolean): Record<Channel, number> {
  const out = {} as Record<Channel, number>;
  for (const c of CHANNELS) {
    const v = m.features[c];
    out[c] = Number.isFinite(v) && (withHrv || !SIGNAL_FEATURES.hrv.includes(c as Feature)) ? (v as number) : NaN;
  }
  return out;
}

const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/** A Baseline from resting readings; n counts distinct days (contract amendment). */
export function baselineFrom(readings: Measurement[], id: string, createdAt: number): Baseline {
  const cal = calibrate(readings.map((r) => channelsOf(r, hrvTrusted(r))));
  const days = new Set(readings.map((r) => dayKey(r.startedAt))).size;
  return { id, createdAt, readings, calibration: { mean: cal.mean, sd: cal.sd, n: days } };
}
/** A Baseline from one stress session's rest phase: n counts its 60-s rest windows (contract amendment). */
export function baselineFromRest(readings: Measurement[], id: string, createdAt: number): Baseline {
  const b = baselineFrom(readings, id, createdAt);
  return { ...b, calibration: { ...b.calibration, n: readings.length } };
}
export const baselineReady = (b: Baseline | null | undefined): boolean => !!b && b.calibration.n >= BASELINE_NEEDED;
export const baselineHasToday = (b: Baseline | null | undefined, now = Date.now()) => !!b && b.readings.some((r) => dayKey(r.startedAt) === dayKey(now));

/** At least two resting readings carry the signal, so its resting mean means something. */
export function baselineHas(b: Baseline, s: Signal): boolean {
  const ok = b.readings.filter((r) => (s === 'hrv' ? hrvTrusted(r) : has(r, SIGNAL_FEATURES[s])));
  return ok.length >= Math.min(2, b.readings.length) && ok.length > 0;
}

export function restingOf(b: Baseline | null | undefined, f: Feature): number | null {
  if (!b) return null;
  const vals = b.readings.map((r) => r.features[f]).filter((v): v is number => Number.isFinite(v));
  if (!vals.length) return null;
  return f === 'hr_mean' || f === 'rmssd' || f === 'sdnn' ? b.calibration.mean[f] : vals.reduce((a, x) => a + x, 0) / vals.length;
}

export function scoreMeasurement(m: Measurement | null, b: Baseline | null): CheckIn['score'] {
  if (!m || !b || !baselineReady(b)) return null;
  const { used } = signalsIn(m, b);
  if (!used.length) return { fused: null, bySignal: {}, baselineId: b.id };
  const z = zScores(channelsOf(m, used.includes('hrv')), b.calibration as unknown as Calibration);
  const bySignal: NonNullable<CheckIn['score']>['bySignal'] = {};
  const logits: number[] = [];
  for (const s of used) {
    const r = readSignal(s, z);
    bySignal[s] = { score: r.score, contributions: r.contributions };
    logits.push(r.logit);
  }
  const f = fuse(logits);
  return { fused: f ? f.score : null, bySignal, baselineId: b.id };
}

// ---- words ----

export type Level = 'stressed' | 'raised' | 'borderline' | 'calm';
export function levelOf(score: number): Level {
  if (score >= 0.4) return 'stressed';
  if (score >= 0.1) return 'raised';
  if (score > -0.25) return 'borderline';
  return 'calm';
}
export const LEVEL_TEXT: Record<Level, string> = { stressed: 'Stressed', raised: 'Somewhat raised', borderline: 'Borderline', calm: 'Calm' };
export const tone = (score: number | null | undefined) => (score == null ? '' : score >= 0.1 ? 'stress' : score <= -0.25 ? 'calm' : '');

export const FEELINGS = ['Very calm', 'Calm', 'Neutral', 'Tense', 'Very tense'] as const;
export const feelingWord = (f: number | null) => (f ? FEELINGS[f - 1] : null);

export const SIGNAL_LABEL: Record<Signal, string> = { hr: 'Heart rate', hrv: 'Heart-rate variability', eda: 'Skin conductance', temp: 'Skin temperature' };
export const SIGNAL_SHORT: Record<Signal, string> = { hr: 'Heart rate', hrv: 'HRV (RMSSD)', eda: 'Skin conductance', temp: 'Skin temperature' };

const r0 = (x: number) => Math.round(x);
/** "88 bpm" and "14 above your resting 74". */
export function describeSignal(s: Signal, m: Measurement, b: Baseline | null): { value: string; vsRest: string | null } {
  const f = m.features;
  switch (s) {
    case 'hr': {
      const v = f.hr_mean!, rest = restingOf(b, 'hr_mean');
      if (rest == null) return { value: `${r0(v)} bpm`, vsRest: null };
      const d = v - rest;
      return { value: `${r0(v)} bpm`, vsRest: Math.abs(d) < 2 ? `About your resting ${r0(rest)}` : `${r0(Math.abs(d))} ${d > 0 ? 'above' : 'below'} your resting ${r0(rest)}` };
    }
    case 'hrv': {
      const v = f.rmssd!, rest = restingOf(b, 'rmssd');
      if (rest == null) return { value: `${r0(v)} ms`, vsRest: null };
      const d = v - rest;
      return { value: `${r0(v)} ms`, vsRest: Math.abs(d) < 3 ? `About your resting ${r0(rest)}` : `${r0(Math.abs(d))} ${d > 0 ? 'above' : 'below'} your resting ${r0(rest)}` };
    }
    case 'eda': return { value: `${(f.eda_tonic ?? 0).toFixed(2)} µS`, vsRest: `${r0(f.scr_count ?? 0)} responses a minute` };
    case 'temp': return { value: `${(f.temp_mean ?? 0).toFixed(1)} °C`, vsRest: `${(f.temp_slope ?? 0) >= 0 ? 'Warming' : 'Cooling'} ${Math.abs(f.temp_slope ?? 0).toFixed(2)} °C a minute` };
  }
}
export const isWeak = (s: Signal) => MODELS.signals[s].strength === 'weak';
