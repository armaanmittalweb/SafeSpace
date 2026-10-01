// The contract's scoring rules, as the app applies them.
import { describe, expect, test } from 'vitest';
import type { Measurement } from '../../src/contract/records';
import { baselineFrom, baselineReady, scoreMeasurement, signalsIn } from '../../src/app/scoring';
import { checkinsCsv } from '../../src/app/export';
import { sampleData } from '../../src/app/sample';

const day = 864e5;
const m = (hr: number, rmssd: number, quality: Measurement['quality'], t = Date.now(), source: Measurement['source'] = 'camera'): Measurement =>
  ({ source, device: null, startedAt: t, durationS: 60, quality, features: { hr_mean: hr, rmssd, sdnn: rmssd * 1.2 } });
const base = (n = 3) => baselineFrom(Array.from({ length: n }, (_, i) => m(70 + i, 48 + i, 'good', Date.now() - (i + 1) * day)), 'b', Date.now());

describe('scoring rules', () => {
  test('no score before a baseline of three days', () => {
    expect(baselineReady(base(2))).toBe(false);
    expect(scoreMeasurement(m(90, 30, 'good'), base(2))).toBeNull();
    expect(scoreMeasurement(m(90, 30, 'good'), null)).toBeNull();
    // two readings on the same day count once
    const same = baselineFrom([m(70, 48, 'good', Date.now() - day), m(71, 47, 'good', Date.now() - day + 3600e3), m(72, 46, 'good', Date.now() - 2 * day)], 'x', 0);
    expect(same.calibration.n).toBe(2);
  });
  test('heart rate above rest pushes towards stressed', () => {
    const s = scoreMeasurement(m(88, 48, 'good'), base())!;
    expect(s.bySignal.hr!.score).toBeGreaterThan(0.2);
    expect(s.fused).not.toBeNull();
  });
  test('camera HRV counts only at good quality; heart rate always', () => {
    const fair = scoreMeasurement(m(80, 30, 'fair'), base())!;
    expect(Object.keys(fair.bySignal)).toEqual(['hr']);
    const good = scoreMeasurement(m(80, 30, 'good'), base())!;
    expect(Object.keys(good.bySignal).sort()).toEqual(['hr', 'hrv']);
    // a strap's HRV counts at fair
    expect(Object.keys(scoreMeasurement(m(80, 30, 'fair', Date.now(), 'ble-hr'), base())!.bySignal).sort()).toEqual(['hr', 'hrv']);
  });
  test('what was not measured is named', () => {
    const { notUsed } = signalsIn(m(80, 30, 'fair'), base());
    expect(notUsed.map((n) => n.signal).sort()).toEqual(['eda', 'hrv', 'temp']);
    expect(notUsed.find((n) => n.signal === 'eda')!.reason).toMatch(/wearable/);
  });
  test('the sample person and the CSV export', () => {
    const d = sampleData(Date.now());
    expect(d.checkins.length).toBeGreaterThan(20);
    expect(d.checkins.every((c) => c.score?.fused != null)).toBe(true);
    const csv = checkinsCsv(d.checkins).trim().split('\n');
    expect(csv.length).toBe(d.checkins.length + 1);
    expect(csv[0]).toMatch(/^date,time,score,level/);
  });
});
