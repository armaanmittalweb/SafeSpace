// Template narration: a summary and a coping tip, plus one line per signal. Built only
// from the scores and the values behind them, so it is always available offline.
import type { Calibration } from '../model/calibrate';
import { MODELS, SIGNALS, type Channel, type Feature, type Fused, type ReadingSet, type Signal } from '../model/score';
import { fmt, fmtSigned } from '../ui/format';

export interface Moment {
  readings: ReadingSet;
  fused: Fused | null;
  raw: Record<Channel, number>;
  cal: Calibration;
  motion: boolean;
  included: Record<Signal, boolean>;
}
export interface Narration {
  summary: string;
  tip: string;
  lines: { signal: Signal; text: string }[];
  caveat: string | null;
}

export const SIGNAL_NAME: Record<Signal, string> = {
  hr: 'Heart rate',
  hrv: 'Heart-rate variability',
  eda: 'Skin conductance',
  temp: 'Skin temperature',
};

export type Level = 'high' | 'raised' | 'mixed' | 'settled';
export function levelOf(score: number): Level {
  if (score >= 0.4) return 'high';
  if (score >= 0.1) return 'raised';
  if (score > -0.25) return 'mixed';
  return 'settled';
}
export const LEVEL_WORD: Record<Level, string> = { high: 'stressed', raised: 'raised', mixed: 'borderline', settled: 'calm' };

const lean = (score: number) =>
  score >= 0.6 ? 'a strong push towards stress'
  : score >= 0.2 ? 'a push towards stress'
  : score > -0.2 ? 'close to neutral'
  : 'reads as calm';

const d = (m: Moment, f: Feature) => m.raw[f] - m.cal.mean[f];

function describe(s: Signal, m: Moment): string {
  const r = m.readings[s];
  if (!r) {
    return s === 'hrv' || s === 'hr'
      ? `${SIGNAL_NAME[s]}: too few clean beats in this window, so the pen is lifted.`
      : `${SIGNAL_NAME[s]}: no reading in this window.`;
  }
  const weak = MODELS.signals[s].strength === 'weak' ? ' (weak signal)' : '';
  switch (s) {
    case 'hr': {
      const dv = d(m, 'hr_mean');
      const rel = Math.abs(dv) < 1.5 ? 'about your resting level' : `${fmt(Math.abs(dv), 0)} ${dv > 0 ? 'above' : 'below'} rest`;
      return `Heart rate ${fmt(m.raw.hr_mean, 0)} bpm, ${rel}: ${lean(r.score)}.`;
    }
    case 'eda': {
      const dv = d(m, 'eda_tonic');
      const lvl = Math.abs(dv) < 0.1 ? 'near its resting level' : `${fmtSigned(dv, 2)} µS from rest`;
      const n = Math.round(m.raw.scr_count);
      return `Skin conductance ${lvl}, ${n} response${n === 1 ? '' : 's'} a minute: ${lean(r.score)}.`;
    }
    case 'temp': {
      const sl = m.raw.temp_slope;
      const trend = Math.abs(sl) < 0.02 ? 'steady' : sl < 0 ? 'cooling' : 'warming';
      return `Hand temperature ${trend} (${fmtSigned(sl, 2)} °C/min): ${lean(r.score)}${weak}.`;
    }
    case 'hrv': {
      return `RMSSD ${fmt(m.raw.rmssd, 0)} ms against ${fmt(m.cal.mean.rmssd, 0)} at rest: ${lean(r.score)}${weak}.`;
    }
  }
}

/** The included signal whose logit pulls hardest in the direction of the fused score. */
function leader(m: Moment): Signal | null {
  if (!m.fused) return null;
  const dir = Math.sign(m.fused.logit) || 1;
  let best: Signal | null = null;
  let bestV = -Infinity;
  for (const s of SIGNALS) {
    const r = m.readings[s];
    if (!r || !m.included[s]) continue;
    const v = dir * r.logit;
    if (v > bestV) { bestV = v; best = s; }
  }
  return best;
}

const LEAD_CLAUSE: Record<Signal, (m: Moment, up: boolean) => string> = {
  hr: (m, up) => up ? `heart rate ${fmt(Math.max(0, d(m, 'hr_mean')), 0)} bpm above your resting level` : 'a heart rate close to rest',
  eda: (_m, up) => up ? 'skin conductance rising with frequent sweat responses' : 'quiet skin conductance',
  temp: (_m, up) => up ? 'cooling hands' : 'steady hand temperature',
  hrv: (_m, up) => up ? 'lower heart-rate variability' : 'heart-rate variability near rest',
};

/** The summary sentence and per-signal lines (pipeline stage 4, "Narration"). */
export function summarize(m: Moment): Omit<Narration, 'tip'> {
  const lines = SIGNALS.filter((s) => m.included[s]).map((s) => ({ signal: s, text: describe(s, m) }));
  const caveat = m.motion && m.included.hr
    ? 'Your wrist is moving a lot. Heart rate rises with movement too, so a high reading here may be exercise, not stress.'
    : null;
  if (!m.fused) return { summary: 'Every pen is lifted or has no reading, so there is nothing to fuse.', lines, caveat };
  const lead = levelOf(m.fused.score) === 'mixed' ? null : leader(m);
  const by = lead ? `, led by ${LEAD_CLAUSE[lead](m, m.fused.logit > 0)}` : '';
  const summary = {
    high: `Your readings point to high stress${by}.`,
    raised: `Your readings are somewhat raised${by}.`,
    mixed: `Your readings are mixed, close to the line between calm and stressed${by}.`,
    settled: `Your readings look settled${by}.`,
  }[levelOf(m.fused.score)];
  return { summary, lines, caveat };
}

/** The coping tip (pipeline stage 5). */
export function copingTip(m: Moment): string {
  if (!m.fused) return 'Put at least one pen back down to get a reading.';
  const level = levelOf(m.fused.score);
  const lead = leader(m);
  const up = m.fused.logit > 0;
  if (m.motion && lead === 'hr' && up) {
    return 'If you have just been walking or moving about, sit for a few minutes before trusting a high reading.';
  }
  if (level === 'high') {
    if (lead === 'eda') return 'Pause for a moment and name what is making you tense; putting it into words often takes the edge off.';
    if (lead === 'temp') return 'Warm your hands and loosen your shoulders; cold hands often come with tension.';
    return 'Try slow breathing for two minutes: in for four counts, out for six. A longer exhale slows the heart.';
  }
  if (level === 'raised') {
    return lead === 'eda'
      ? 'Pause for a moment and name what is making you tense; putting it into words often takes the edge off.'
      : 'Take a short break: stand up, look out of a window, and let your breathing slow down.';
  }
  if (level === 'mixed') return 'Nothing urgent. Check in with yourself: a glass of water and a stretch are cheap insurance.';
  return 'Nothing to fix right now. This is a good moment to start something that needs focus.';
}

export function narrate(m: Moment): Narration {
  return { ...summarize(m), tip: copingTip(m) };
}
