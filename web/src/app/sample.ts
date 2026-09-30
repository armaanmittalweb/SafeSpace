// A sample person's five weeks, scored by the real scorer: the signed-out home page shows it (labelled
// "Sample"), and the screenshot build seeds it into the stub vault.
import type { Baseline, CheckIn, Measurement } from '../contract/records';
import { baselineFrom, scoreMeasurement } from './scoring';
import { templateNote } from './notes';
import { addDays, startOfDay } from './format';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const at = (day: number, h: number, m: number) => { const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime(); };

function reading(t: number, hr: number, rmssd: number, quality: Measurement['quality'] = 'good'): Measurement {
  return {
    source: 'camera', device: 'Rear camera with flash', startedAt: t, durationS: 60, quality,
    features: { hr_mean: hr, rmssd, sdnn: rmssd * 1.25 },
    motion: { flagged: false, accStd: 0.04 },
  };
}

interface Plan { tags: string[]; dhr: number; drm: number; feeling: CheckIn['feeling']; h: number; q?: Measurement['quality'] }
const KINDS: Plan[] = [
  { tags: ['morning'], dhr: -1, drm: 4, feeling: 2, h: 8 },
  { tags: ['before exam'], dhr: 15, drm: -14, feeling: 4, h: 9 },
  { tags: ['after gym'], dhr: 11, drm: -9, feeling: 3, h: 19, q: 'fair' },
  { tags: ['deadline'], dhr: 9, drm: -10, feeling: 4, h: 17 },
  { tags: ['after walk'], dhr: 2, drm: 1, feeling: 2, h: 13 },
  { tags: ['evening'], dhr: 0, drm: 6, feeling: 1, h: 22 },
  { tags: ['lab report'], dhr: 6, drm: -6, feeling: 3, h: 15 },
];

export function sampleData(now = Date.now(), seed = 5): { baseline: Baseline; checkins: CheckIn[] } {
  const R = rng(seed);
  const today = startOfDay(now);
  const b0 = [reading(at(addDays(today, -34), 8, 10), 71.4, 49), reading(at(addDays(today, -33), 8, 25), 74.2, 45), reading(at(addDays(today, -32), 7, 55), 72.1, 52)];
  const baseline = baselineFrom(b0, 'sample-baseline', b0[0].startedAt);
  const checkins: CheckIn[] = [];
  for (let d = -31; d <= 0; d++) {
    const day = addDays(today, d);
    const wd = new Date(day).getDay();
    // an exam week three weeks in, gym on Tue/Thu, quiet weekends, a few empty days
    if (d === -1 || (R() < 0.15 && d !== 0)) continue;
    const plans: Plan[] = [];
    if (d === 0) plans.push(KINDS[0]);
    else if (d >= -12 && d <= -9) plans.push(KINDS[1], KINDS[4]);
    else if (d === -4) plans.push(KINDS[3]);
    else if (wd === 2 || wd === 4) plans.push(KINDS[2]);
    else if (wd === 0 || wd === 6) plans.push(KINDS[5]);
    else plans.push(R() < 0.5 ? KINDS[0] : KINDS[6]);
    if (R() < 0.35 && d !== 0) plans.push(KINDS[4]);
    for (const p of plans) {
      const t = at(day, p.h, Math.floor(R() * 50));
      if (t > now) continue;
      const m = reading(t, 72.5 + p.dhr + (R() - 0.5) * 4, Math.max(18, 48 + p.drm + (R() - 0.5) * 8), p.q ?? (R() < 0.12 ? 'fair' : 'good'));
      const c: CheckIn = {
        id: `sample-${d}-${p.h}`, createdAt: t, measurement: m, activities: [],
        score: scoreMeasurement(m, baseline), feeling: p.feeling, tags: p.tags, note: null, narration: null,
      };
      c.narration = { text: templateNote(c, baseline, 3), source: 'template' };
      checkins.push(c);
    }
  }
  checkins.sort((a, b) => b.createdAt - a.createdAt);
  return { baseline, checkins };
}
