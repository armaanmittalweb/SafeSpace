// Plain-language labels for the headline metrics of each activity, and the words used for
// "change from your calm runs". Shared by the result screens, the app's history and the
// narration facts (NarrationFacts.activities[].change).
import type { ActivityId, ActivityResult } from '../contract';

export interface MetricLabel {
  key: string;
  label: string;
  unit: string;
  /** Decimal places shown. */
  dp: number;
  /** Words for a higher and a lower value than usual. */
  up: string;
  down: string;
  /** Multiply the stored value before showing (e.g. 0.083 -> 8.3 %). */
  scale?: number;
}

const m = (key: string, label: string, unit: string, dp: number, up: string, down: string, scale?: number): MetricLabel => ({ key, label, unit, dp, up, down, scale });

export const HEADLINE: Record<ActivityId, MetricLabel[]> = {
  typing: [
    m('wpm', 'Typing speed', 'wpm', 0, 'faster', 'slower'),
    m('holdMeanMs', 'Key hold', 'ms', 0, 'longer holds', 'shorter holds'),
    m('interKeyCv', 'Rhythm unevenness', '%', 0, 'more uneven', 'more even', 100),
    m('corrections', 'Corrections', '', 0, 'more corrections', 'fewer corrections'),
  ],
  'follow-dot': [
    m('meanErrorPct', 'Distance off the dot', '% of box', 1, 'further off', 'closer'),
    m('onTargetPct', 'Time on the dot', '%', 0, 'more time on', 'less time on'),
    m('overCorrectionsPerMin', 'Over-corrections', 'per min', 0, 'more over-correcting', 'less over-correcting'),
  ],
  'target-taps': [
    m('accuracyPct', 'Hits', '%', 0, 'more accurate', 'less accurate'),
    m('timeToTapMs', 'Time to tap', 'ms', 0, 'slower', 'quicker'),
    m('hesitationMs', 'Pause before clicking', 'ms', 0, 'more hesitant', 'less hesitant'),
    m('overshootPct', 'Overshoots', '%', 0, 'more overshooting', 'less overshooting'),
  ],
  stroop: [
    m('rtCongruentMs', 'Matching words', 'ms', 0, 'slower', 'quicker'),
    m('rtIncongruentMs', 'Mismatched words', 'ms', 0, 'slower', 'quicker'),
    m('interferenceMs', 'Slowdown from the mismatch', 'ms', 0, 'more thrown by the mismatch', 'less thrown by the mismatch'),
    m('errorRate', 'Errors', '%', 0, 'more errors', 'fewer errors', 100),
  ],
  'beat-the-clock': [
    m('problems', 'Problems answered', '', 0, 'more answered', 'fewer answered'),
    m('accuracy', 'Right', '%', 0, 'more right', 'fewer right', 100),
    m('meanLevel', 'Average level', 'of 10', 1, 'harder level', 'easier level'),
    m('meanRtMs', 'Time per right answer', 's', 1, 'slower', 'quicker', 0.001),
  ],
  'paced-breathing': [
    m('breaths', 'Guided breaths', '', 0, 'more breaths', 'fewer breaths'),
    m('rsaBpm', 'Heart-rate swing per breath', 'bpm', 1, 'bigger swing', 'smaller swing'),
    m('hrChange', 'Heart rate, start to end', 'bpm', 0, 'rose more', 'fell more'),
  ],
  'steady-hand': [
    m('rms', 'Tremor', 'm/s²', 2, 'shakier', 'steadier'),
    m('peakHz', 'Main tremor frequency', 'Hz', 1, 'faster tremor', 'slower tremor'),
  ],
  'tap-rhythm': [
    m('asyncMeanMs', 'Timing against the beat', 'ms', 0, 'later', 'earlier'),
    m('intervalCv', 'Tap unevenness', '%', 1, 'more uneven', 'more even', 100),
    m('driftMsPerTap', 'Drift on your own', 'ms/tap', 1, 'slowing down', 'speeding up'),
  ],
};

export function formatMetric(l: MetricLabel, v: number): string {
  const x = v * (l.scale ?? 1);
  const s = Math.abs(x) >= 1000 && l.dp === 0 ? Math.round(x).toLocaleString('en-GB') : x.toFixed(l.dp);
  return s.replace('-', '−');
}

/**
 * Words for a z against calm runs: under 1 SD is "about usual"; 1-2 "a little <word>";
 * 2+ "<word>" (plain). Returns null when there is no comparison.
 */
export function changeWords(l: MetricLabel, z: number | undefined): string | null {
  if (z == null || !Number.isFinite(z)) return null;
  const a = Math.abs(z);
  if (a < 1) return 'About your usual';
  const w = z > 0 ? l.up : l.down;
  const cap = w[0].toUpperCase() + w.slice(1);
  return a < 2 ? `A little ${w} than usual` : `${cap} than usual`;
}

/** One short phrase for narration: the two biggest changes, e.g. "slower, more corrections". */
export function changeSummary(r: ActivityResult): string {
  if (!r.vsBaseline) return 'no calm runs to compare with yet';
  const ls = HEADLINE[r.activity].filter((l) => Number.isFinite(r.vsBaseline![l.key]));
  const big = ls.map((l) => ({ l, z: r.vsBaseline![l.key] })).filter((x) => Math.abs(x.z) >= 1).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 2);
  if (!big.length) return 'about usual';
  return big.map((x) => (x.z > 0 ? x.l.up : x.l.down)).join(', ');
}
