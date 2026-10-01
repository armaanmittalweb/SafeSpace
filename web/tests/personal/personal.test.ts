import { describe, expect, it } from 'vitest';
import type { ActivityResult, StressSession } from '../../src/contract';
import { rng } from '../../src/activities/stats';
import { balancedAccuracy, fitLogistic, predictFit, trainFromRuns } from '../../src/personal/model';
import { scoreWith, train } from '../../src/personal';
import type { LabelledRun } from '../../src/session/summary';

const r = rng(42);
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += r(); return s - 3; };

function run(y: 0 | 1, shift: number): ActivityResult {
  return {
    activity: 'follow-dot', startedAt: 0, durationS: 30, completed: true, vsBaseline: null,
    metrics: { meanErrorPct: 4 + shift * y + 0.6 * gauss(), jerk: 120 + 25 * shift * y + 12 * gauss(), overCorrectionsPerMin: 6 + 2 * shift * y + gauss() },
  };
}
function session(i: number, shift: number): StressSession {
  const t = i * 1e6;
  return {
    id: `s${i}`, createdAt: t, aborted: false, series: null, summary: { hrRise: null, recoveryHalfTimeS: null, text: '' },
    phases: [
      { name: 'rest', startedAt: t, endedAt: t + 180000, activities: [run(0, shift), run(0, shift)] },
      { name: 'challenge', startedAt: t + 180000, endedAt: t + 420000, activities: [run(1, shift), run(1, shift), { ...run(1, shift), activity: 'stroop' }] },
      { name: 'recovery', startedAt: t + 420000, endedAt: t + 600000, activities: [{ ...run(0, shift), activity: 'paced-breathing' }] },
    ],
  };
}

describe('logistic regression', () => {
  it('separates separable data and standardises internally', () => {
    const X: number[][] = [], y: number[] = [];
    for (let i = 0; i < 40; i++) { const c = i % 2; X.push([1000 + 400 * c + 50 * gauss(), 0.1 * gauss()]); y.push(c); }
    const f = fitLogistic(X, y);
    const p = X.map((x) => predictFit(f, x));
    expect(balancedAccuracy(y, p)).toBe(1);
    expect(f.w[0]).toBeGreaterThan(1); // the informative feature carries the weight
    expect(Math.abs(f.w[1])).toBeLessThan(0.5);
  });

  it('stays finite on perfectly separable data thanks to L2', () => {
    const f = fitLogistic([[0], [1], [2], [3]], [0, 0, 1, 1]);
    expect(Number.isFinite(f.w[0])).toBe(true);
    expect(f.w[0]).toBeLessThan(10);
  });
});

describe('personal model', () => {
  it('is ready with separable sessions and scores new runs sensibly', () => {
    const sessions = Array.from({ length: 4 }, (_, i) => session(i, 3));
    const m = train('follow-dot', sessions)!;
    expect(m.features).toEqual(['meanErrorPct', 'jerk', 'overCorrectionsPerMin']);
    expect(m.heldOut.n).toBe(16);
    expect(m.heldOut.balancedAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(m.ready).toBe(true);
    expect(scoreWith(m, run(1, 3).metrics)).toBeGreaterThan(0.3);
    expect(scoreWith(m, run(0, 3).metrics)).toBeLessThan(-0.3);
    expect(scoreWith(m, { meanErrorPct: 4 })).toBeNaN();
  });

  it('is usually not ready when rest and challenge look the same (null data)', () => {
    // Pure noise: held-out balanced accuracy should centre on 0.5. With 20 runs the contract's
    // rule (>= 0.7 on >= 6) still passes by chance about 1 time in 10, which is documented.
    const bas: number[] = [];
    let ready = 0;
    for (let k = 0; k < 40; k++) {
      const m = train('follow-dot', Array.from({ length: 5 }, (_, i) => session(100 + 10 * k + i, 0)))!;
      expect(m.heldOut.n).toBe(20);
      bas.push(m.heldOut.balancedAccuracy);
      if (m.ready) ready++;
    }
    const mean = bas.reduce((a, b) => a + b) / bas.length;
    expect(mean).toBeGreaterThan(0.4);
    expect(mean).toBeLessThan(0.6);
    expect(ready / 40).toBeLessThan(0.2);
  });

  it('is not ready on too few held-out runs even when accurate', () => {
    const rows: LabelledRun[] = [];
    for (const s of ['a', 'b']) for (const y of [0, 1] as const) rows.push({ sessionId: s, activity: 'follow-dot', y, metrics: run(y, 5).metrics });
    const m = trainFromRuns('follow-dot', rows)!;
    expect(m.heldOut.n).toBe(4);
    expect(m.ready).toBe(false);
  });

  it('returns null without both classes (challenge-only activities)', () => {
    expect(train('stroop', [session(1, 3), session(2, 3)])).toBeNull();
    expect(train('typing', [session(1, 3)])).toBeNull();
  });
});
