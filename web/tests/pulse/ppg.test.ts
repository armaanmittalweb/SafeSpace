// The camera pulse against synthetic fingertip signals at known heart rates.
// Acceptance (docs/rebuild brief): HR within 2 bpm on clean input, within 5 bpm on moderately noisy
// input, and quality 'poor' when the hand moves.
import { describe, expect, test } from 'vitest';
import { measurementFromFrames } from '../../src/pulse/measure';
import { analyze, type Frame } from '../../src/pulse/ppg';
import { synth, type SynthOptions } from '../../src/pulse/synth';

const trueRmssd = (rr: number[]) => Math.sqrt(rr.slice(1).reduce((a, x, i) => a + (x - rr[i]) ** 2, 0) / (rr.length - 1));

/** RMSSD is small at high heart rates, so allow 25% or 8 ms, whichever is larger. */
const rmssdOk = (got: number | undefined, rr: number[], rel = 0.25) => got !== undefined && Math.abs(got - trueRmssd(rr)) <= Math.max(rel * trueRmssd(rr), 8);

const RATES = [50, 58, 65, 72, 80, 90, 100, 110, 120, 135, 150];
const FPS = [24, 30, 60];

function run(o: SynthOptions, torch = true) {
  const s = synth(o);
  const { m, a } = measurementFromFrames(s.frames, { torch, motion: s.motion }, { device: 'test', startedAt: s.t0, durationS: o.seconds ?? 60 });
  return { s, m, a, err: (m.features.hr_mean ?? NaN) - s.trueHr };
}

describe('heart rate on clean input', () => {
  const errs: number[] = [];
  for (const bpm of RATES) for (const fps of FPS) {
    test(`${bpm} bpm at ${fps} fps`, () => {
      const r = run({ bpm, fps, noise: 0.05, wander: 0.5, seed: bpm * 31 + fps });
      errs.push(Math.abs(r.err));
      expect(Math.abs(r.err)).toBeLessThanOrEqual(2);
      expect(r.m.quality).toBe('good');
      expect(rmssdOk(r.m.features.rmssd, r.s.trueRR)).toBe(true);
    });
  }
  test('summary', () => {
    const mae = errs.reduce((a, b) => a + b, 0) / errs.length;
    expect(mae).toBeLessThan(0.5);
  });
});

describe('heart rate on moderately noisy input', () => {
  for (const bpm of RATES) for (const fps of FPS) {
    test(`${bpm} bpm at ${fps} fps, noise at half the pulse, wander 3×, 6 ms jitter`, () => {
      const r = run({ bpm, fps, noise: 0.5, wander: 3, jitterMs: 6, seed: bpm * 17 + fps });
      expect(Math.abs(r.err)).toBeLessThanOrEqual(5);
      // 'good' is what lets HRV into a score, so a 'good' label must come with a trustworthy RMSSD
      if (r.m.quality === 'good') expect(rmssdOk(r.m.features.rmssd, r.s.trueRR, 0.35)).toBe(true);
    });
  }
});

describe('in between: noise at a quarter of the pulse', () => {
  for (const bpm of RATES) for (const fps of FPS) {
    test(`${bpm} bpm at ${fps} fps`, () => {
      const r = run({ bpm, fps, noise: 0.25, wander: 2, seed: bpm * 13 + fps });
      expect(Math.abs(r.err)).toBeLessThanOrEqual(3);
      if (r.m.quality === 'good') expect(rmssdOk(r.m.features.rmssd, r.s.trueRR, 0.35)).toBe(true);
    });
  }
});

describe('motion and dropped frames', () => {
  for (const bpm of [55, 75, 95, 130]) {
    test(`${bpm} bpm with a 5-s motion burst and a 0.7-s dropped-frame run`, () => {
      const r = run({ bpm, fps: 30, noise: 0.1, motion: { at: 20, dur: 5 }, drop: { at: 42, dur: 0.7 }, seed: bpm });
      expect(Math.abs(r.err)).toBeLessThanOrEqual(5);
      expect(r.m.quality).not.toBe('good');
      expect(r.m.motion?.flagged).toBe(true);
      // the live view over the burst says poor, and why
      const live = analyze(r.s.frames.filter((f) => f.t >= r.s.t0 + 17000 && f.t < r.s.t0 + 25000), { torch: true, motion: r.s.motion });
      expect(live.quality).toBe('poor');
      expect(live.why).toMatch(/still/);
    });
  }
  test('sustained movement makes the whole reading poor', () => {
    const r = run({ bpm: 80, fps: 30, noise: 0.1, motion: { at: 10, dur: 30 }, seed: 3 });
    expect(r.m.quality).toBe('poor');
  });
  test('movement seen only by the camera (no accelerometer) is still caught', () => {
    const s = synth({ bpm: 80, fps: 30, noise: 0.1, motion: { at: 10, dur: 30 }, seed: 4 });
    const a = analyze(s.frames, { torch: true });
    expect(a.quality).toBe('poor');
  });
  test('no beat interval spans a dropped-frame run', () => {
    const r = run({ bpm: 70, fps: 30, noise: 0.05, drop: { at: 30, dur: 1.2 }, seed: 9 });
    const finite = r.a.rr.filter(Number.isFinite);
    expect(Math.max(...finite)).toBeLessThan(1.3 * (60000 / 70));
    expect(r.a.rr.some(Number.isNaN)).toBe(true);
    expect(Math.abs(r.err)).toBeLessThanOrEqual(2);
  });
});

describe('optical checks', () => {
  const flat = (r: number, g: number, b: number): Frame[] => Array.from({ length: 300 }, (_, i) => ({ t: i * 33.3, r: r + Math.sin(i) * 0.3, g, b }));
  test('no finger on the lens', () => {
    const a = analyze(flat(120, 118, 110), { torch: true });
    expect(a.quality).toBe('poor');
    expect(a.why).toMatch(/Cover the lens/);
  });
  test('washed-out image', () => {
    const a = analyze(flat(255, 60, 40), { torch: true });
    expect(a.quality).toBe('poor');
    expect(a.why).toMatch(/lightly/);
  });
  test('without a torch the best a reading gets is fair', () => {
    const r = run({ bpm: 72, fps: 30, noise: 0.05, seed: 5 }, false);
    expect(r.m.quality).toBe('fair');
    expect(Math.abs(r.err)).toBeLessThanOrEqual(2);
  });
});
