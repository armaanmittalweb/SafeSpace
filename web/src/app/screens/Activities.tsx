import type { ActivityResult, CheckIn, Measurement, StressSession } from '../../contract/records';
import { ActivityPicker } from '../../activities';
import { baselineFromRest, baselineReady, BASELINE_NEEDED } from '../scoring';
import { IconBack } from '../icons';
import { ACTIVITIES, StressSessionView } from '../ports';
import type { RunProps } from '../../activities';
import { Link, navigate } from '../router';
import { calmRuns, getState, toast, useApp } from '../store';
import { vault } from '../vault';

export function Activities() {
  const s = useApp();
  const signedIn = s.auth.state === 'in';
  const isPhone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && typeof DeviceMotionEvent !== 'undefined';
  return (
    <div class="page">
      <header class="page-head">
        <h1>Activities</h1>
        <p class="lead">Short tasks that read your typing, pointing and timing. Only timing and movement are recorded, never which keys you press.</p>
      </header>
      {!signedIn && <p class="notice">You can try any activity without an account. Results are not saved.</p>}
      <ActivityPicker onPick={(a) => navigate(`/activities/${a.id}`)} onSession={() => navigate('/activities/session')}
        calmRuns={calmRuns()} isPhone={isPhone} liveDevice={s.device?.conn.device ?? null} />
    </div>
  );
}

function RunFrame({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="flow-body">
      <header class="flow-bar">
        <Link href="/activities" class="icon-btn" aria-label="Back to activities"><IconBack /></Link>
        <h1 class="flow-title">{title}</h1>
        <span class="icon-btn-space" />
      </header>
      <div class="flow-content">{children}</div>
    </div>
  );
}

async function saveActivity(r: ActivityResult) {
  const st = getState();
  if (st.auth.state !== 'in') { toast('Done. Sign in to keep activity results.'); navigate('/activities'); return; }
  const c: CheckIn = { id: crypto.randomUUID(), createdAt: Date.now(), measurement: null, activities: [r], score: null, feeling: null, tags: [], note: null, narration: null };
  await vault.put('checkin', c.id, c);
  toast(st.sync.online ? 'Activity saved.' : "Saved on this phone. It will sync when you're back online.");
  navigate('/activities');
}

export function ActivityRun({ id }: { id: string }) {
  const s = useApp();
  const a = ACTIVITIES.find((x) => x.id === id);
  if (!a) {
    return <RunFrame title="Activity"><div class="state"><h1>No such activity</h1><Link href="/activities" class="btn secondary">All activities</Link></div></RunFrame>;
  }
  const C = a.Component as unknown as (p: RunProps) => preact.VNode;
  return (
    <RunFrame title={a.name}>
      <C onDone={(r) => void saveActivity(r)} onCancel={() => navigate('/activities')} live={s.device?.conn} calmRuns={calmRuns(a.id)} />
    </RunFrame>
  );
}

export function SessionRun() {
  const s = useApp();
  return (
    <RunFrame title="Stress session">
      <StressSessionView live={s.device?.conn} calmRuns={calmRuns()} keepRawBeats={s.settings.keepRawBeats} onCancel={() => navigate('/activities')}
        onDone={async (x: StressSession, extras?: { restMeasurements: Measurement[] }) => {
          const st = getState();
          if (st.auth.state !== 'in') { toast('Done. Sign in to keep sessions.'); navigate('/activities'); return; }
          await vault.put('session', x.id, x);
          // A full rest phase is a baseline on its own (contract), if there is none yet.
          const rest = (extras?.restMeasurements ?? []).filter((m) => m.features.hr_mean != null && m.quality !== 'poor');
          if (!x.aborted && !baselineReady(st.baseline) && rest.length >= BASELINE_NEEDED) {
            const b = baselineFromRest(rest, crypto.randomUUID(), Date.now());
            await vault.put('baseline', b.id, b);
            toast('Session saved. Its rest phase set your baseline, so check-ins are scored from now on.');
          } else toast('Session saved.');
        }} />
    </RunFrame>
  );
}
