import { useMemo, useState } from 'preact/hooks';
import { fuseReadings, type Feature, type Signal } from '../model/score';
import { narrate } from '../narrate/templates';
import {
  DEFAULT_SCENARIO, fusedSeries, readSession, readWindow, simulate, windowAt, type Scenario,
} from '../sim/scenario';
import { prefersReducedMotion, usePlayback } from './usePlayback';

export const ALL_IN: Record<Signal, boolean> = { hr: true, eda: true, temp: true, hrv: true };

/** Everything the recorder needs, shared by the full page and /embed. */
export function useRecorder(initialT: number | null) {
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const [included, setIncluded] = useState<Record<Signal, boolean>>(ALL_IN);
  const [edits, setEdits] = useState<Partial<Record<Feature, number>> | null>(null);

  const session = useMemo(() => simulate(scenario), [scenario]);
  const readings = useMemo(() => readSession(session), [session]);
  const fused = useMemo(() => fusedSeries(readings, included), [readings, included]);

  const reduced = prefersReducedMotion();
  const pb = usePlayback(session.total, {
    t: initialT ?? (reduced ? session.total : 0),
    playing: initialT === null && !reduced,
  });

  const at = windowAt(session, pb.t);
  const win = at >= 0 ? session.windows[at] : null;
  const inCal = at < session.firstScored;
  const editedReadings = win && edits ? readWindow(win, session.calibration, edits) : null;
  const nowReadings = win ? editedReadings ?? readings[at] : null;
  const nowFused = nowReadings ? (editedReadings ? fuseReadings(editedReadings, included) : fused[at]) : null;
  const raw = win ? (edits ? { ...win.raw, ...edits } : win.raw) : null;

  const narration = useMemo(() => {
    if (!win || inCal || !nowReadings || !raw) return null;
    return narrate({ readings: nowReadings, fused: nowFused, raw, cal: session.calibration, motion: win.motion, included });
  }, [win, inCal, nowReadings, nowFused, raw, included, session]);

  return {
    scenario,
    setScenario: (s: Scenario) => { setEdits(null); setScenario(s); },
    session, readings, fused, included,
    toggle: (s: Signal) => setIncluded((x) => ({ ...x, [s]: !x[s] })),
    setIncluded,
    edits,
    setEdit: (f: Feature, v: number) => { pb.pause(); setEdits((e) => ({ ...(e ?? {}), [f]: v })); },
    clearEdits: () => setEdits(null),
    pb: {
      ...pb,
      play: () => { setEdits(null); pb.play(); },
      restart: () => { setEdits(null); pb.restart(); },
      seek: (t: number) => { setEdits(null); pb.seek(t); },
    },
    at, win, inCal, raw,
    now: { readings: nowReadings, fused: nowFused, edited: !!editedReadings },
    narration,
  };
}
