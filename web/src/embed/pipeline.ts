// Runs the scoring pipeline once, stage by stage, and times each stage in the browser.
// The Lab shows these as its pipeline strip.
import { calibrate, zScores } from '../model/calibrate';
import { fuseReadings, readSignal, SIGNALS, type ReadingSet, type Signal } from '../model/score';
import { copingTip, summarize, type Moment } from '../narrate/templates';
import { simulate, type Scenario } from '../sim/scenario';

export const STAGES = ['Signal windows', 'Feature extraction', 'Per-signal models', 'Score mapping', 'Narration', 'Coping tip'];

export interface StageResult { i: number; name: string; ms: number; ok: boolean }

export function runPipeline(scenario: Scenario, included: Record<Signal, boolean>): StageResult[] {
  const out: StageResult[] = [];
  let failed = false;
  const stage = <T,>(i: number, f: () => T): T | undefined => {
    if (failed) { out.push({ i, name: STAGES[i], ms: 0, ok: false }); return undefined; }
    const t0 = performance.now();
    try {
      const v = f();
      out.push({ i, name: STAGES[i], ms: performance.now() - t0, ok: true });
      return v;
    } catch {
      failed = true;
      out.push({ i, name: STAGES[i], ms: performance.now() - t0, ok: false });
      return undefined;
    }
  };

  const session = stage(0, () => simulate(scenario));
  const feats = stage(1, () => {
    const cal = calibrate(session!.windows.filter((w) => w.calibration).map((w) => w.raw));
    return { cal, z: session!.windows.map((w) => zScores(w.raw, cal)) };
  });
  const readings = stage(2, () => session!.windows.map((w, i) => {
    const r = {} as ReadingSet;
    for (const s of SIGNALS) r[s] = w.calibration || !w.valid[s] ? null : readSignal(s, feats!.z[i]);
    return r;
  }));
  const fused = stage(3, () => readings!.map((r) => fuseReadings(r, included)));
  const last = session ? session.windows.length - 1 : 0;
  const moment = (): Moment => ({
    readings: readings![last], fused: fused![last], raw: session!.windows[last].raw,
    cal: feats!.cal, motion: session!.windows[last].motion, included,
  });
  stage(4, () => summarize(moment()));
  stage(5, () => copingTip(moment()));
  return out;
}
