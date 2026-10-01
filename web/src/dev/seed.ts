// Fake mode only (`?fake=…&seed=…`): puts the stub vault into a known state for screenshots.
//   seed=sample   signed in, five weeks of check-ins and a finished baseline
//   seed=new      signed in, nothing yet (first run, empty states)
//   seed=base1    signed in, baseline 1 of 3 taken yesterday
//   seed=out      signed out
//   seed=locked   signed in on the server, but this device has no key yet
import type { RecordKind } from '../contract/records';
import { sampleData } from '../app/sample';
import { baselineFrom } from '../app/scoring';
import { seedStub } from '../stubs/vault';

export function applySeed(settingsId: string) {
  let seed: string | null = null;
  try { seed = new URLSearchParams(location.search).get('seed'); } catch { return; }
  if (!seed) return;
  const email = 'asha@example.com';
  if (seed === 'out') { try { localStorage.removeItem('ss-stub-vault'); sessionStorage.removeItem('ss-guest-checkin'); } catch { /* ignore */ } return; }
  const recs: { kind: RecordKind; id: string; value: unknown; updatedAt: number }[] = [];
  if (seed === 'sample') {
    const d = sampleData();
    recs.push({ kind: 'baseline', id: d.baseline.id, value: d.baseline, updatedAt: d.baseline.createdAt });
    for (const c of d.checkins) recs.push({ kind: 'checkin', id: c.id, value: c, updatedAt: c.createdAt });
    recs.push({ kind: 'settings', id: settingsId, value: { keepRawBeats: false, aiNotes: false }, updatedAt: Date.now() });
  }
  if (seed === 'base1') {
    const t = Date.now() - 864e5;
    const b = baselineFrom([{ source: 'camera', device: 'Rear camera with flash', startedAt: t, durationS: 60, quality: 'good', features: { hr_mean: 72.4, rmssd: 47, sdnn: 58 } }], 'b1', t);
    recs.push({ kind: 'baseline', id: b.id, value: b, updatedAt: t });
  }
  seedStub(email, recs, { pending: new URLSearchParams(location.search).get('offline') === '1' });
  if (seed === 'locked') {
    try { const db = JSON.parse(localStorage.getItem('ss-stub-vault')!); db.session.locked = true; localStorage.setItem('ss-stub-vault', JSON.stringify(db)); } catch { /* ignore */ }
  }
}
