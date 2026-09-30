import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { appleDate, beatsFromHrvBody, clockSeconds } from '../../src/imports/apple';
import { parseChannel, parseIbi } from '../../src/imports/e4';
import { fitbitDate, fitbitFileKind } from '../../src/imports/fitbit';
import { parseImport } from '../../src/imports/parse';

// ---------- fixture builders (small, generated) ----------

function appleXml(): string {
  const hr: string[] = [];
  // 10 spot readings, one every 5 minutes, then a dense workout minute (12 samples).
  for (let i = 0; i < 10; i++) {
    const mm = String(i * 5).padStart(2, '0');
    hr.push(`<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Asha&#x2019;s Apple Watch" unit="count/min" creationDate="2026-03-01 09:${mm}:30 +0530" startDate="2026-03-01 09:${mm}:10 +0530" endDate="2026-03-01 09:${mm}:10 +0530" value="${70 + i}"/>`);
  }
  for (let s = 0; s < 60; s += 5) {
    hr.push(`<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-03-01 18:00:${String(s).padStart(2, '0')} +0530" endDate="2026-03-01 18:00:${String(s).padStart(2, '0')} +0530" value="140">\n  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="2"/>\n </Record>`);
  }
  // HRV with a beat list: alternating 800/820 ms beats from 9:41:00 PM.
  let t = 21 * 3600 + 41 * 60;
  const beats: string[] = [];
  for (let i = 0; i < 70; i++) {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const h12 = h % 12 || 12;
    beats.push(`   <InstantaneousBeatsPerMinute bpm="${i % 2 ? 73 : 75}" time="${h12}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')} ${h >= 12 ? 'PM' : 'AM'}"/>`);
    t += i % 2 ? 0.8 : 0.82;
  }
  const hrv = `<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Watch" unit="ms" startDate="2026-03-01 21:41:00 +0530" endDate="2026-03-01 21:42:00 +0530" value="48.5">
  <HeartRateVariabilityMetadataList>
${beats.join('\n')}
  </HeartRateVariabilityMetadataList>
 </Record>`;
  const hrvPlain = '<Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Watch" unit="ms" startDate="2026-03-02 07:00:00 +0530" endDate="2026-03-02 07:01:00 +0530" value="61.2"/>';
  const rhr = ['2026-03-01', '2026-03-02'].map((d, i) => `<Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="${d} 00:00:00 +0530" endDate="${d} 23:59:00 +0530" value="${58 + i}"/>`);
  const noise = '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" startDate="2026-03-01 09:00:00 +0530" endDate="2026-03-01 09:05:00 +0530" value="312"/>';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>\n]>\n<HealthData locale="en_IN">\n <ExportDate value="2026-03-03 10:00:00 +0530"/>\n ${noise}\n ${hr.join('\n ')}\n ${hrv}\n ${hrvPlain}\n ${rhr.join('\n ')}\n</HealthData>\n`;
}

function fitbitZip(): Uint8Array {
  const hr = [];
  // 03/01/26 08:00:00 UTC onwards: two full minutes at 5-s spacing, then a sparse minute (2 samples).
  for (let s = 0; s < 120; s += 5) hr.push({ dateTime: `03/01/26 08:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, value: { bpm: 60 + (s % 10), confidence: 2 } });
  hr.push({ dateTime: '03/01/26 08:05:00', value: { bpm: 90, confidence: 3 } }, { dateTime: '03/01/26 08:05:30', value: { bpm: 91, confidence: 3 } });
  hr.push({ dateTime: '03/01/26 08:00:02', value: { bpm: 200, confidence: 0 } }); // no confidence: dropped
  return zipSync({
    'Takeout/Fitbit/Global Export Data/heart_rate-2026-03-01.json': strToU8(JSON.stringify(hr)),
    'Takeout/Fitbit/Global Export Data/resting_heart_rate-2026-03-01.json': strToU8(JSON.stringify([{ dateTime: '03/01/26 00:00:00', value: { date: '03/01/26', value: 61.37, error: 7.2 } }])),
    'Takeout/Fitbit/Heart Rate Variability/Heart Rate Variability Details - 2026-03-01.csv': strToU8('timestamp,rmssd,coverage,low_frequency,high_frequency\n2026-03-01T01:05:00,38.2,0.93,512.1,301.2\n2026-03-01T01:10:00,41.0,0.6,500.0,280.0\n'),
    'Takeout/Fitbit/Heart Rate Variability/Daily Heart Rate Variability Summary - 2026-03-(1).csv': strToU8('timestamp,rmssd,nremhr,entropy\n2026-03-01T00:00:00,39.9,56.1,2.9\n'),
    'Takeout/Fitbit/Global Export Data/steps-2026-03-01.json': strToU8('[]'),
  });
}

function e4Zip(minutes = 3): Uint8Array {
  const start = 1772352000; // 2026-03-01T08:00:00Z
  const n4 = minutes * 60 * 4;
  const eda = [`${start}.000000`, '4.000000'];
  const temp = [`${start}.000000`, '4.000000'];
  for (let i = 0; i < n4; i++) {
    const t = i / 4;
    const scr = [20, 80, 140].reduce((a, c) => a + (t >= c ? 0.1 * (Math.exp(-(t - c) / 4) - Math.exp(-(t - c) / 0.75)) : 0), 0);
    eda.push((0.8 + 0.002 * t + scr).toFixed(6));
    temp.push((33.1 - 0.001 * t).toFixed(2));
  }
  const acc = [`${start}.000000, ${start}.000000, ${start}.000000`, '32.000000, 32.000000, 32.000000'];
  for (let i = 0; i < minutes * 60 * 32; i++) {
    const moving = i >= 2 * 60 * 32; // last minute: waving the arm
    const wob = moving ? Math.round(30 * Math.sin(i / 3)) : (i % 3) - 1;
    acc.push(`${wob},${-2},${64 + (moving ? Math.round(20 * Math.cos(i / 5)) : 0)}`);
  }
  const ibi = [`${start}.000000, IBI`];
  let t = 0.4;
  for (let i = 0; t < minutes * 60 - 1; i++) { const r = i % 2 ? 0.8 : 0.82; t += r; ibi.push(`${t.toFixed(6)},${r.toFixed(6)}`); }
  const hr = [`${start + 10}.000000`, '1.000000', ...Array.from({ length: minutes * 60 - 10 }, () => '74.00')];
  return zipSync({
    'EDA.csv': strToU8(eda.join('\n')), 'TEMP.csv': strToU8(temp.join('\n')), 'ACC.csv': strToU8(acc.join('\n')),
    'IBI.csv': strToU8(ibi.join('\n')), 'HR.csv': strToU8(hr.join('\n')), 'BVP.csv': strToU8(`${start}\n64.0\n0\n`), 'tags.csv': strToU8(''),
  });
}

const file = (data: Uint8Array | string, name: string) => new File([data as BlobPart], name);

// ---------- tests ----------

describe('date and field helpers', () => {
  it('parses Apple dates with offsets', () => {
    expect(appleDate('2026-03-01 09:41:03 +0530')).toBe(Date.UTC(2026, 2, 1, 4, 11, 3));
    expect(clockSeconds('9:41:03.12 PM')).toBeCloseTo(21 * 3600 + 41 * 60 + 3.12, 6);
    expect(clockSeconds('12:00:00.00 AM')).toBe(0);
    expect(clockSeconds('12:30:00 PM')).toBe(12.5 * 3600);
  });
  it('reads beat intervals from beat times, across midnight', () => {
    const body = '<InstantaneousBeatsPerMinute bpm="60" time="11:59:59.50 PM"/><InstantaneousBeatsPerMinute bpm="60" time="12:00:00.30 AM"/>';
    expect(beatsFromHrvBody(body)).toEqual([800]);
  });
  it('parses Fitbit UTC dates and file names', () => {
    expect(fitbitDate('03/01/26 08:00:05')).toBe(Date.UTC(2026, 2, 1, 8, 0, 5));
    expect(fitbitFileKind('Takeout/Fitbit/Global Export Data/heart_rate-2026-03-01.json')).toBe('hr');
    expect(fitbitFileKind('x/resting_heart_rate-2026-03-01.json')).toBe('resting');
    expect(fitbitFileKind('x/steps-2026-03-01.json')).toBeNull();
  });
  it('parses E4 channel and IBI files', () => {
    const c = parseChannel('1772352000.000000, 1772352000.000000, 1772352000.000000\n32.0, 32.0, 32.0\n1,2,64\n3,4,63\n')!;
    expect(c).toMatchObject({ start: 1772352000000, hz: 32, cols: 3 });
    expect([...c.data]).toEqual([1, 2, 64, 3, 4, 63]);
    expect(parseIbi('1772352000.000000, IBI\n1.0,0.8\n1.82,0.82\n')).toEqual({ t: [1772352001000, 1772352001820], rr: [800, 820] });
  });
});

describe('Apple Health import', () => {
  const check = (r: Awaited<ReturnType<typeof parseImport>>) => {
    const hr = r.measurements.filter((m) => m.features.sdnn == null);
    const hrv = r.measurements.filter((m) => m.features.sdnn != null);
    expect(hr).toHaveLength(11);
    expect(hr[0]).toMatchObject({ source: 'import-apple', durationS: 60, quality: 'fair', features: { hr_mean: 70 } });
    const workout = hr.find((m) => m.features.hr_mean === 140)!;
    expect(workout.quality).toBe('good');
    expect(hrv).toHaveLength(2);
    expect(hrv[0].features.rmssd).toBeCloseTo(20, 0);
    expect(hrv[0].features.hr_mean).toBeCloseTo(60000 / 810, 0);
    expect(hrv[1].features).toEqual({ sdnn: 61.2 });
    expect(r.daily).toEqual([
      { date: '2026-03-01', restingHr: 58, hrv: 48.5, hrvKind: 'sdnn' },
      { date: '2026-03-02', restingHr: 59, hrv: 61.2, hrvKind: 'sdnn' },
    ]);
    expect(r.summary).toMatch(/11 heart-rate minutes and 2 HRV readings/);
    expect(JSON.stringify(r)).not.toMatch(/Asha/); // HR windows do not carry the source name
  };

  it('streams export.xml', async () => {
    const progress: number[] = [];
    check(await parseImport('import-apple', file(appleXml(), 'export.xml'), (f) => progress.push(f)));
    expect(progress.at(-1)).toBe(1);
  });

  it('streams export.xml inside export.zip, split into tiny chunks', async () => {
    const zip = zipSync({ 'apple_health_export/export.xml': strToU8(appleXml()), 'apple_health_export/export_cda.xml': strToU8('<x/>') }, { level: 6 });
    // A Blob made of 97-byte parts makes the stream hand over many small chunks.
    const parts: Uint8Array[] = [];
    for (let i = 0; i < zip.length; i += 97) parts.push(zip.slice(i, i + 97));
    check(await parseImport('import-apple', new File(parts as BlobPart[], 'export.zip')));
  });

  it('rejects files that are not Health exports', async () => {
    await expect(parseImport('import-apple', file('hello', 'notes.xml'))).rejects.toThrow(/does not look like an Apple Health export/);
    await expect(parseImport('import-apple', file(zipSync({ 'a.txt': strToU8('x') }), 'x.zip'))).rejects.toThrow(/no export.xml/);
  });

  it('keeps only the last N days', async () => {
    const r = await parseImport('import-apple', file(appleXml(), 'export.xml'), undefined, { days: 0.5 });
    expect(r.measurements.every((m) => m.startedAt > Date.UTC(2026, 2, 1, 12))).toBe(true);
    expect(r.summary).toMatch(/left out/);
  });
});

describe('Fitbit import', () => {
  it('reads heart rate, HRV details and daily context from a Takeout zip', async () => {
    const r = await parseImport('import-fitbit', file(fitbitZip(), 'takeout-20260303.zip'));
    const hr = r.measurements.filter((m) => m.features.hr_mean != null);
    expect(hr).toHaveLength(3);
    expect(hr[0]).toMatchObject({ startedAt: Date.UTC(2026, 2, 1, 8), quality: 'good' });
    expect(hr[0].features.hr_mean).toBeCloseTo(62.5, 6); // the confidence-0 200 bpm sample is ignored
    expect(hr[2].quality).toBe('fair'); // two samples 30 s apart
    const hrv = r.measurements.filter((m) => m.features.rmssd != null);
    expect(hrv.map((m) => [m.features.rmssd, m.quality, m.durationS])).toEqual([[38.2, 'good', 300], [41, 'fair', 300]]);
    expect(r.daily).toEqual([{ date: '2026-03-01', restingHr: 61.4, hrv: 39.9, hrvKind: 'rmssd' }]);
    expect(r.summary).toMatch(/^Fitbit: 3 heart-rate minutes and 2 overnight HRV readings/);
  });

  it('explains a zip with no Fitbit files', async () => {
    await expect(parseImport('import-fitbit', file(zipSync({ 'Takeout/Mail/x.mbox': strToU8('x') }), 'takeout.zip'))).rejects.toThrow(/No Fitbit heart-rate files/);
  });
});

describe('Empatica E4 import', () => {
  it('computes every model feature per window', async () => {
    const progress: number[] = [];
    const r = await parseImport('import-e4', file(e4Zip(3), '1772352000_A01B2C.zip'), (f) => progress.push(f));
    expect(r.measurements).toHaveLength(3);
    const [a, , c] = r.measurements;
    expect(a).toMatchObject({ source: 'import-e4', device: 'Empatica E4 A01B2C', startedAt: 1772352000000, durationS: 60, quality: 'good' });
    expect(Object.keys(a.features).sort()).toEqual(['acc_std', 'eda_slope', 'eda_tonic', 'hr_mean', 'rmssd', 'scr_amp', 'scr_count', 'sdnn', 'temp_mean', 'temp_slope']);
    expect(a.features.hr_mean).toBeCloseTo(60000 / 810, 0);
    expect(a.features.rmssd).toBeCloseTo(20, 0);
    expect(a.features.scr_count).toBe(1);
    expect(a.features.temp_slope).toBeCloseTo(-0.06, 2); // temps are rounded to 0.01
    expect(a.motion?.flagged).toBe(false);
    expect(c.motion?.flagged).toBe(true);
    expect(c.quality).toBe('poor');
    expect(r.summary).toMatch(/3 one-minute windows/);
    expect(r.summary).toMatch(/skin conductance, skin temperature, heart rate, HRV, motion/);
    expect(progress.at(-1)).toBe(1);
  });

  it('refuses a single CSV', async () => {
    await expect(parseImport('import-e4', file('1,2', 'EDA.csv'))).rejects.toThrow(/session zip/);
  });
});
