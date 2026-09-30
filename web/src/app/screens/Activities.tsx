import type { ActivityDef, ActivityJob } from '../../contract/activities';
import type { ActivityResult, CheckIn, StressSession } from '../../contract/records';
import { IconBack, IconChevron } from '../icons';
import { ACTIVITIES, SESSION_MINUTES, StressSessionView } from '../ports';
import { Link, navigate } from '../router';
import { getState, toast, useApp } from '../store';
import { vault } from '../vault';

const JOBS: { job: ActivityJob; title: string; blurb: string }[] = [
  { job: 'baseline', title: 'Set your baseline', blurb: 'Do these when you feel calm, so later runs have something to compare with.' },
  { job: 'check-in', title: 'Check in', blurb: 'Quick reads of how your hands and timing are doing right now.' },
  { job: 'challenge', title: 'Challenge', blurb: 'Mild, opt-in pressure, stoppable at any time. No comparison with anyone else.' },
  { job: 'recovery', title: 'Recover', blurb: 'Bring yourself back down.' },
];
const DEVICE: Record<ActivityDef['device'], string> = { keyboard: 'Keyboard', pointer: 'Mouse or finger', phone: 'Phone', any: 'Any device' };
const len = (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`);

export function Activities() {
  const s = useApp();
  const signedIn = s.auth.state === 'in';
  return (
    <div class="page">
      <header class="page-head">
        <h1>Activities</h1>
        <p class="lead">Short tasks that read your typing, pointing and timing. Only timing and movement are recorded, never which keys you press.</p>
      </header>
      {!signedIn && <p class="notice">You can try any activity without an account. Results are not saved.</p>}
      <Link href="/activities/session" class="card card-link session-card">
        <div class="card-head"><span class="kicker">Stress session</span><span class="kicker">{SESSION_MINUTES} min</span></div>
        <h2 class="card-title">Rest, a small challenge, then recovery</h2>
        <div class="phase-bar" aria-hidden="true"><span style={{ flex: 3 }}>Rest 3</span><span class="hot" style={{ flex: 4 }}>Challenge 4</span><span style={{ flex: 3 }}>Recover 3</span></div>
        <p class="muted">Shows how far your heart rate rises under mild pressure and how fast it comes back. Best with a heart-rate strap or the camera.</p>
        <IconChevron class="card-chev" />
      </Link>
      <div class="job-grid">
        {JOBS.map(({ job, title, blurb }) => {
          const list = ACTIVITIES.filter((a) => a.job === job);
          if (!list.length) return null;
          return (
            <section class="job" aria-labelledby={`job-${job}`}>
              <h2 id={`job-${job}`} class="section-title">{title}</h2>
              <p class="muted small">{blurb}</p>
              <ul class="card list-card">
                {list.map((a) => (
                  <li><Link href={`/activities/${a.id}`} class="lrow">
                    <span class="lrow-main"><b>{a.name}</b>{a.blurb && <small>{a.blurb}</small>}</span>
                    <span class="lrow-meta"><span class="mono">{len(a.durationS)}</span><small>{DEVICE[a.device]}</small></span>
                    <IconChevron class="chev" size={18} />
                  </Link></li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function RunFrame({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="flow-body">
      <header class="flow-bar">
        <Link href="/activities" class="icon-btn" aria-label="Back to activities"><IconBack /></Link>
        <span class="flow-title">{title}</span>
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
  const C = a.Component;
  return (
    <RunFrame title={a.name}>
      <C onDone={(r) => void saveActivity(r)} onCancel={() => navigate('/activities')} live={s.device?.conn} />
    </RunFrame>
  );
}

export function SessionRun() {
  const s = useApp();
  return (
    <RunFrame title="Stress session">
      <StressSessionView live={s.device?.conn} onCancel={() => navigate('/activities')} onDone={async (x: StressSession) => {
        if (getState().auth.state === 'in') { await vault.put('session', x.id, x); toast('Session saved.'); }
        navigate('/activities');
      }} />
    </RunFrame>
  );
}
