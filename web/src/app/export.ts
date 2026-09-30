// Exports built on this device from the decrypted records (the encrypted backup comes from the vault).
import type { Baseline, CheckIn } from '../contract/records';
import { feelingWord, levelOf } from './scoring';

const q = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const n = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));

export function checkinsCsv(cs: CheckIn[]): string {
  const head = ['date', 'time', 'score', 'level', 'hr_score', 'hrv_score', 'heart_rate_bpm', 'rmssd_ms', 'sdnn_ms', 'signal_quality', 'source', 'feeling', 'tags', 'note'];
  const rows = [...cs].sort((a, b) => a.createdAt - b.createdAt).map((c) => {
    const d = new Date(c.createdAt);
    const f = c.measurement?.features ?? {};
    const sc = c.score?.fused;
    return [
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      n(sc, 3), sc == null ? '' : levelOf(sc), n(c.score?.bySignal.hr?.score, 3), n(c.score?.bySignal.hrv?.score, 3),
      n(f.hr_mean), n(f.rmssd), n(f.sdnn), c.measurement?.quality ?? '', c.measurement?.source ?? 'manual',
      feelingWord(c.feeling) ?? '', c.tags.join('; '), c.note ?? '',
    ].map(q).join(',');
  });
  return [head.join(','), ...rows].join('\n') + '\n';
}

export function checkinsJson(cs: CheckIn[], baseline: Baseline | null): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), app: 'SafeSpace', baseline, checkins: cs }, null, 2);
}
