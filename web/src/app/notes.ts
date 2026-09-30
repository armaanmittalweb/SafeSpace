// The written note under a result: the existing template narration (narrate/templates.ts) built from
// the same numbers as the score, plus one sentence about how the person said they feel. The optional
// LLM note gets only NarrationFacts (numbers, labels, the user's tags), never raw data.
import type { Baseline, CheckIn, NarrationFacts, Signal } from '../contract/records';
import type { Calibration } from '../model/calibrate';
import { CHANNELS, fuse, readSignal, SIGNALS, type Channel, type ReadingSet } from '../model/score';
import { narrate } from '../narrate/templates';
import { baselineReady, BASELINE_NEEDED, feelingWord, restingOf, signalsIn, tone } from './scoring';

export function feelingSentence(c: Pick<CheckIn, 'feeling' | 'score'>): string | null {
  const w = feelingWord(c.feeling);
  if (!w) return null;
  const fused = c.score?.fused;
  if (fused == null) return `You said you feel ${w.toLowerCase()}.`;
  const felt = c.feeling! <= 2 ? -1 : c.feeling! >= 4 ? 1 : 0;
  const read = tone(fused) === 'stress' ? 1 : tone(fused) === 'calm' ? -1 : 0;
  if (felt !== 0 && felt === read) return `You said you feel ${w.toLowerCase()}, which matches.`;
  if (felt !== 0 && read !== 0) return `You said you feel ${w.toLowerCase()}, but your body reads the other way. Worth noticing, not a verdict.`;
  return `You said you feel ${w.toLowerCase()}.`;
}

export function templateNote(c: CheckIn, b: Baseline | null, baselineCount: number): string {
  const m = c.measurement;
  const feel = feelingSentence(c);
  const tag = c.tags.length ? ` You tagged it "${c.tags.join('", "')}".` : '';
  if (!m) return [feel ?? 'A check-in with no measurement.', tag.trim()].filter(Boolean).join(' ');
  if (!b || !baselineReady(b) || !c.score) {
    const hr = m.features.hr_mean;
    const left = Math.max(0, BASELINE_NEEDED - baselineCount);
    const first = hr != null ? `Heart rate ${Math.round(hr)} bpm.` : 'No clear heart rate in this reading.';
    const why = left > 0
      ? ` Scores start once your baseline has ${BASELINE_NEEDED} resting readings on different days; ${left} to go.`
      : '';
    return `${first}${why}${feel ? ' ' + feel : ''}${tag}`;
  }
  const { used } = signalsIn(m, b);
  const raw = {} as Record<Channel, number>;
  for (const ch of CHANNELS) raw[ch] = Number.isFinite(m.features[ch]) ? (m.features[ch] as number) : NaN;
  const cal = b.calibration as unknown as Calibration;
  const z = {} as Record<Channel, number>;
  for (const ch of CHANNELS) z[ch] = (raw[ch] - cal.mean[ch]) / cal.sd[ch];
  const readings = {} as ReadingSet;
  const included = {} as Record<Signal, boolean>;
  for (const s of SIGNALS) { readings[s] = used.includes(s) ? readSignal(s, z) : null; included[s] = used.includes(s); }
  const fused = fuse(used.map((s) => readings[s]!.logit));
  const n = narrate({ readings, fused, raw, cal, motion: !!m.motion?.flagged, included });
  return [n.summary, feel, tag.trim(), n.caveat, n.tip].filter(Boolean).join(' ');
}

export function factsOf(c: CheckIn, b: Baseline | null): NarrationFacts {
  const bySignal: NarrationFacts['bySignal'] = {};
  for (const [s, v] of Object.entries(c.score?.bySignal ?? {})) bySignal[s as Signal] = Math.round(v!.score * 100) / 100;
  const hr = c.measurement?.features.hr_mean;
  const rm = c.measurement?.features.rmssd;
  const rest = restingOf(b, 'hr_mean');
  return {
    fused: c.score?.fused == null ? null : Math.round(c.score.fused * 100) / 100,
    bySignal,
    hr: hr == null ? null : Math.round(hr),
    restingHr: rest == null ? null : Math.round(rest),
    rmssd: rm == null || !bySignal.hrv ? null : Math.round(rm),
    feeling: c.feeling,
    tags: c.tags.slice(0, 5),
    activities: [],
  };
}
