// The frame every activity uses: intro -> running -> result, with a Stop button that is
// always on screen while running. Activities supply the stage and their metrics.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ActivityDef, ActivityId, ActivityProps, ActivityResult } from '../contract';
import './kit.css';
import { changeWords, formatMetric, HEADLINE } from './labels';
import { vsCalm, MIN_CALM_RUNS } from './stats';

/** Props every activity takes: the contract's plus a few optional ones hosts may pass. */
export interface RunProps extends ActivityProps {
  /** The user's calm runs of this activity; the result's vsBaseline is computed from them. */
  calmRuns?: ActivityResult[];
  /** Skip the intro (the stress session starts activities itself). */
  autoStart?: boolean;
  /** false: call onDone as soon as the run ends instead of showing the result screen. */
  showResult?: boolean;
  /** Override the length (the stress session shortens some). */
  durationS?: number;
  /** Hide the activity's own header (the host shows its own clock and Stop). */
  embedded?: boolean;
  /** Seed for paths, trials and passages (tests and screenshots use a fixed one). */
  seed?: number;
}

export type Meta = Pick<ActivityDef, 'id' | 'name' | 'job' | 'durationS' | 'device'> & { blurb: string };

export const JOB_LABEL: Record<ActivityDef['job'], string> = {
  baseline: 'Baseline', 'check-in': 'Check-in', challenge: 'Challenge', recovery: 'Recovery',
};
export const DEVICE_LABEL: Record<ActivityDef['device'], string> = {
  keyboard: 'Keyboard', pointer: 'Mouse or finger', phone: 'Phone', any: 'Any device',
};

export function fmtClock(s: number): string {
  const x = Math.max(0, Math.ceil(s));
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
}
export function fmtLength(s: number): string {
  return s < 60 ? `${s} s` : s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

export function useReducedMotion(): boolean {
  const [r, setR] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const f = () => setR(q.matches);
    q.addEventListener('change', f);
    return () => q.removeEventListener('change', f);
  }, []);
  return r;
}

/** Calls cb on every animation frame while `on`, with ms since it started. */
export function useFrames(on: boolean, cb: (elapsedMs: number, now: number) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!on) return;
    const t0 = performance.now();
    let id = 0;
    const tick = (now: number) => { ref.current(now - t0, now); id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [on]);
}

/** Seconds left, updated 4 times a second; calls onEnd once at zero. */
export function useCountdown(on: boolean, durationS: number, onEnd: () => void): { left: number; elapsed: number } {
  const [elapsed, setElapsed] = useState(0);
  const end = useRef(onEnd);
  end.current = onEnd;
  useEffect(() => {
    if (!on) return;
    const t0 = Date.now();
    setElapsed(0);
    let done = false;
    const id = setInterval(() => {
      const e = (Date.now() - t0) / 1000;
      setElapsed(e);
      if (!done && e >= durationS) { done = true; clearInterval(id); end.current(); }
    }, 250);
    return () => clearInterval(id);
  }, [on, durationS]);
  return { left: Math.max(0, durationS - elapsed), elapsed };
}

export function makeResult(id: ActivityId, startedAt: number, completed: boolean, metrics: Record<string, number>, calmRuns?: ActivityResult[]): ActivityResult {
  return {
    activity: id,
    startedAt,
    durationS: Math.round((Date.now() - startedAt) / 100) / 10,
    completed,
    metrics,
    vsBaseline: vsCalm(metrics, calmRuns, id),
  };
}

// ---------- pieces ----------

export function Intro(p: {
  meta: Meta; lengthS: number; lead: ComponentChildren; measures: string; keeps?: string; needs?: string;
  preview?: ComponentChildren; startLabel?: string; onStart: () => void; onCancel: () => void; startDisabled?: boolean; extra?: ComponentChildren;
}) {
  return (
    <section class="ax ax-sheet" aria-labelledby={`ax-${p.meta.id}-title`}>
      <div>
        <p class="ax-kicker">{JOB_LABEL[p.meta.job]} · {fmtLength(p.lengthS)} · {DEVICE_LABEL[p.meta.device]}</p>
        <h2 class="ax-title" id={`ax-${p.meta.id}-title`}>{p.meta.name}</h2>
      </div>
      <p class="ax-lead">{p.lead}</p>
      {p.preview}
      <dl class="ax-facts">
        <dt>Measures</dt><dd>{p.measures}</dd>
        <dt>Keeps</dt><dd>{p.keeps ?? 'Timing and movement inside the box only.'}</dd>
        {p.needs && <><dt>Needs</dt><dd>{p.needs}</dd></>}
      </dl>
      {p.extra}
      <div class="ax-actions">
        <button type="button" class="ax-btn primary" onClick={p.onStart} disabled={p.startDisabled}>{p.startLabel ?? 'Start'}</button>
        <button type="button" class="ax-btn quiet" onClick={p.onCancel}>Not now</button>
      </div>
    </section>
  );
}

export function RunFrame(p: {
  meta: Meta; left: number | null; total: number; status?: ComponentChildren; onStop: () => void; embedded?: boolean; stopLabel?: string; children: ComponentChildren;
}) {
  const frac = p.left == null ? 0 : 1 - p.left / p.total;
  if (p.embedded) {
    return (
      <div class="ax ax-embedded">
        <div class="ax-embed-bar">
          <span class="ax-small" aria-live="polite">{p.status}</span>
          {p.left != null && <span class="ax-mono ax-embed-clock" role="timer">{fmtClock(p.left)}</span>}
        </div>
        {p.children}
      </div>
    );
  }
  return (
    <section class="ax ax-sheet" aria-label={p.meta.name}>
      <div class="ax-head">
        <div class="ax-headtext">
          <span class="ax-kicker">{JOB_LABEL[p.meta.job]}</span>
          <span class="ax-name">{p.meta.name}</span>
        </div>
        {p.left != null && <span class="ax-clock" role="timer" aria-label={`${Math.ceil(p.left)} seconds left`}>{fmtClock(p.left)}</span>}
        <button type="button" class="ax-btn stop" onClick={p.onStop}>{p.stopLabel ?? 'Stop'}</button>
      </div>
      {p.left != null && <div class="ax-rule" aria-hidden="true"><i style={{ transform: `scaleX(${frac})` }} /></div>}
      {p.status && <div class="ax-small" aria-live="polite">{p.status}</div>}
      {p.children}
    </section>
  );
}

export function ResultView(p: { meta: Meta; result: ActivityResult; calmCount: number; note?: ComponentChildren; onDone: () => void; onAgain?: () => void }) {
  const r = p.result;
  const rows = HEADLINE[r.activity].filter((l) => Number.isFinite(r.metrics[l.key]));
  return (
    <section class="ax ax-sheet" aria-labelledby={`ax-${p.meta.id}-done`}>
      <div>
        <p class="ax-kicker">{r.completed ? 'Finished' : 'Stopped early'} · {fmtLength(Math.round(r.durationS))}</p>
        <h2 class="ax-title" id={`ax-${p.meta.id}-done`}>{p.meta.name}</h2>
      </div>
      {rows.length ? (
        <dl class="ax-results">
          {rows.map((l) => {
            const words = changeWords(l, r.vsBaseline?.[l.key]);
            return (
              <div class="ax-row" key={l.key}>
                <dt>{l.label}</dt>
                <dd>{formatMetric(l, r.metrics[l.key])}{l.unit && <small>{l.unit}</small>}</dd>
                {words && <p class="ax-change"><b>{words}</b> · change from your calm runs, not a stress score</p>}
              </div>
            );
          })}
        </dl>
      ) : (
        <p class="ax-lead">Too little was recorded to measure anything. Try again when you have {fmtLength(p.meta.durationS)}.</p>
      )}
      {!r.vsBaseline && rows.length > 0 && (
        <p class="ax-note">
          {p.calmCount === 0
            ? `Your first ${MIN_CALM_RUNS} calm runs set your reference. After that, results show how you differ from your usual.`
            : `${p.calmCount} of ${MIN_CALM_RUNS} calm runs so far. One more and results show how you differ from your usual.`}
        </p>
      )}
      {p.note}
      <div class="ax-actions">
        <button type="button" class="ax-btn primary" onClick={p.onDone}>Done</button>
        {p.onAgain && <button type="button" class="ax-btn quiet" onClick={p.onAgain}>Do it again</button>}
      </div>
    </section>
  );
}

/**
 * The intro -> run -> result state machine. `Run` renders the running stage and calls
 * finish(metrics, completed) when it ends (time up, or Stop).
 */
export function useActivityFlow(p: RunProps, meta: Meta) {
  const [phase, setPhase] = useState<'intro' | 'run' | 'done'>(p.autoStart ? 'run' : 'intro');
  const [result, setResult] = useState<ActivityResult | null>(null);
  const [runKey, setRunKey] = useState(0);
  const startedAt = useRef(Date.now());
  const start = () => { startedAt.current = Date.now(); setRunKey((k) => k + 1); setPhase('run'); };
  const finish = (metrics: Record<string, number>, completed: boolean) => {
    const r = makeResult(meta.id, startedAt.current, completed, metrics, p.calmRuns);
    if (p.showResult === false) { p.onDone(r); return; }
    setResult(r);
    setPhase('done');
  };
  const calmCount = (p.calmRuns ?? []).filter((r) => r.activity === meta.id && r.completed).length;
  const done = () => { if (result) p.onDone(result); };
  const again = () => { setResult(null); start(); };
  return { phase, result, start, finish, done, again, runKey, startedAt: startedAt.current, calmCount, durationS: p.durationS ?? meta.durationS };
}
