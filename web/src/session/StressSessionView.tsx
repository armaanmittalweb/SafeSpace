// The 10-minute stress session: rest, a mild challenge, recovery, with whatever is connected
// drawn live on one chart, a Stop button always on screen, and a plain-language summary.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { ActivityId, ActivityResult, Beat, InputSource, LiveConnection, Measurement, StressSession, StressSessionProps } from '../contract';
import { activityById } from '../activities';
import { fmtClock, useCountdown, type RunProps } from '../activities/kit';
import '../activities/kit.css';
import { changeWords, formatMetric, HEADLINE } from '../activities/labels';
import {
  restMeasurements, sessionPlan, sessionSeries, summaryNumbers, summaryText, type PhaseName, type Probe, type Step,
} from './summary';
import './session.css';

export interface SessionExtras {
  /** 60-s windows from the settled part of rest: readings for the physiological Baseline. */
  restMeasurements: Measurement[];
}
export interface StressSessionViewProps extends StressSessionProps {
  /** Contract onDone, plus the rest-phase measurements as a second argument. */
  onDone(s: StressSession, extras?: SessionExtras): void;
  /** The short task done at rest and under challenge (the personal model learns from it). Default: chosen on the intro. */
  probe?: Probe;
  calmRuns?: ActivityResult[];
  keepRawBeats?: boolean;
  /** Shrinks every step (tests, screenshots). */
  timeScale?: number;
  /** Start straight at a step (playground screenshots). */
  startAt?: number;
}

const PHASES: { name: PhaseName; label: string; mins: number }[] = [
  { name: 'rest', label: 'Rest', mins: 3 }, { name: 'challenge', label: 'Challenge', mins: 4 }, { name: 'recovery', label: 'Recovery', mins: 3 },
];
const STEP_NAME: Record<Step['kind'], string> = {
  sit: 'Sit and rest', typing: 'Typing check', 'follow-dot': 'Follow the dot', 'target-taps': 'Target taps', stroop: 'Colour words',
  'beat-the-clock': 'Beat the clock', 'paced-breathing': 'Paced breathing', 'steady-hand': 'Steady hand', 'tap-rhythm': 'Tap the rhythm',
};

function useSessionBeats(live: LiveConnection | undefined, on: boolean) {
  const buf = useRef<Beat[]>([]);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!live || !on) return;
    return live.onBeat((b) => { buf.current.push(b); bump((n) => n + 1); });
  }, [live, on]);
  return buf.current;
}

/** Heart rate across the whole session on the phase bands. */
function useWidth(fallback: number) {
  const ref = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { const x = Math.round(e.contentRect.width); if (x > 0) setW(x); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function SessionChart(p: { beats: readonly Beat[]; startedAt: number; totalS: number; bounds: { name: PhaseName; from: number; to: number }[]; restHr?: number | null; nowS?: number }) {
  // Drawn at the element's real width so labels stay at their CSS pixel size on phones.
  const [ref, W] = useWidth(600);
  const H = W < 480 ? 150 : 180, top = 22, bottom = H - 20, left = 30;
  const x = (s: number) => left + (Math.max(0, Math.min(s, p.totalS)) / p.totalS) * (W - left - 4);
  const pts = p.beats.map((b) => ({ s: (b.t - p.startedAt) / 1000, v: b.rr ? 60000 / b.rr : b.hr })).filter((q) => q.s >= 0 && q.v > 30 && q.v < 220);
  // 5-s smoothing so the line reads as a trend, not beat noise.
  const sm: { s: number; v: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const w = pts.filter((q) => q.s > pts[i].s - 5 && q.s <= pts[i].s);
    if (i % 2 === 0 || i === pts.length - 1) sm.push({ s: pts[i].s, v: w.reduce((a, q) => a + q.v, 0) / w.length });
  }
  const vals = sm.map((q) => q.v);
  const lo = vals.length ? Math.floor((Math.min(...vals) - 4) / 5) * 5 : 60;
  const hi = vals.length ? Math.ceil((Math.max(...vals) + 4) / 5) * 5 : 100;
  const y = (v: number) => bottom - ((v - lo) / Math.max(hi - lo, 10)) * (bottom - top);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const line = sm.map((q) => `${x(q.s).toFixed(1)},${y(q.v).toFixed(1)}`).join(' ');
  return (
    <svg ref={ref} class="ss-chart" viewBox={`0 0 ${W} ${H}`} style={{ height: `${H}px` }} role="img"
      aria-label={vals.length ? `Heart rate through the session, from ${Math.round(Math.min(...vals))} to ${Math.round(Math.max(...vals))} beats per minute` : 'Session timeline. No heart-rate device connected.'}>
      {p.bounds.map((b) => (
        <g key={b.name}>
          <rect x={x(b.from)} y={top - 4} width={Math.max(0, x(b.to) - x(b.from))} height={bottom - top + 4} class={`ss-band ${b.name}`} />
          <text x={x(b.from) + 4} y={top - 8} class="ss-lbl">{b.name}</text>
        </g>
      ))}
      {vals.length > 0 && ticks.map((t) => (
        <g key={t}><line x1={left} x2={W - 4} y1={y(t)} y2={y(t)} class="ss-grid" /><text x={left - 6} y={y(t) + 3} text-anchor="end" class="ss-lbl">{t}</text></g>
      ))}
      {p.restHr != null && vals.length > 0 && <line x1={left} x2={W - 4} y1={y(p.restHr)} y2={y(p.restHr)} class="ss-rest" />}
      {line && <polyline points={line} class="ss-hr" />}
      {p.nowS != null && <line x1={x(p.nowS)} x2={x(p.nowS)} y1={top - 4} y2={bottom} class="ss-now" />}
      {!vals.length && <text x={(W + left) / 2} y={(top + bottom) / 2 + 4} text-anchor="middle" class="ss-empty">No heart-rate device connected</text>}
      <text x={W - 4} y={H - 2} text-anchor="end" class="ss-lbl">{Math.round(p.totalS / 60)} min{vals.length ? ' · bpm' : ''}</text>
    </svg>
  );
}

function Sit(p: { durationS: number; onEnd: () => void; live?: LiveConnection }) {
  const { left } = useCountdown(true, p.durationS, p.onEnd);
  return (
    <div class="ss-sit">
      <p class="ss-sit-big">Sit comfortably and breathe normally.</p>
      <p class="ax-small">Feet flat, hands still. {p.live ? 'Your resting heart rate is being recorded.' : 'This minute or two of quiet is part of the comparison.'} The next part starts on its own in <span class="ax-mono">{fmtClock(left)}</span>.</p>
    </div>
  );
}

export function phaseBounds(plan: Step[]) {
  return PHASES.map((ph) => {
    const idx = plan.map((s, i) => (s.phase === ph.name ? i : -1)).filter((i) => i >= 0);
    const from = plan.slice(0, idx[0]).reduce((a, s) => a + s.durationS, 0);
    return { name: ph.name, from, to: from + idx.reduce((a, i) => a + plan[i].durationS, 0) };
  });
}

/** The result screen of a session (also used by History to show a saved one). */
export function SessionSummary(p: { session: StressSession; beats: readonly Beat[]; totalS?: number; bounds?: { name: PhaseName; from: number; to: number }[]; onSave?: () => void; onDiscard?: () => void }) {
  const { session } = p;
  const totalS = p.totalS ?? 600;
  const bounds = p.bounds ?? phaseBounds(sessionPlan('follow-dot'));
  const n = summaryNumbers(session);
  const acts = session.phases.flatMap((ph) => ph.activities.map((a) => ({ ph: ph.name, a })));
  const endedAt = session.phases.length ? session.phases[session.phases.length - 1].endedAt : session.createdAt;
  // A saved session has no beats: draw its 5-s series instead.
  const beats: readonly Beat[] = p.beats.length ? p.beats : (session.series?.hr ?? []).map(([t, v]) => ({ t: session.createdAt + t * 1000, rr: null, hr: v }));
  return (
    <section class="ax ax-sheet" aria-labelledby="ss-done">
      <div>
        <p class="ax-kicker">{session.aborted ? 'Stopped early' : 'Finished'} · {fmtClock((endedAt - session.createdAt) / 1000)}</p>
        <h2 class="ax-title" id="ss-done">Stress session</h2>
      </div>
      <SessionChart beats={beats} startedAt={session.createdAt} totalS={totalS} bounds={bounds} restHr={n.restHr} />
      {session.series && (
        <dl class="ss-stats">
          <div><dt>Resting</dt><dd class="ax-mono">{n.restHr != null ? Math.round(n.restHr) : '–'}<small>bpm</small></dd></div>
          <div><dt>Challenge</dt><dd class="ax-mono">{n.hrRise != null ? `${n.hrRise >= 0 ? '+' : '−'}${Math.abs(Math.round(n.hrRise))}` : '–'}<small>bpm</small></dd></div>
          <div><dt>Back halfway</dt><dd class="ax-mono">{n.recoveryHalfTimeS != null ? n.recoveryHalfTimeS : '–'}<small>{n.recoveryHalfTimeS != null ? 's' : ''}</small></dd></div>
        </dl>
      )}
      <p class="ss-text">{session.summary.text}</p>
      {acts.length > 0 && (
        <div class="ss-acts">
          <h3 class="ax-kicker">Tasks</h3>
          <ul>
            {acts.map(({ ph, a }, i) => {
              const l = HEADLINE[a.activity].find((m) => Number.isFinite(a.metrics[m.key]));
              const w = l && changeWords(l, a.vsBaseline?.[l.key]);
              return (
                <li key={i}>
                  <span><b>{activityById(a.activity).name}</b><span class="ax-small"> · {ph}</span></span>
                  {l && <span class="ss-act-m">{l.label} <b class="ax-mono">{formatMetric(l, a.metrics[l.key])}</b>{l.unit ? ` ${l.unit}` : ''}{w ? ` · ${w.toLowerCase()}` : ''}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p class="ax-small">Not a medical device. Patterns in your own data, not a diagnosis.</p>
      {(p.onSave || p.onDiscard) && (
        <div class="ax-actions">
          {p.onSave && <button type="button" class="ax-btn primary" onClick={p.onSave}>Save session</button>}
          {p.onDiscard && <button type="button" class="ax-btn quiet" onClick={p.onDiscard}>Discard</button>}
        </div>
      )}
    </section>
  );
}

export function StressSessionView(p: StressSessionViewProps) {
  const [probe, setProbe] = useState<Probe>(p.probe === undefined ? 'follow-dot' : p.probe);
  const plan = sessionPlan(probe, p.timeScale ?? 1);
  const totalS = plan.reduce((a, s) => a + s.durationS, 0);
  const [stage, setStage] = useState<'intro' | 'run' | 'summary'>(p.startAt != null ? 'run' : 'intro');
  const [step, setStep] = useState(p.startAt ?? 0);
  const startedAt = useRef(Date.now());
  const stepStarts = useRef<number[]>(p.startAt != null ? plan.slice(0, p.startAt + 1).map(() => Date.now()) : []);
  const results = useRef<{ step: number; r: ActivityResult }[]>([]);
  const [session, setSession] = useState<StressSession | null>(null);
  const [, tick] = useState(0);
  const beats = useSessionBeats(p.live, stage === 'run');
  useEffect(() => {
    if (stage !== 'run') return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [stage]);

  const begin = () => {
    startedAt.current = Date.now();
    stepStarts.current = [Date.now()];
    results.current = [];
    setStep(0);
    setStage('run');
  };
  const finish = (wasAborted: boolean, upTo: number) => {
    const end = Date.now();
    const starts = [...stepStarts.current, end];
    const phases: StressSession['phases'] = [];
    for (const ph of PHASES) {
      const idx = plan.map((s, i) => (s.phase === ph.name && i <= upTo ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      phases.push({
        name: ph.name, startedAt: starts[idx[0]], endedAt: starts[Math.min(idx[idx.length - 1] + 1, starts.length - 1)],
        activities: results.current.filter((x) => idx.includes(x.step)).map((x) => x.r),
      });
    }
    const source = (p.live as { source?: InputSource } | undefined)?.source ?? 'ble-hr';
    const series = p.live ? sessionSeries(beats, startedAt.current, source) : null;
    const draft = { phases, series, aborted: wasAborted };
    const n = summaryNumbers(draft);
    const s: StressSession = {
      id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s-${Date.now()}`,
      createdAt: startedAt.current, phases, series, aborted: wasAborted,
      summary: { hrRise: n.hrRise, recoveryHalfTimeS: n.recoveryHalfTimeS, text: summaryText(n, draft, p.live?.device ?? null) },
    };
    setSession(s);
    setStage('summary');
  };
  const next = (r?: ActivityResult) => {
    if (r) results.current.push({ step, r });
    if (step + 1 >= plan.length) { finish(false, step); return; }
    stepStarts.current.push(Date.now());
    setStep(step + 1);
  };

  if (stage === 'intro') {
    return (
      <section class="ax ax-sheet" aria-labelledby="ss-title">
        <div>
          <p class="ax-kicker">10 min · Rest, challenge, recovery</p>
          <h2 class="ax-title" id="ss-title">Stress session</h2>
        </div>
        <p class="ax-lead">The same shape as the lab studies the models came from, at your desk: three minutes of rest, four minutes of mild challenge, then three minutes of paced breathing. It shows how your body responds and how quickly it comes back down.</p>
        <ol class="ss-steps">
          {PHASES.map((ph) => (
            <li key={ph.name}>
              <span class="ax-mono">{ph.mins} min</span>
              <b>{ph.label}</b>
              <span>{ph.name === 'rest' ? 'Sit quietly' + (probe ? ', then a 30-second task' : '') : ph.name === 'challenge' ? 'Colour words' + (probe ? ', the short task again' : '') + ', then Beat the clock' : 'Paced breathing, six breaths a minute'}</span>
            </li>
          ))}
        </ol>
        <fieldset class="ss-probe">
          <legend class="ax-kicker">Short task at rest and under challenge</legend>
          {([['follow-dot', 'Follow the dot'], ['typing', 'Typing check'], [null, 'None']] as [Probe, string][]).map(([v, l]) => (
            <label key={String(v)}><input type="radio" name="ss-probe" checked={probe === v} onChange={() => setProbe(v)} />{l}</label>
          ))}
          <p class="ax-small">Doing the same task calm and under pressure is how SafeSpace learns your own keyboard and mouse pattern.</p>
        </fieldset>
        <p class={p.live ? 'ax-small' : 'ax-note'}>
          {p.live ? `Heart rate from ${p.live.device} is recorded throughout.` : 'No heart-rate device is connected, so only the tasks are measured. Connect a strap in Devices to see your heart rate respond.'}
          {' '}The challenge is mild and you can stop at any time.
        </p>
        <div class="ax-actions">
          <button type="button" class="ax-btn primary" onClick={begin}>Start the session</button>
          <button type="button" class="ax-btn quiet" onClick={p.onCancel}>Not now</button>
        </div>
      </section>
    );
  }

  const bounds = phaseBounds(plan);

  if (stage === 'summary' && session) {
    const save = () => p.onDone(session, { restMeasurements: p.live ? restMeasurements(beats, session, { source: session.series?.source ?? 'ble-hr', device: p.live.device, keepBeats: p.keepRawBeats }) : [] });
    return <SessionSummary session={session} beats={beats} totalS={totalS} bounds={bounds} onSave={save} onDiscard={p.onCancel} />;
  }

  // running
  const cur = plan[step];
  const elapsedS = (Date.now() - startedAt.current) / 1000;
  const planned = plan.slice(0, step).reduce((a, s) => a + s.durationS, 0);
  const phaseIdx = PHASES.findIndex((ph) => ph.name === cur.phase);
  const lastBeat = beats[beats.length - 1];
  const common: RunProps = {
    autoStart: true, showResult: false, embedded: true, durationS: cur.durationS, live: p.live, calmRuns: p.calmRuns,
    onDone: (r) => next(r), onCancel: () => next(),
  };
  const Comp = cur.kind === 'sit' ? null : (activityById(cur.kind as ActivityId).Component as (x: RunProps) => VNode);
  return (
    <section class="ax ax-sheet ss-run" aria-labelledby="ss-step">
      <div class="ax-head">
        <div class="ax-headtext">
          <span class="ax-kicker">Stress session · {PHASES[phaseIdx].label}</span>
          <span class="ax-name" id="ss-step">{STEP_NAME[cur.kind]}</span>
        </div>
        {p.live && <span class="ss-hr-now" aria-label="Heart rate"><span class="ax-mono">{lastBeat ? lastBeat.hr : '–'}</span><small>bpm</small></span>}
        <button type="button" class="ax-btn stop" onClick={() => finish(true, step)}>Stop</button>
      </div>
      <ol class="ss-phases" aria-label="Session progress">
        {bounds.map((b, i) => {
          const frac = Math.max(0, Math.min(1, (Math.min(elapsedS, planned + cur.durationS) - b.from) / (b.to - b.from)));
          return (
            <li key={b.name} style={{ flex: b.to - b.from }} class={i === phaseIdx ? 'now' : ''} aria-current={i === phaseIdx ? 'step' : undefined}>
              <i><b style={{ transform: `scaleX(${i < phaseIdx ? 1 : i > phaseIdx ? 0 : frac})` }} /></i>
              <span>{PHASES[i].label}</span>
            </li>
          );
        })}
      </ol>
      {cur.kind === 'sit' ? (
        <Sit key={step} durationS={cur.durationS} onEnd={() => next()} live={p.live} />
      ) : (
        Comp && <Comp key={step} {...common} />
      )}
      {p.live && <SessionChart beats={beats} startedAt={startedAt.current} totalS={totalS} bounds={bounds} nowS={elapsedS} />}
    </section>
  );
}
