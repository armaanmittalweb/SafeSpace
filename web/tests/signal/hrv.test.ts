import { describe, expect, it } from 'vitest';
import {
  beatFeatures, beatQuality, beatTimes, cleanRR, hrMean, hrvFeatures, measurementFromHr, measurementFromRR, median, restingHr,
  restingHrFromBeats, rmssd, sd, sdnn, WINDOW_S, windowBeats,
} from '../../src/signal/hrv';

/** Deterministic pseudo-random RR series around meanMs with a breathing-like swing. */
function series(n: number, meanMs = 800, swing = 40, seed = 1): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  return Array.from({ length: n }, (_, i) => meanMs + swing * Math.sin((2 * Math.PI * i) / 5) + 10 * rnd());
}

describe('cleanRR', () => {
  it('keeps a clean series untouched', () => {
    const rr = series(80);
    const c = cleanRR(rr);
    expect(c.rejectedFraction).toBe(0);
    expect(c.rr).toEqual(rr);
    expect(c.dropped).toBe(0);
  });

  it('drops intervals outside 300..2000 ms', () => {
    const rr = [800, 810, 250, 805, 2100, 795, 800, 790, 810, 800];
    const c = cleanRR(rr);
    expect(c.kept[2]).toBe(false);
    expect(c.kept[4]).toBe(false);
    expect(c.rejectedFraction).toBeCloseTo(0.2);
  });

  it('drops a missed beat (double interval) and an extra beat (split interval)', () => {
    const rr = [800, 805, 795, 1600, 800, 810, 400, 400, 800, 790, 805, 800];
    const c = cleanRR(rr);
    expect(c.kept[3]).toBe(false);
    expect(c.kept[6]).toBe(false);
    expect(c.kept[7]).toBe(false);
    expect(c.dropped).toBe(3);
    expect(c.rr.every((x) => x > 700 && x < 900)).toBe(true);
    expect(c.rejectedFraction).toBeCloseTo(3 / 12);
  });

  it('uses the neighbour median, not the global one, so slow trends survive', () => {
    // HR climbing from 60 to 120 bpm over 120 beats: each beat is close to its neighbours.
    const rr = Array.from({ length: 120 }, (_, i) => 1000 - (500 * i) / 119);
    expect(cleanRR(rr).rejectedFraction).toBe(0);
  });

  it('treats the 20% edge as inclusive', () => {
    const rr = [1000, 1000, 1000, 1200, 1000, 1000, 1000];
    expect(cleanRR(rr).kept[3]).toBe(true);
    expect(cleanRR([1000, 1000, 1000, 1201, 1000, 1000, 1000]).kept[3]).toBe(false);
  });

  it('handles empty and tiny inputs', () => {
    expect(cleanRR([]).rejectedFraction).toBe(0);
    expect(cleanRR([800]).rr).toEqual([800]);
    expect(cleanRR([NaN, 800]).kept).toEqual([false, true]);
  });
});

describe('beatFeatures', () => {
  it('computes hr_mean, rmssd and sdnn by hand', () => {
    const rr = [800, 820, 800, 820, 800, 820, 800, 820, 800, 820, 800, 820];
    const f = beatFeatures(rr);
    expect(f.hr_mean).toBeCloseTo(60000 / 810, 6);
    expect(f.rmssd).toBeCloseTo(20, 6); // every successive difference is +-20
    expect(f.sdnn).toBeCloseTo(sd(rr), 6);
    expect(f.sdnn).toBeCloseTo(10.445, 3);
    expect(f.hrValid && f.hrvValid).toBe(true);
  });

  it('skips differences across a rejected beat', () => {
    const rr = [800, 820, 800, 820, 800, 1700, 820, 800, 820, 800, 820, 800, 820, 800];
    const f = beatFeatures(rr);
    expect(f.nClean).toBe(13);
    expect(f.rmssd).toBeCloseTo(20, 6); // the 800 -> 820 across the gap is not a successive pair
  });

  it('gates on coverage: few beats in a long window give no HRV and maybe no HR', () => {
    const rr = series(30, 1000); // 30 s of beats in a 60 s window: 50% coverage
    const f = beatFeatures(rr, 60);
    expect(f.coverage).toBeCloseTo(0.5, 1);
    expect(f.hrValid).toBe(true);
    expect(f.hrvValid).toBe(false);
    expect(beatFeatures(series(20, 1000), 60).hrValid).toBe(false);
  });

  it('needs ten successive differences for HRV', () => {
    expect(beatFeatures(series(10)).hrvValid).toBe(false);
    expect(beatFeatures(series(11)).hrvValid).toBe(true);
  });

  it('returns nulls under three clean beats', () => {
    const f = beatFeatures([800, 100]);
    expect(f.hr_mean).toBeNull();
    expect(beatQuality(f).quality).toBe('poor');
  });

  it('exposes the convenience functions', () => {
    const rr = series(75);
    expect(hrMean(rr)).toBeCloseTo(60000 / (rr.reduce((a, b) => a + b) / rr.length), 6);
    expect(rmssd(rr)).toBeGreaterThan(20);
    expect(sdnn(rr)).toBeGreaterThan(20);
  });
});

describe('hrvFeatures (contract helper)', () => {
  it('returns null under ten clean intervals and features otherwise', () => {
    expect(hrvFeatures([800, 810, 790, 805, 800, 795, 810, 800, 790])).toBeNull();
    const rr = [800, 820, 800, 820, 800, 1700, 820, 800, 820, 800, 820, 800, 820, 800];
    const f = hrvFeatures(rr)!;
    expect(f.n).toBe(13);
    expect(f.dropped).toBe(1);
    expect(f.rmssd).toBeCloseTo(20, 6);
    expect(f.hr_mean).toBeCloseTo(60000 / 809.23, 1);
  });
});

describe('quality', () => {
  it('rates a clean full window good and a patchy one fair or poor', () => {
    expect(beatQuality(beatFeatures(series(75), 60)).quality).toBe('good');
    const patchy = series(75);
    for (let i = 5; i < 75; i += 8) patchy[i] = 1600;
    const f = beatFeatures(patchy, 60);
    expect(f.rejectedFraction).toBeGreaterThan(0.05);
    const q = beatQuality(f);
    expect(q.quality).toBe('fair');
    expect(q.why).toMatch(/looked wrong/);
    expect(beatQuality(beatFeatures(series(30), 60)).quality).toBe('poor');
  });
});

describe('windowing', () => {
  it('uses the model window length from models.json', () => {
    expect(WINDOW_S).toBe(60);
  });

  it('cuts full windows only, every stride', () => {
    const rr = new Array(240).fill(1000); // 4 minutes at 60 bpm
    const t = beatTimes({ t0: 0, rr });
    expect(t[0]).toBe(1000);
    expect(t[239]).toBe(240000);
    const w = windowBeats(t, rr, { windowS: 60, strideS: 15, from: 0, to: 240000 });
    expect(w.length).toBe(13); // starts at 0, 15, ..., 180
    expect(w[0].rr.length).toBe(59); // beats ending in [0, 60 s): 1 s..59 s
    expect(w[12].start).toBe(180000);
  });

  it('returns nothing when the recording is shorter than a window', () => {
    const rr = new Array(30).fill(1000);
    expect(windowBeats(beatTimes({ t0: 0, rr }), rr)).toEqual([]);
  });
});

describe('measurements', () => {
  it('builds a Measurement with HR and HRV and no raw beats unless asked', () => {
    const rr = series(75);
    const m = measurementFromRR(rr, { source: 'ble-hr', device: 'Polar H10 A1B2', startedAt: 1000, durationS: 60 });
    expect(m.features.hr_mean).toBeGreaterThan(70);
    expect(m.features.rmssd).toBeGreaterThan(0);
    expect(m.beats).toBeUndefined();
    expect(m.quality).toBe('good');
    const kept = measurementFromRR(rr, { source: 'ble-hr', device: null, startedAt: 1000, durationS: 60, keepBeats: true, accStd: 0.01 });
    expect(kept.beats?.rr.length).toBe(75);
    expect(kept.motion).toEqual({ flagged: false, accStd: 0.01 });
    expect(kept.features.acc_std).toBe(0.01);
  });

  it('builds an HR-only Measurement from bpm samples', () => {
    const m = measurementFromHr([70, 72, 0, 250, 74], { source: 'ble-hr', device: null, startedAt: 0, durationS: 5, expected: 5 });
    expect(m.features.hr_mean).toBe(72);
    expect(m.features.rmssd).toBeUndefined();
    expect(m.quality).toBe('fair');
  });
});

describe('resting HR', () => {
  it('takes the mean of the lowest quarter', () => {
    expect(restingHr([80, 60, 62, 90, 100, 64, 70, 75])).toBe(61);
    expect(restingHr([72])).toBe(72);
    expect(restingHr([])).toBeNull();
    expect(median([3, 1, 2, 4])).toBe(2.5);
  });

  it('finds the calm stretch in a beat series', () => {
    const rr = [...new Array(200).fill(600), ...new Array(200).fill(1000)]; // 100 bpm then 60 bpm
    expect(restingHrFromBeats({ t0: 0, rr })).toBeCloseTo(60, 0);
  });
});
