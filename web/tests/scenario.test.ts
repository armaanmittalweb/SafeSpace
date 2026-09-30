import { describe, expect, it } from 'vitest';
import { SIGNALS, type Signal } from '../src/model/score';
import { narrate } from '../src/narrate/templates';
import {
  CAL_MIN, DEFAULT_SCENARIO, fusedSeries, readSession, readWindow, simulate, windowAt, type Session,
} from '../src/sim/scenario';

const ALL: Record<Signal, boolean> = { hr: true, hrv: true, eda: true, temp: true };
const session = simulate(DEFAULT_SCENARIO);
const readings = readSession(session);
const fused = fusedSeries(readings, ALL);

function meanFused(s: Session, preset: string, f = fused) {
  const v = s.windows.flatMap((w, i) => (w.preset === preset && !w.calibration && f[i] ? [f[i]!.score] : []));
  return v.reduce((a, b) => a + b, 0) / v.length;
}

describe('scenario simulation', () => {
  it('is deterministic for a seed and changes with it', () => {
    expect(simulate(DEFAULT_SCENARIO).windows[40].raw).toEqual(session.windows[40].raw);
    expect(simulate({ ...DEFAULT_SCENARIO, seed: 8 }).windows[40].raw).not.toEqual(session.windows[40].raw);
  });

  it('uses 60 s windows every 15 s and calibrates on the 17 windows inside the first 5 minutes', () => {
    expect(session.windows[1].start - session.windows[0].start).toBeCloseTo(0.25);
    expect(session.windows[0].end - session.windows[0].start).toBeCloseTo(1);
    expect(session.firstScored).toBe(17);
    expect(session.windows.filter((w) => w.calibration).every((w) => w.end <= CAL_MIN)).toBe(true);
    expect(session.total).toBe(CAL_MIN + 28);
  });

  it('never scores calibration windows', () => {
    for (let i = 0; i < session.firstScored; i++) expect(fused[i]).toBeNull();
  });

  it('calibration mean sits near the baseline and SDs respect the floors', () => {
    const c = session.calibration;
    expect(Math.abs(c.mean.hr_mean - DEFAULT_SCENARIO.baseline.hr_mean)).toBeLessThan(3);
    expect(c.sd.temp_mean).toBeGreaterThanOrEqual(0.05);
    expect(c.sd.scr_count).toBeGreaterThanOrEqual(0.5);
  });

  it('reads rest as calm, public speaking as stressed and amusement as not stressed', () => {
    expect(meanFused(session, 'rest')).toBeLessThan(-0.15);
    expect(meanFused(session, 'speaking')).toBeGreaterThan(0.3);
    expect(meanFused(session, 'amusement')).toBeLessThan(0);
  });

  it('walking raises HR, leaves EDA calm and flags motion; pulling HR drops the fused score', () => {
    const walk = session.windows.filter((w) => w.preset === 'walking' && w.start > session.spans.at(-1)!.start + 1);
    const idx = walk.map((w) => w.i);
    const avg = (f: (i: number) => number | undefined) => {
      const v = idx.map(f).filter((x): x is number => x !== undefined);
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
    expect(avg((i) => readings[i].hr?.score)).toBeGreaterThan(0.5);
    expect(avg((i) => readings[i].eda?.score)).toBeLessThan(0);
    expect(walk.filter((w) => w.motion).length / walk.length).toBeGreaterThan(0.8);
    const noHr = fusedSeries(readings, { ...ALL, hr: false });
    expect(meanFused(session, 'walking', noHr)).toBeLessThan(meanFused(session, 'walking'));
  });

  it('loses HRV far more often during speaking than at rest', () => {
    const share = (p: string) => {
      const w = session.windows.filter((x) => x.preset === p && !x.calibration);
      return w.filter((x) => x.valid.hrv).length / w.length;
    };
    expect(share('speaking')).toBeLessThan(share('rest'));
  });

  it('keeps physical quantities non-negative and SCR counts whole', () => {
    for (const w of session.windows) {
      expect(w.raw.scr_count).toBe(Math.round(w.raw.scr_count));
      expect(w.raw.eda_tonic).toBeGreaterThanOrEqual(0);
      expect(w.raw.rmssd).toBeGreaterThanOrEqual(0);
    }
  });

  it('what-if edits override the simulated values', () => {
    const w = session.windows[40];
    const base = readWindow(w, session.calibration);
    const hot = readWindow(w, session.calibration, { hr_mean: w.raw.hr_mean + 30 });
    expect(hot.hr!.score).toBeGreaterThan(base.hr?.score ?? -1);
  });

  it('windowAt maps simulated time to the last finished window', () => {
    expect(windowAt(session, 0.5)).toBe(-1);
    expect(windowAt(session, 1)).toBe(0);
    expect(windowAt(session, 5)).toBe(16);
    expect(windowAt(session, 999)).toBe(session.windows.length - 1);
  });
});

describe('narration', () => {
  const i = session.windows.findIndex((w) => w.preset === 'speaking' && w.start > 12);
  const w = session.windows[i];
  const moment = (included: Record<Signal, boolean>) => {
    const r = readWindow(w, session.calibration);
    return narrate({
      readings: r, raw: w.raw, cal: session.calibration, motion: w.motion, included,
      fused: fusedSeries([r], included)[0],
    });
  };

  it('gives a summary, a tip and one line per included signal', () => {
    const n = moment(ALL);
    expect(n.summary).toMatch(/stress/);
    expect(n.tip.length).toBeGreaterThan(20);
    expect(n.lines.map((l) => l.signal)).toEqual(SIGNALS);
  });

  it("drops a pulled signal's sentence and stops citing it", () => {
    const n = moment({ ...ALL, hr: false });
    expect(n.lines.map((l) => l.signal)).not.toContain('hr');
    expect(n.summary).not.toMatch(/heart rate/i);
  });

  it('says so when every pen is lifted', () => {
    expect(moment({ hr: false, hrv: false, eda: false, temp: false }).summary).toMatch(/nothing to fuse/);
  });
});
