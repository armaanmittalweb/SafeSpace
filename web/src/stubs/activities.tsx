// STUB for web/src/activities/index.ts and web/src/session/index.ts (inputs agent): the eight activity
// definitions from the plan with a placeholder body, and a placeholder stress session, so the Activities
// tab can host them through the contract's shapes. The real components replace these in src/app/ports.ts.
import type { ActivityDef, ActivityProps, StressSessionProps } from '../contract/activities';

function Pending({ name, onCancel }: { name: string; onCancel(): void }) {
  return (
    <div class="pending-activity">
      <p class="lead">{name} is not in this build yet.</p>
      <p class="muted">It records timing and movement only, never which keys you press. It arrives with the activities update.</p>
      <button type="button" class="btn secondary" onClick={onCancel}>Back to activities</button>
    </div>
  );
}
const make = (d: Omit<ActivityDef, 'Component'>): ActivityDef => ({ ...d, Component: (p: ActivityProps) => <Pending name={d.name} onCancel={p.onCancel} /> });

export const ACTIVITIES: ActivityDef[] = [
  make({ id: 'typing', name: 'Typing check', job: 'baseline', durationS: 45, device: 'keyboard', blurb: 'Key timing, pauses and corrections, compared with your calm typing.' }),
  make({ id: 'follow-dot', name: 'Follow the dot', job: 'baseline', durationS: 30, device: 'pointer', blurb: 'Track a moving dot: distance off target and jerkiness.' }),
  make({ id: 'target-taps', name: 'Target taps', job: 'check-in', durationS: 40, device: 'pointer', blurb: 'Tap targets of different sizes: speed, accuracy, hesitation.' }),
  make({ id: 'steady-hand', name: 'Steady hand', job: 'check-in', durationS: 20, device: 'phone', blurb: 'Hold the phone still: tremor from the motion sensor.' }),
  make({ id: 'tap-rhythm', name: 'Tap the rhythm', job: 'check-in', durationS: 30, device: 'phone', blurb: 'Tap along to a steady beat: how much your timing drifts.' }),
  make({ id: 'stroop', name: 'Colour words', job: 'challenge', durationS: 120, device: 'any', blurb: 'Name the ink colour, not the word. Reaction time and errors.' }),
  make({ id: 'beat-the-clock', name: 'Beat the clock', job: 'challenge', durationS: 180, device: 'any', blurb: 'Mental arithmetic under a visible timer. Mild; stop at any time.' }),
  make({ id: 'paced-breathing', name: 'Paced breathing', job: 'recovery', durationS: 180, device: 'any', blurb: 'Six breaths a minute with a guide. With a strap, see your heart follow.' }),
];

export const SESSION_MINUTES = 10;
export function StressSessionView(p: StressSessionProps) {
  return <Pending name="The stress session" onCancel={p.onCancel} />;
}
