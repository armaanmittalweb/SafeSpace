import { describe, expect, it } from 'vitest';
import type { Beat, StressSession } from '../../src/contract';
import { labelledRuns, restMeasurements, sessionPlan, sessionSeries, summaryNumbers, summaryText } from '../../src/session/summary';

const T0 = 1_780_000_000_000;

/** A synthetic 10-minute session: 70 bpm at rest, 88 in the challenge, then an exponential return (tau 40 s). */
function beats(opts: { rr?: boolean } = {}): Beat[] {
  const out: Beat[] = [];
  let t = T0;
  while (t < T0 + 600000) {
    const s = (t - T0) / 1000;
    const hr = s < 180 ? 70 : s < 420 ? 88 : 70 + 18 * Math.exp(-(s - 420) / 40);
    const rr = 60000 / (hr + 2 * Math.sin(s));
    t += rr;
    out.push({ t: Math.round(t), rr: opts.rr === false ? null : rr, hr: Math.round(hr) });
  }
  return out;
}
const phases: StressSession['phases'] = [
  { name: 'rest', startedAt: T0, endedAt: T0 + 180000, activities: [] },
  { name: 'challenge', startedAt: T0 + 180000, endedAt: T0 + 420000, activities: [] },
  { name: 'recovery', startedAt: T0 + 420000, endedAt: T0 + 600000, activities: [] },
];

describe('plan', () => {
  it('adds up to ten minutes with or without a probe', () => {
    for (const p of ['follow-dot', 'typing', null] as const) {
      const plan = sessionPlan(p);
      expect(plan.reduce((a, s) => a + s.durationS, 0)).toBe(600);
      expect(plan.filter((s) => s.phase === 'rest').reduce((a, s) => a + s.durationS, 0)).toBe(180);
      expect(plan.filter((s) => s.phase === 'challenge').reduce((a, s) => a + s.durationS, 0)).toBe(240);
    }
    expect(sessionPlan('follow-dot').map((s) => s.kind)).toEqual(['sit', 'follow-dot', 'stroop', 'follow-dot', 'beat-the-clock', 'paced-breathing']);
  });
});

describe('series and summary', () => {
  const b = beats();
  const series = sessionSeries(b, T0, 'ble-hr')!;

  it('bins heart rate every 5 s and RMSSD every 15 s', () => {
    expect(series.hr.length).toBeGreaterThanOrEqual(119);
    expect(series.hr[0][0]).toBe(2.5);
    expect(series.rmssd.length).toBeGreaterThan(30);
  });

  it('finds the rise and the recovery half-time', () => {
    const n = summaryNumbers({ phases, series });
    expect(n.restHr).toBeCloseTo(70, 0);
    expect(n.challengeHr).toBeCloseTo(88, 0);
    expect(n.hrRise).toBeCloseTo(18, 0);
    // exp(-t/40) = 1/2 at t = 27.7 s; the 15-s rolling mean and 5-s bins add a few seconds.
    expect(n.recoveryHalfTimeS).toBeGreaterThanOrEqual(25);
    expect(n.recoveryHalfTimeS).toBeLessThanOrEqual(42);
    const text = summaryText(n, { phases, aborted: false }, 'Polar H10');
    expect(text).toMatch(/rose 18 bpm during the challenge, from 70 at rest to 88/);
    expect(text).toMatch(/halfway back down \d+ seconds into paced breathing/);
  });

  it('says what it could not measure', () => {
    const n = summaryNumbers({ phases, series: null });
    expect(n.hrRise).toBeNull();
    expect(summaryText(n, { phases, aborted: false }, null)).toMatch(/No heart-rate device was connected/);
    expect(summaryText(n, { phases: phases.slice(0, 2), aborted: true }, null)).toMatch(/stopped during the challenge/);
  });

  it('compares the probe at rest and under challenge', () => {
    const run = (e: number) => ({ activity: 'follow-dot' as const, startedAt: 0, durationS: 30, completed: true, vsBaseline: null, metrics: { meanErrorPct: e, onTargetPct: 60, overCorrectionsPerMin: 8 } });
    const ph = phases.map((p) => ({ ...p, activities: p.name === 'rest' ? [run(4)] : p.name === 'challenge' ? [run(6)] : [] }));
    expect(summaryText(summaryNumbers({ phases: ph, series }), { phases: ph, aborted: false }, 'x')).toMatch(/distance off the dot 50% higher than at rest/);
    const rows = labelledRuns([{ id: 's', createdAt: 0, phases: ph, series: null, summary: { hrRise: null, recoveryHalfTimeS: null, text: '' }, aborted: false }]);
    expect(rows.map((r) => r.y)).toEqual([0, 1]);
  });
});

describe('rest measurements for the baseline', () => {
  it('cuts 60-s windows from the settled part of rest', () => {
    const ms = restMeasurements(beats(), { phases }, { source: 'ble-hr', device: 'Polar H10' });
    expect(ms.length).toBe(5); // 60..180 s at 15-s stride: starts 60, 75, 90, 105, 120
    expect(ms[0].features.hr_mean).toBeCloseTo(70, 0);
    expect(ms[0].features.rmssd).toBeGreaterThan(0);
    expect(ms.every((m) => m.durationS === 60 && m.beats === undefined)).toBe(true);
  });
  it('falls back to heart rate only without RR', () => {
    const ms = restMeasurements(beats({ rr: false }), { phases }, { source: 'ble-hr', device: null });
    expect(ms.length).toBe(5);
    expect(ms[0].features.rmssd).toBeUndefined();
  });
});
