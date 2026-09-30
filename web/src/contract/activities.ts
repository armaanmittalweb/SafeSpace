// Activities, the stress session and the personal model: web/src/activities, web/src/session,
// web/src/personal (inputs agent). The app hosts them.
import type { VNode } from 'preact';
import type { LiveConnection } from './inputs';
import type { ActivityId, ActivityResult, PersonalModel, StressSession } from './records';

export type ActivityJob = 'baseline' | 'check-in' | 'challenge' | 'recovery';

export interface ActivityProps {
  onDone(r: ActivityResult): void;
  onCancel(): void;
  live?: LiveConnection;
}

export interface ActivityDef {
  id: ActivityId;
  name: string;
  job: ActivityJob;
  durationS: number;
  device: 'keyboard' | 'pointer' | 'phone' | 'any';
  Component: (props: ActivityProps) => VNode;
  /** Amendment (app agent): one line for the list, e.g. "Key timing and corrections, compared with your calm typing". */
  blurb?: string;
}
/** web/src/activities/index.ts exports `ACTIVITIES: ActivityDef[]`. */

export interface StressSessionProps {
  onDone(s: StressSession): void;
  onCancel(): void;
  live?: LiveConnection;
}
/** Amendment (app agent): web/src/session/index.ts exports `StressSessionView: (p: StressSessionProps) => VNode`
 * and `SESSION_MINUTES = 10`. */

/** Amendment (app agent): web/src/personal/index.ts exports
 * `train(activity: ActivityId, sessions: StressSession[]): PersonalModel | null` and
 * `scoreWith(model: PersonalModel, metrics: Record<string, number>): number` (a score in −1..+1). */
export type TrainFn = (activity: ActivityId, sessions: StressSession[]) => PersonalModel | null;
export type ScoreWithFn = (model: PersonalModel, metrics: Record<string, number>) => number;
