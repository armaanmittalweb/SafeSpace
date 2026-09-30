// One camera window → a contract Measurement. Beat features come from the shared signal/hrv module
// (artefact rejection, coverage); the camera then caps the quality with what it saw optically.
import type { Measurement } from '../contract/records';
import { measurementFromRR } from '../signal/hrv';
import { analyze, worst, type AnalyzeOptions, type Frame, type Analysis } from './ppg';

export interface CameraMeta { device: string | null; startedAt: number; durationS: number; keepBeats?: boolean }

export function measurementFromFrames(frames: readonly Frame[], opts: AnalyzeOptions, meta: CameraMeta): { m: Measurement; a: Analysis } {
  const a = analyze(frames, opts);
  return { m: measurementFromAnalysis(a, opts, meta), a };
}

export function measurementFromAnalysis(a: Analysis, opts: AnalyzeOptions, meta: CameraMeta): Measurement {
  const accStd = opts.motion && opts.motion.length > 4 ? sdOf(opts.motion.map((s) => s.a)) : null;
  const m = measurementFromRR(a.rr, {
    source: 'camera', device: meta.device, startedAt: meta.startedAt, durationS: meta.durationS,
    accStd, motionFlagged: a.motionFrac > 0.1,
  });
  // Stored beats never carry the NaN break markers (JSON has no NaN).
  if (meta.keepBeats) m.beats = { t0: a.beats[0] ?? meta.startedAt, rr: a.rr.filter(Number.isFinite) };
  m.quality = worst(m.quality, a.quality);
  if (m.motion) m.motion.flagged = a.motionFrac > 0.1;
  else m.motion = { flagged: a.motionFrac > 0.1, accStd };
  return m;
}

function sdOf(xs: number[]): number {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length - 1));
}
