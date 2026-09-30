import { useMemo, useRef, useState } from 'preact/hooks';
import { Intro, ResultView, RunFrame, useActivityFlow, useCountdown, type Meta, type RunProps } from '../kit';
import { stagePoint } from './FollowDot';
import { tapMetrics, targetSequence, type TapTrial } from './metrics';

export const tapsMeta: Meta = {
  id: 'target-taps', name: 'Target taps', job: 'check-in', durationS: 40, device: 'pointer',
  blurb: 'Click or tap targets of different sizes as they appear',
};

function Run(p: { seed: number; durationS: number; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void }) {
  const targets = useMemo(() => targetSequence(p.seed, 200), [p.seed]);
  const stage = useRef<HTMLDivElement>(null);
  const [i, setI] = useState(0);
  const [started, setStarted] = useState(false);
  const trials = useRef<TapTrial[]>([]);
  const cur = useRef<{ shownAt: number; start: { x: number; y: number }; path: TapTrial['path'] }>({ shownAt: 0, start: { x: 0.5, y: 0.5 }, path: [] });
  const last = useRef({ x: 0.5, y: 0.5 });
  const ended = useRef(false);
  const [hits, setHits] = useState(0);
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    p.onEnd(tapMetrics(trials.current), completed);
  };
  const { left } = useCountdown(started, p.durationS, () => end(true));

  const onMove = (e: PointerEvent) => {
    if (!stage.current || e.pointerType === 'touch') return;
    const q = stagePoint(stage.current, e);
    last.current = q;
    if (started) cur.current.path.push({ t: performance.now(), ...q });
  };
  const onDown = (e: PointerEvent) => {
    if (!stage.current) return;
    const q = stagePoint(stage.current, e);
    const now = performance.now();
    const t = targets[i];
    if (!started) {
      // The first target is a start button: nothing is measured until it is hit.
      if (Math.hypot(q.x - 0.5, q.y - 0.5) <= 0.09) {
        setStarted(true);
        cur.current = { shownAt: now, start: q, path: [] };
        last.current = q;
      }
      return;
    }
    const pointer = (e.pointerType || 'mouse') as TapTrial['pointer'];
    trials.current.push({ target: t, start: cur.current.start, shownAt: cur.current.shownAt, path: cur.current.path, tap: { t: now, ...q }, pointer });
    if (Math.hypot(q.x - t.x, q.y - t.y) <= t.r) setHits((h) => h + 1);
    cur.current = { shownAt: now, start: pointer === 'touch' ? { x: t.x, y: t.y } : q, path: [] };
    setI(i + 1);
  };

  const t = targets[i];
  const n = trials.current.length;
  return (
    <RunFrame meta={tapsMeta} left={started ? left : p.durationS} total={p.durationS} embedded={p.embedded} onStop={() => end(false)}
      status={started ? `${n} ${n === 1 ? 'target' : 'targets'} · ${hits} hit` : 'Tap the circle in the middle to begin.'}>
      <div ref={stage} class="ax-stage square" onPointerMove={onMove} onPointerDown={onDown} role="application"
        aria-label="Target box. Click or tap each circle as it appears.">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          {started ? (
            <g>
              <circle cx={t.x * 100} cy={t.y * 100} r={t.r * 100} class="tt-outer" />
              <circle cx={t.x * 100} cy={t.y * 100} r={t.r * 50} class="tt-inner" />
              <line x1={t.x * 100 - 1.4} y1={t.y * 100} x2={t.x * 100 + 1.4} y2={t.y * 100} class="tt-cross" />
              <line x1={t.x * 100} y1={t.y * 100 - 1.4} x2={t.x * 100} y2={t.y * 100 + 1.4} class="tt-cross" />
            </g>
          ) : (
            <g>
              <circle cx="50" cy="50" r="9" class="tt-startbtn" />
              <text x="50" y="51.3" text-anchor="middle" class="tt-start">Start</text>
            </g>
          )}
        </svg>
      </div>
    </RunFrame>
  );
}

export function TargetTaps(props: RunProps) {
  const f = useActivityFlow(props, tapsMeta);
  const seed = props.seed ?? (Date.now() % 100000);
  if (f.phase === 'intro') {
    return (
      <Intro meta={tapsMeta} lengthS={f.durationS} onStart={f.start} onCancel={props.onCancel}
        lead="Circles of three sizes appear one at a time. Click or tap each one as quickly as you comfortably can."
        measures="How quickly you start moving and arrive, how often you hit, overshoot, and pause before clicking."
        needs="A mouse or trackpad gives movement detail. On a phone, only taps are measured." />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} seed={seed + f.runKey} durationS={f.durationS} embedded={props.embedded} onEnd={f.finish} />;
  return <ResultView meta={tapsMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done} />;
}
