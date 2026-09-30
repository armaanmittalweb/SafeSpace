// The Activities screen body: the stress session first, then the eight activities grouped
// by job, with length and device. The app shell mounts it and routes on onPick.
import type { ActivityDef, ActivityResult } from '../contract';
import { ACTIVITIES } from './index';
import { DEVICE_LABEL, fmtLength, JOB_LABEL } from './kit';
import './kit.css';
import './picker.css';

export interface ActivityPickerProps {
  onPick(a: ActivityDef): void;
  /** Shown as the first row when given. */
  onSession?(): void;
  /** Completed calm runs, to show "2 calm runs" per activity. */
  calmRuns?: ActivityResult[];
  /** Whether this browser is a phone (touch + motion); phone-only rows say so when false. */
  isPhone?: boolean;
  /** Name of the connected heart-rate device, if any (mentioned on the session and breathing rows). */
  liveDevice?: string | null;
}

const JOBS: ActivityDef['job'][] = ['baseline', 'check-in', 'challenge', 'recovery'];
const JOB_NOTE: Record<ActivityDef['job'], string> = {
  baseline: 'Do these when you are calm. They become the reference your later runs are compared with.',
  'check-in': 'Quick measures to add to a check-in.',
  challenge: 'Mild, opt-in pressure. Stop whenever you like.',
  recovery: 'For coming back down.',
};

const Chevron = () => (
  <svg class="ap-chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
);

export function ActivityPicker(p: ActivityPickerProps) {
  const runs = (id: string) => (p.calmRuns ?? []).filter((r) => r.activity === id && r.completed).length;
  return (
    <div class="ax ap">
      {p.onSession && (
        <button type="button" class="ap-session" onClick={p.onSession}>
          <span class="ap-sess-text">
            <span class="ax-kicker">10 min · Rest, challenge, recovery</span>
            <span class="ap-sess-title">Stress session</span>
            <span class="ap-sess-body">
              Three minutes of rest, four of mild challenge, three of paced breathing.
              {p.liveDevice ? ` Your heart rate from ${p.liveDevice} is drawn throughout.` : ' Connect a heart-rate device first to see your body respond.'}
            </span>
          </span>
          <svg class="ap-phases" viewBox="0 0 100 10" aria-hidden="true" preserveAspectRatio="none">
            <rect x="0" y="3" width="29.5" height="4" class="rest" />
            <rect x="30.5" y="3" width="39" height="4" class="challenge" />
            <rect x="70.5" y="3" width="29.5" height="4" class="rest" />
          </svg>
          <Chevron />
        </button>
      )}
      {JOBS.map((job) => {
        const items = ACTIVITIES.filter((a) => a.job === job);
        return (
          <section class="ap-group" key={job} aria-labelledby={`ap-${job}`}>
            <div class="ap-group-head">
              <h2 id={`ap-${job}`} class="ax-kicker">{JOB_LABEL[job]}</h2>
              <p class="ax-small">{JOB_NOTE[job]}</p>
            </div>
            <ul class="ap-list">
              {items.map((a) => {
                const needsPhone = a.device === 'phone' && p.isPhone === false;
                const n = runs(a.id);
                return (
                  <li key={a.id}>
                    <button type="button" class="ap-row" onClick={() => p.onPick(a)} aria-describedby={`ap-${a.id}-meta`}>
                      <span class="ap-main">
                        <span class="ap-name">{a.name}</span>
                        <span class="ap-blurb">{a.blurb}</span>
                      </span>
                      <span class="ap-meta" id={`ap-${a.id}-meta`}>
                        <span class="ax-mono">{fmtLength(a.durationS)}</span>
                        <span>{needsPhone ? 'Needs a phone' : DEVICE_LABEL[a.device]}</span>
                        {n > 0 && <span>{n} calm {n === 1 ? 'run' : 'runs'}</span>}
                      </span>
                      <Chevron />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
