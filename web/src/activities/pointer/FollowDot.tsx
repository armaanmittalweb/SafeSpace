import { useRef, useState } from 'preact/hooks';
import { Intro, ResultView, RunFrame, useActivityFlow, useCountdown, useFrames, useReducedMotion, type Meta, type RunProps } from '../kit';
import { dotPath, followMetrics, ON_TARGET, type TrackSample } from './metrics';

export const followMeta: Meta = {
  id: 'follow-dot', name: 'Follow the dot', job: 'baseline', durationS: 30, device: 'pointer',
  blurb: 'Keep your pointer or finger on a slowly wandering dot',
};

export const stagePoint = (el: Element, e: PointerEvent) => {
  const r = el.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
};

function Run(p: { seed: number; durationS: number; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void }) {
  const path = useRef(dotPath(p.seed)).current;
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const samples = useRef<TrackSample[]>([]);
  const trail = useRef<{ t: number; x: number; y: number }[]>([]);
  const [started, setStarted] = useState(false);
  const [, draw] = useState(0);
  const t0 = useRef(0);
  const ended = useRef(false);
  const reduced = useReducedMotion();
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    p.onEnd(followMetrics(samples.current), completed);
  };
  const { left } = useCountdown(started, p.durationS, () => end(true));
  const start = path(0);

  useFrames(started, (ms, now) => {
    const d = path(ms / 1000);
    const q = pointer.current;
    if (q) {
      samples.current.push({ t: now, px: q.x, py: q.y, tx: d.x, ty: d.y });
      trail.current.push({ t: now, x: q.x, y: q.y });
      while (trail.current.length && trail.current[0].t < now - 1200) trail.current.shift();
    }
    t0.current = ms;
    draw((n) => n + 1);
  });

  const onMove = (e: PointerEvent) => {
    if (!stage.current) return;
    const q = stagePoint(stage.current, e);
    if (e.pointerType === 'touch' && e.type === 'pointermove' && e.buttons === 0) return;
    pointer.current = q;
    if (!started && Math.hypot(q.x - start.x, q.y - start.y) < ON_TARGET * 1.5) setStarted(true);
  };
  const onLeave = (e: PointerEvent) => { if (e.pointerType !== 'touch') pointer.current = null; };

  const d = started ? path(t0.current / 1000) : start;
  const near = pointer.current && Math.hypot(pointer.current.x - d.x, pointer.current.y - d.y) <= ON_TARGET;
  const pts = trail.current.map((q) => `${(q.x * 100).toFixed(2)},${(q.y * 100).toFixed(2)}`).join(' ');
  return (
    <RunFrame meta={followMeta} left={started ? left : p.durationS} total={p.durationS} embedded={p.embedded} onStop={() => end(false)}
      status={started ? (near ? 'On the dot' : 'Off the dot') : 'Put your pointer or finger on the dot to begin.'}>
      <div ref={stage} class="ax-stage square" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={onLeave}
        role="application" aria-label="Tracking box. Keep the pointer on the moving dot.">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {pts && <polyline points={pts} class="fd-trail" vector-effect="non-scaling-stroke" />}
        </svg>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx={d.x * 100} cy={d.y * 100} r={ON_TARGET * 100} class={`fd-ring${near ? ' near' : ''}`} />
          <circle cx={d.x * 100} cy={d.y * 100} r="1.1" class="fd-dot" />
          {!started && !reduced && <circle cx={d.x * 100} cy={d.y * 100} r={ON_TARGET * 100 + 3} class="fd-halo" />}
        </svg>
      </div>
    </RunFrame>
  );
}

export function FollowDot(props: RunProps) {
  const f = useActivityFlow(props, followMeta);
  const seed = props.seed ?? (Date.now() % 100000);
  if (f.phase === 'intro') {
    return (
      <Intro meta={followMeta} lengthS={f.durationS} onStart={f.start} onCancel={props.onCancel}
        lead="A dot drifts slowly around a box. Keep your pointer on it, or your finger on a phone. It never jumps."
        measures="How far you stay from the dot, how smooth your movement is, and how often you overshoot and correct." />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} seed={seed + f.runKey} durationS={f.durationS} embedded={props.embedded} onEnd={f.finish} />;
  return <ResultView meta={followMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done} />;
}
