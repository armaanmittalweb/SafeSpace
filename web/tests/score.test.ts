import { describe, expect, it } from 'vitest';
import fixtures from '../src/model/parity.fixtures.json';
import { fuse, fuseReadings, logitOf, probabilityOf, readSignal, sigmoid, SIGNALS, type Signal } from '../src/model/score';

describe('TS scorer matches onnxruntime on models_v2/*.onnx', () => {
  for (const s of SIGNALS) {
    it(`${s}: every fixture within 1e-6`, () => {
      const rows = (fixtures.signals as Record<Signal, { z: number[]; p: number }[]>)[s];
      expect(rows.length).toBeGreaterThan(50);
      let worst = 0;
      for (const r of rows) worst = Math.max(worst, Math.abs(probabilityOf(s, r.z) - r.p));
      expect(worst).toBeLessThan(1e-6);
    });
  }
});

describe('fusion', () => {
  it('is 2*sigmoid(mean logit) - 1', () => {
    const f = fuse([2, -1, 0.5])!;
    expect(f.score).toBeCloseTo(2 * sigmoid(0.5) - 1, 12);
    expect(f.n).toBe(3);
  });
  it('returns null with nothing to fuse', () => {
    expect(fuse([])).toBeNull();
  });
  it('clips logits like the training pipeline (p in [1e-6, 1-1e-6])', () => {
    expect(fuse([100])!.logit).toBeCloseTo(Math.log((1 - 1e-6) / 1e-6), 9);
  });
  it('pulling a signal recomputes the mean over the rest', () => {
    const z = { hr_mean: 8, eda_tonic: 0.5, eda_slope: 0, scr_count: 0, scr_amp: 0, temp_mean: 0, temp_slope: 0, rmssd: 0, sdnn: 0 };
    const r = { hr: readSignal('hr', z), eda: readSignal('eda', z), temp: readSignal('temp', z), hrv: null };
    const all = fuseReadings(r, { hr: true, eda: true, temp: true, hrv: true })!;
    const noHr = fuseReadings(r, { hr: false, eda: true, temp: true, hrv: true })!;
    expect(all.n).toBe(3);
    expect(noHr.n).toBe(2);
    expect(noHr.logit).toBeCloseTo((r.eda.logit + r.temp.logit) / 2, 12);
    expect(noHr.score).toBeLessThan(all.score);
  });
  it('contributions sum with the intercept to the logit', () => {
    const z = { eda_tonic: 3, eda_slope: -1, scr_count: 2, scr_amp: 0.5 };
    const r = readSignal('eda', z);
    const sum = r.contributions.reduce((a, c) => a + c.value, 0);
    expect(r.logit - sum).toBeCloseTo(logitOf('eda', [0, 0, 0, 0]), 12);
  });
});
