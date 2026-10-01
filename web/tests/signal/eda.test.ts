import { describe, expect, it } from 'vitest';
import ref from '../fixtures/eda-reference.json';
import { accFeatures, butterLow2, edaFeatures, findPeaks, slopePerMin, tempFeatures } from '../../src/signal/eda';

// Reference values come from training/features.py run under scipy 1.15 on the same arrays
// (web/tests/fixtures/eda-reference.json; generator: eda_reference.py next to it).
describe('EDA port matches the training pipeline', () => {
  it('builds the same Butterworth sections as scipy', () => {
    for (const [fc, sos] of [[1.0, ref.butter_1hz], [0.05, ref.butter_005hz]] as const) {
      const f = butterLow2(fc, 4);
      const [b0, b1, b2, a0, a1, a2] = sos[0];
      expect(f.b[0]).toBeCloseTo(b0, 12); expect(f.b[1]).toBeCloseTo(b1, 12); expect(f.b[2]).toBeCloseTo(b2, 12);
      expect(a0).toBe(1); expect(f.a[1]).toBeCloseTo(a1, 12); expect(f.a[2]).toBeCloseTo(a2, 12);
    }
  });

  ref.cases.forEach((c, i) => {
    it(`case ${i}: eda, temp and acc features`, () => {
      const got = { ...edaFeatures(c.eda, 60), ...tempFeatures(c.temp), ...accFeatures(c.acc) };
      for (const [k, v] of Object.entries(c.expected)) expect(got[k as keyof typeof got], k).toBeCloseTo(v as number, 6);
    });
  });
});

describe('helpers', () => {
  it('findPeaks respects prominence and distance', () => {
    const x = [0, 1, 0, 0.9, 0, 0, 0, 0.5, 0.49, 0, 0.02, 0.01];
    expect(findPeaks(x, 0.1, 1).peaks).toEqual([1, 3, 7]);
    expect(findPeaks(x, 0.1, 3).peaks).toEqual([1, 7]); // 3 is within 3 samples of the taller 1
    expect(findPeaks([0, 1, 1, 1, 0], 0.5, 1).peaks).toEqual([2]); // plateau middle
  });
  it('slopePerMin is per minute', () => {
    expect(slopePerMin(Array.from({ length: 240 }, (_, i) => i / 4 / 60), 4)).toBeCloseTo(1, 10);
  });
});
