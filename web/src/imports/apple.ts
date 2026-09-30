// Apple Health export (export.zip from Health > profile > Export All Health Data, or the
// export.xml inside it). The XML can be gigabytes, so it is scanned as a stream for three
// record types; everything else is skipped without being parsed.
//
//   HKQuantityTypeIdentifierHeartRate                 spot or workout samples, count/min
//     -> grouped into 60-s windows (window_s) as hr_mean; quality good with >= 6 samples
//        in the minute (a workout), else fair (a spot reading every few minutes)
//   HKQuantityTypeIdentifierHeartRateVariabilitySDNN  ~1-minute Apple Watch readings, ms
//     -> one Measurement each. When the record lists its beats (InstantaneousBeatsPerMinute
//        with times to 1/100 s) the intervals go through signal/hrv.ts for hr_mean, rmssd
//        and sdnn; otherwise only Apple's own sdnn. Quality fair (wrist PPG).
//   HKQuantityTypeIdentifierRestingHeartRate          one per day -> daily.restingHr
import type { Measurement } from '../contract';
import { beatFeatures, WINDOW_S } from '../signal/hrv';
import { fmtDay, limit, plural, type DailyContext, type ImportOptions, type ImportResult } from './types';

const HR = 'HKQuantityTypeIdentifierHeartRate';
const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RHR = 'HKQuantityTypeIdentifierRestingHeartRate';

/** "2024-03-01 09:41:03 -0800" -> epoch ms. */
export function appleDate(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return Date.parse(s);
  return Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
}

function attr(tag: string, name: string): string | null {
  const i = tag.indexOf(` ${name}="`);
  if (i < 0) return null;
  const s = i + name.length + 3;
  const e = tag.indexOf('"', s);
  return e < 0 ? null : tag.slice(s, e);
}

/** "9:41:03.12 PM" -> seconds since local midnight. */
export function clockSeconds(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)\s*(AM|PM)?$/i.exec(s.trim());
  if (!m) return null;
  let h = +m[1];
  if (m[4]) { const pm = m[4].toUpperCase() === 'PM'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return h * 3600 + +m[2] * 60 + +m[3];
}

/** Beat intervals (ms) from an HRV record's InstantaneousBeatsPerMinute list. */
export function beatsFromHrvBody(body: string): number[] {
  const times: number[] = [];
  const bpms: number[] = [];
  const re = /<InstantaneousBeatsPerMinute\b([^>]*)\/?>/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const bpm = Number(attr(m[1], 'bpm'));
    const t = clockSeconds(attr(m[1], 'time') ?? '');
    if (Number.isFinite(bpm)) bpms.push(bpm);
    if (t != null) times.push(t);
  }
  if (times.length === bpms.length && times.length >= 2) {
    const rr: number[] = [];
    for (let i = 1; i < times.length; i++) {
      let d = times[i] - times[i - 1];
      if (d < -43200) d += 86400; // past midnight
      rr.push(Math.round(d * 1000));
    }
    return rr;
  }
  return bpms.filter((b) => b > 0).map((b) => 60000 / b);
}

export class AppleHealthParser {
  private buf = '';
  private hrMinutes = new Map<number, { sum: number; n: number }>();
  private hrv: Measurement[] = [];
  private resting = new Map<string, number[]>();
  private hrvByDay = new Map<string, number[]>();
  private sawHealthData = false;
  records = 0;

  push(text: string): void {
    this.buf += text;
    if (!this.sawHealthData && this.buf.includes('<HealthData')) this.sawHealthData = true;
    let pos = 0;
    for (;;) {
      const i = this.buf.indexOf('<Record ', pos);
      if (i < 0) { pos = Math.max(pos, this.buf.length - 16); break; }
      const end = this.buf.indexOf('>', i);
      if (end < 0) { pos = i; break; }
      const tag = this.buf.slice(i, end + 1);
      const type = attr(tag, 'type');
      const selfClosing = tag.endsWith('/>');
      if (type === HRV && !selfClosing) {
        const close = this.buf.indexOf('</Record>', end);
        if (close < 0) { pos = i; break; }
        this.onRecord(type, tag, this.buf.slice(end + 1, close));
        pos = close + 9;
      } else {
        if (type === HR || type === RHR || type === HRV) this.onRecord(type, tag, '');
        pos = end + 1;
      }
      this.records++;
    }
    this.buf = this.buf.slice(pos);
  }

  private onRecord(type: string, tag: string, body: string) {
    const start = attr(tag, 'startDate');
    const value = Number(attr(tag, 'value'));
    if (!start || !Number.isFinite(value)) return;
    const t = appleDate(start);
    if (!Number.isFinite(t)) return;
    const day = start.slice(0, 10);
    if (type === HR) {
      if (value < 30 || value > 220) return;
      const k = Math.floor(t / (WINDOW_S * 1000));
      const b = this.hrMinutes.get(k);
      if (b) { b.sum += value; b.n++; } else this.hrMinutes.set(k, { sum: value, n: 1 });
    } else if (type === RHR) {
      const a = this.resting.get(day);
      if (a) a.push(value); else this.resting.set(day, [value]);
    } else if (type === HRV) {
      const endT = appleDate(attr(tag, 'endDate') ?? start);
      const durationS = Math.max(1, Math.round((endT - t) / 1000)) || WINDOW_S;
      const rr = body ? beatsFromHrvBody(body) : [];
      const f = rr.length ? beatFeatures(rr) : null;
      const features: Measurement['features'] = {};
      if (f?.hrvValid) { features.hr_mean = f.hr_mean!; features.rmssd = f.rmssd!; features.sdnn = f.sdnn!; }
      else { features.sdnn = value; if (f?.hrValid) features.hr_mean = f.hr_mean!; }
      this.hrv.push({ source: 'import-apple', device: attr(tag, 'sourceName'), startedAt: t, durationS, quality: 'fair', features });
      const a = this.hrvByDay.get(day);
      if (a) a.push(value); else this.hrvByDay.set(day, [value]);
    }
  }

  finish(opts: ImportOptions = {}): ImportResult {
    if (!this.sawHealthData && this.records === 0) {
      throw new Error('This does not look like an Apple Health export. Use export.zip (or export.xml inside it) from the Health app: tap your picture, then Export All Health Data.');
    }
    const hr: Measurement[] = [];
    for (const [k, b] of this.hrMinutes) {
      hr.push({ source: 'import-apple', device: 'Apple Health', startedAt: k * WINDOW_S * 1000, durationS: WINDOW_S, quality: b.n >= 6 ? 'good' : 'fair', features: { hr_mean: b.sum / b.n } });
    }
    const all = [...hr, ...this.hrv];
    const { kept, dropped, from, to } = limit(all, opts);
    const days = new Set([...this.resting.keys(), ...this.hrvByDay.keys()]);
    const cutoffDay = from == null ? '' : new Date(from).toISOString().slice(0, 10);
    const daily: DailyContext[] = [...days].filter((d) => d >= cutoffDay).sort().map((date) => {
      const r = this.resting.get(date);
      const h = this.hrvByDay.get(date);
      const d: DailyContext = { date };
      if (r) d.restingHr = Math.round((r.reduce((a, b) => a + b, 0) / r.length) * 10) / 10;
      if (h) { d.hrv = Math.round((h.reduce((a, b) => a + b, 0) / h.length) * 10) / 10; d.hrvKind = 'sdnn'; }
      return d;
    });
    const nHr = kept.filter((m) => m.features.sdnn == null).length;
    const nHrv = kept.length - nHr;
    const nRest = daily.filter((d) => d.restingHr != null).length;
    let summary: string;
    if (!kept.length && !nRest) {
      summary = 'Apple Health export read, but it has no heart-rate, HRV or resting heart-rate records. An Apple Watch (or another heart-rate app writing to Health) is needed for these.';
    } else {
      summary = `Apple Health: ${plural(nHr, 'heart-rate minute')} and ${plural(nHrv, 'HRV reading')}`;
      if (from != null && to != null) summary += ` from ${fmtDay(from)} to ${fmtDay(to)}`;
      summary += `. Resting heart rate on ${plural(nRest, 'day')}.`;
      if (dropped) summary += ` ${plural(dropped, 'older reading')} left out (only the last ${opts.days ?? 90} days are kept).`;
    }
    return { measurements: kept, summary, daily };
  }
}
