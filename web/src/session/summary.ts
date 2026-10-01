// Pure parts of the stress session: the plan, the heart-rate series, the summary numbers
// and text, the rest-phase Measurements for the baseline, and the calm/stressed labels the
// personal model trains on.
import type { ActivityId, ActivityResult, Beat, InputSource, Measurement, StressSession } from '../contract';
import { HEADLINE } from '../activities/labels';
import { beatFeatures, measurementFromHr, measurementFromRR, windowBeats } from '../signal/hrv';

export type PhaseName = 'rest' | 'challenge' | 'recovery';
export interface Step { phase: PhaseName; kind: 'sit' | ActivityId; durationS: number }

/** Probe: the same short activity done at the end of rest and in the middle of the challenge. */
export type Probe = 'follow-dot' | 'typing' | null;

export const SESSION_MINUTES = 10;

/**
 * Rest 3 min (sit, then the probe), challenge 4 min (colour words, probe, beat the clock),
 * recovery 3 min (paced breathing). Without a probe the sit and challenge steps take its time.
 */
export function sessionPlan(probe: Probe, scale = 1): Step[] {
  const s = (x: number) => Math.round(x * scale);
  const p = probe ? 30 : 0;
  const plan: Step[] = [
    { phase: 'rest', kind: 'sit', durationS: s(180 - p) },
    ...(probe ? [{ phase: 'rest' as const, kind: probe, durationS: s(30) }] : []),
    { phase: 'challenge', kind: 'stroop', durationS: s(120 - p / 2) },
    ...(probe ? [{ phase: 'challenge' as const, kind: probe, durationS: s(30) }] : []),
    { phase: 'challenge', kind: 'beat-the-clock', durationS: s(120 - p / 2) },
    { phase: 'recovery', kind: 'paced-breathing', durationS: s(180) },
  ];
  return plan;
}

const inst = (b: Beat) => (b.rr ? 60000 / b.rr : b.hr);

/** HR in 5-s bins and RMSSD over trailing 60-s windows every 15 s; t in seconds from start. */
export function sessionSeries(beats: readonly Beat[], startedAt: number, source: InputSource): StressSession['series'] {
  if (beats.length < 5) return null;
  const hr: [number, number][] = [];
  const bins = new Map<number, number[]>();
  for (const b of beats) {
    const v = inst(b);
    if (!(v > 30 && v < 220) || b.t < startedAt) continue;
    const k = Math.floor((b.t - startedAt) / 5000);
    const a = bins.get(k);
    if (a) a.push(v); else bins.set(k, [v]);
  }
  for (const [k, v] of [...bins].sort((a, b) => a[0] - b[0])) hr.push([k * 5 + 2.5, Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10]);
  const rmssd: [number, number][] = [];
  const rrBeats = beats.filter((b) => b.rr != null && b.t >= startedAt);
  if (rrBeats.length > 30) {
    const wins = windowBeats(rrBeats.map((b) => b.t), rrBeats.map((b) => b.rr as number), { windowS: 60, strideS: 15, from: startedAt, to: rrBeats[rrBeats.length - 1].t });
    for (const w of wins) {
      const f = beatFeatures(w.rr, 60);
      if (f.rmssd != null) rmssd.push([Math.round((w.end - startedAt) / 1000), Math.round(f.rmssd * 10) / 10]);
    }
  }
  return { source, hr, rmssd };
}

const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export interface SummaryNumbers { restHr: number | null; challengeHr: number | null; hrRise: number | null; recoveryHalfTimeS: number | null; recoveryEndHr: number | null }

/**
 * restHr: mean HR over the last 2 minutes of rest (the first minute is for settling).
 * challengeHr: mean over the challenge. hrRise = challengeHr - restHr.
 * Recovery half-time: seconds into recovery until the 15-s rolling mean HR first falls to
 * restHr + rise / 2. Null when the rise is under 3 bpm or it never gets there.
 */
export function summaryNumbers(s: Pick<StressSession, 'phases' | 'series'>): SummaryNumbers {
  const out: SummaryNumbers = { restHr: null, challengeHr: null, hrRise: null, recoveryHalfTimeS: null, recoveryEndHr: null };
  if (!s.series || !s.phases.length) return out;
  const t0 = s.phases[0].startedAt;
  const sec = (t: number) => (t - t0) / 1000;
  const ph = (n: PhaseName) => s.phases.find((p) => p.name === n);
  const inRange = (a: number, b: number) => s.series!.hr.filter(([t]) => t >= a && t < b).map(([, v]) => v);
  const rest = ph('rest'), ch = ph('challenge'), rec = ph('recovery');
  if (rest) {
    const a = Math.max(sec(rest.startedAt), sec(rest.endedAt) - 120);
    const v = inRange(a, sec(rest.endedAt));
    if (v.length) out.restHr = Math.round(meanOf(v) * 10) / 10;
  }
  if (ch) {
    const v = inRange(sec(ch.startedAt), sec(ch.endedAt));
    if (v.length) out.challengeHr = Math.round(meanOf(v) * 10) / 10;
  }
  if (out.restHr != null && out.challengeHr != null) out.hrRise = Math.round((out.challengeHr - out.restHr) * 10) / 10;
  if (rec) {
    const r0 = sec(rec.startedAt), r1 = sec(rec.endedAt);
    const pts = s.series.hr.filter(([t]) => t >= r0 - 10 && t < r1);
    const endV = inRange(r1 - 60, r1);
    if (endV.length) out.recoveryEndHr = Math.round(meanOf(endV) * 10) / 10;
    if (out.hrRise != null && out.hrRise >= 3 && out.restHr != null) {
      const target = out.restHr + out.hrRise / 2;
      for (const [t] of pts) {
        if (t < r0) continue;
        const roll = pts.filter(([u]) => u > t - 15 && u <= t).map(([, v]) => v);
        if (meanOf(roll) <= target) { out.recoveryHalfTimeS = Math.round(t - r0); break; }
      }
    }
  }
  return out;
}

function probeSentence(phases: StressSession['phases']): string | null {
  const find = (n: PhaseName) => phases.find((p) => p.name === n)?.activities.find((a) => a.activity === 'follow-dot' || a.activity === 'typing');
  const a = find('rest'), b = find('challenge');
  if (!a || !b || a.activity !== b.activity) return null;
  const labels = HEADLINE[a.activity];
  const diffs = labels.map((l) => {
    const x = a.metrics[l.key], y = b.metrics[l.key];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0) return null;
    return { l, rel: (y - x) / Math.abs(x) };
  }).filter((d): d is { l: (typeof labels)[number]; rel: number } => !!d && Math.abs(d.rel) >= 0.1).sort((p, q) => Math.abs(q.rel) - Math.abs(p.rel));
  const what = a.activity === 'typing' ? 'typing' : 'tracking';
  if (!diffs.length) return `Your ${what} was about the same under challenge as at rest.`;
  const parts = diffs.slice(0, 2).map((d) => `${d.l.label.toLowerCase()} ${Math.round(Math.abs(d.rel) * 100)}% ${d.rel > 0 ? 'higher' : 'lower'}`);
  return `Under challenge, your ${what} changed: ${parts.join(', ')} than at rest.`;
}

export function summaryText(n: SummaryNumbers, s: Pick<StressSession, 'phases' | 'aborted'>, device: string | null): string {
  const out: string[] = [];
  if (n.hrRise != null && n.restHr != null && n.challengeHr != null) {
    if (n.hrRise >= 3) out.push(`Your heart rate rose ${Math.round(n.hrRise)} bpm during the challenge, from ${Math.round(n.restHr)} at rest to ${Math.round(n.challengeHr)}.`);
    else if (n.hrRise <= -3) out.push(`Your heart rate was ${Math.round(-n.hrRise)} bpm lower during the challenge than at rest (${Math.round(n.challengeHr)} against ${Math.round(n.restHr)}).`);
    else out.push(`Your heart rate barely changed during the challenge (${Math.round(n.restHr)} at rest, ${Math.round(n.challengeHr)} during).`);
    if (n.recoveryHalfTimeS != null) out.push(`It came halfway back down ${n.recoveryHalfTimeS} seconds into paced breathing.`);
    else if (n.hrRise >= 3 && n.recoveryEndHr != null) out.push(`By the end of paced breathing it was ${Math.round(n.recoveryEndHr)}, ${n.recoveryEndHr - n.restHr > 3 ? 'still above' : 'back near'} your resting level.`);
  } else if (!device) {
    out.push('No heart-rate device was connected, so only the activities were measured.');
  } else {
    out.push(`Too few beats came through from ${device} to compare the phases.`);
  }
  const probe = probeSentence(s.phases);
  if (probe) out.push(probe);
  if (s.aborted) {
    const last = s.phases[s.phases.length - 1]?.name;
    out.push(`You stopped during the ${last ?? 'session'}. That is fine; the parts you did are kept.`);
  }
  return out.join(' ');
}

/** 60-s windows (15-s stride) from the rest phase, for the physiological baseline. */
export function restMeasurements(beats: readonly Beat[], s: Pick<StressSession, 'phases'>, meta: { source: InputSource; device: string | null; keepBeats?: boolean }): Measurement[] {
  const rest = s.phases.find((p) => p.name === 'rest');
  if (!rest) return [];
  // Skip the first minute: people settle after sitting down.
  const from = rest.startedAt + 60000, to = rest.endedAt;
  const b = beats.filter((x) => x.t >= from && x.t < to);
  const rr = b.filter((x) => x.rr != null);
  if (rr.length >= 30) {
    return windowBeats(rr.map((x) => x.t), rr.map((x) => x.rr as number), { windowS: 60, strideS: 15, from, to })
      .map((w) => measurementFromRR(w.rr, { ...meta, startedAt: w.start, durationS: 60 }))
      .filter((m) => m.features.hr_mean != null);
  }
  const out: Measurement[] = [];
  for (let t = from; t + 60000 <= to; t += 15000) {
    const w = b.filter((x) => x.t >= t && x.t < t + 60000).map((x) => x.hr);
    if (w.length >= 20) out.push(measurementFromHr(w, { source: meta.source, device: meta.device, startedAt: t, durationS: 60 }));
  }
  return out;
}

/** Labelled rows for the personal model: rest activities are calm (0), challenge ones stressed (1). */
export interface LabelledRun { sessionId: string; activity: ActivityId; y: 0 | 1; metrics: Record<string, number> }
export function labelledRuns(sessions: readonly StressSession[], activity?: ActivityId): LabelledRun[] {
  const out: LabelledRun[] = [];
  for (const s of sessions) {
    for (const p of s.phases) {
      if (p.name === 'recovery') continue;
      for (const a of p.activities as ActivityResult[]) {
        if (activity && a.activity !== activity) continue;
        if (!a.completed) continue;
        out.push({ sessionId: s.id, activity: a.activity, y: p.name === 'challenge' ? 1 : 0, metrics: a.metrics });
      }
    }
  }
  return out;
}
