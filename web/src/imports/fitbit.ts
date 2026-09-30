// Fitbit data from Google Takeout (Takeout/Fitbit/...), or the older fitbit.com account
// export with the same files. Files read (matched by name anywhere in the zip):
//
//   heart_rate-YYYY-MM-DD.json      [{dateTime: "03/01/24 08:00:05", value: {bpm, confidence}}]
//                                   every 1-15 s, UTC. -> 60-s windows (window_s) of hr_mean,
//                                   confidence 0 samples dropped. Quality good with >= 75% of
//                                   the minute covered (samples x median spacing), fair >= 25%,
//                                   else the minute is skipped.
//   resting_heart_rate-*.json       [{dateTime, value: {date: "03/01/24", value: 61.2}}] -> daily
//   Heart Rate Variability Details - *.csv   timestamp,rmssd,coverage,low_frequency,high_frequency
//                                   5-minute RMSSD during sleep -> Measurement {rmssd}, 300 s,
//                                   quality fair (coverage >= 0.8 good)
//   Daily Heart Rate Variability Summary - *.csv   timestamp,rmssd,nremhr,entropy -> daily
import type { Measurement } from '../contract';
import { WINDOW_S } from '../signal/hrv';
import { baseName } from './stream';
import { fmtDay, limit, plural, type DailyContext, type ImportOptions, type ImportResult } from './types';

/** "03/01/24 08:00:05" (MM/DD/YY, UTC) -> epoch ms. */
export function fitbitDate(s: string): number {
  const m = /^(\d{2})\/(\d{2})\/(\d{2,4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return Date.parse(s);
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return Date.UTC(y, +m[1] - 1, +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

function csvRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    const r: Record<string, string> = {};
    head.forEach((h, i) => { r[h] = (c[i] ?? '').trim(); });
    return r;
  });
}

export type FitbitFile = 'hr' | 'resting' | 'hrv-details' | 'hrv-daily' | null;
export function fitbitFileKind(path: string): FitbitFile {
  const n = baseName(path);
  if (/^heart_rate-\d{4}-\d{2}-\d{2}\.json$/.test(n)) return 'hr';
  if (/^resting_heart_rate-.*\.json$/.test(n)) return 'resting';
  if (/^Heart Rate Variability Details.*\.csv$/i.test(n)) return 'hrv-details';
  if (/^Daily Heart Rate Variability Summary.*\.csv$/i.test(n)) return 'hrv-daily';
  return null;
}

export class FitbitParser {
  private minutes = new Map<number, number[]>(); // window index -> sample times (ms)
  private bpmSum = new Map<number, number>();
  private hrv: Measurement[] = [];
  private daily = new Map<string, DailyContext>();
  files = 0;

  private day(date: string): DailyContext {
    let d = this.daily.get(date);
    if (!d) this.daily.set(date, (d = { date }));
    return d;
  }

  addFile(path: string, text: string): void {
    const kind = fitbitFileKind(path);
    if (!kind) return;
    this.files++;
    if (kind === 'hr') {
      let arr: { dateTime: string; value: { bpm: number; confidence?: number } }[];
      try { arr = JSON.parse(text); } catch { return; }
      for (const r of arr) {
        const bpm = r?.value?.bpm;
        if (!Number.isFinite(bpm) || bpm < 30 || bpm > 220 || r.value.confidence === 0) continue;
        const t = fitbitDate(r.dateTime);
        if (!Number.isFinite(t)) continue;
        const k = Math.floor(t / (WINDOW_S * 1000));
        const a = this.minutes.get(k);
        if (a) a.push(t); else this.minutes.set(k, [t]);
        this.bpmSum.set(k, (this.bpmSum.get(k) ?? 0) + bpm);
      }
    } else if (kind === 'resting') {
      let arr: { dateTime: string; value: { date?: string; value: number } }[];
      try { arr = JSON.parse(text); } catch { return; }
      for (const r of arr) {
        const v = r?.value?.value;
        if (!Number.isFinite(v) || v <= 0) continue;
        this.day(isoDay(fitbitDate(r.value.date ?? r.dateTime))).restingHr = Math.round(v * 10) / 10;
      }
    } else if (kind === 'hrv-details') {
      for (const r of csvRows(text)) {
        const t = Date.parse(r.timestamp);
        const rm = Number(r.rmssd);
        if (!Number.isFinite(t) || !Number.isFinite(rm) || rm <= 0) continue;
        const cov = Number(r.coverage);
        this.hrv.push({ source: 'import-fitbit', device: 'Fitbit', startedAt: t, durationS: 300, quality: cov >= 0.8 ? 'good' : 'fair', features: { rmssd: rm } });
      }
    } else if (kind === 'hrv-daily') {
      for (const r of csvRows(text)) {
        const rm = Number(r.rmssd);
        if (!r.timestamp || !Number.isFinite(rm) || rm <= 0) continue;
        const d = this.day(r.timestamp.slice(0, 10));
        d.hrv = Math.round(rm * 10) / 10;
        d.hrvKind = 'rmssd';
      }
    }
  }

  finish(opts: ImportOptions = {}): ImportResult {
    if (this.files === 0) {
      throw new Error('No Fitbit heart-rate files were found in this file. Use the Google Takeout export with Fitbit selected (the zip that contains a Fitbit folder).');
    }
    const hr: Measurement[] = [];
    const w = WINDOW_S * 1000;
    for (const [k, times] of this.minutes) {
      times.sort((a, b) => a - b);
      let spacing = 5000;
      if (times.length > 1) {
        const d = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
        spacing = Math.min(Math.max(d[d.length >> 1], 1000), 15000);
      }
      const coverage = Math.min(1, (times.length * spacing) / w);
      if (coverage < 0.25) continue;
      hr.push({
        source: 'import-fitbit', device: 'Fitbit', startedAt: k * w, durationS: WINDOW_S,
        quality: coverage >= 0.75 ? 'good' : 'fair', features: { hr_mean: this.bpmSum.get(k)! / times.length },
      });
    }
    const { kept, dropped, from, to } = limit([...hr, ...this.hrv], opts);
    const cutoffDay = from == null ? '' : isoDay(from);
    const daily = [...this.daily.values()].filter((d) => d.date >= cutoffDay).sort((a, b) => a.date.localeCompare(b.date));
    const nHrv = kept.filter((m) => m.features.rmssd != null).length;
    const nHr = kept.length - nHrv;
    let summary = `Fitbit: ${plural(nHr, 'heart-rate minute')} and ${plural(nHrv, 'overnight HRV reading')}`;
    if (from != null && to != null) summary += ` from ${fmtDay(from)} to ${fmtDay(to)}`;
    summary += `. Resting heart rate on ${plural(daily.filter((d) => d.restingHr != null).length, 'day')}.`;
    if (dropped) summary += ` ${plural(dropped, 'older reading')} left out (only the last ${opts.days ?? 90} days are kept).`;
    return { measurements: kept, summary, daily };
  }
}
