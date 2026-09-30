// The eight activities (contract: ACTIVITIES: ActivityDef[]). Each Component also takes the
// optional RunProps from ./kit (calmRuns, autoStart, showResult, durationS, embedded, seed).
import type { ActivityDef, ActivityId } from '../contract';
import type { Meta } from './kit';
import { BeatTheClock, clockMeta } from './cognitive/BeatTheClock';
import { Stroop, stroopMeta } from './cognitive/Stroop';
import { breathingMeta, PacedBreathing } from './body/PacedBreathing';
import { rhythmMeta, TapRhythm } from './body/TapRhythm';
import { SteadyHand, steadyMeta } from './body/SteadyHand';
import { FollowDot, followMeta } from './pointer/FollowDot';
import { TargetTaps, tapsMeta } from './pointer/TargetTaps';
import { Typing, typingMeta } from './typing/Typing';

const def = (m: Meta, Component: ActivityDef['Component']): ActivityDef => ({ ...m, Component });

export const ACTIVITIES: ActivityDef[] = [
  def(typingMeta, Typing),
  def(followMeta, FollowDot),
  def(tapsMeta, TargetTaps),
  def(steadyMeta, SteadyHand),
  def(rhythmMeta, TapRhythm),
  def(stroopMeta, Stroop),
  def(clockMeta, BeatTheClock),
  def(breathingMeta, PacedBreathing),
];

export const activityById = (id: ActivityId): ActivityDef => ACTIVITIES.find((a) => a.id === id)!;

export type { RunProps } from './kit';
export { ActivityPicker, type ActivityPickerProps } from './ActivityPicker';
export { changeSummary, changeWords, formatMetric, HEADLINE } from './labels';
export { vsCalm } from './stats';
