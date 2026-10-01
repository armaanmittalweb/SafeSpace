import { useEffect, useRef, useState } from 'preact/hooks';
import type { Beat, LiveConnection } from '../../contract';
import { Intro, ResultView, RunFrame, useActivityFlow, useCountdown, useFrames, useReducedMotion, useWidth, type Meta, type RunProps } from '../kit';
import { BREATH, BREATH_S, breathAt, breathingMetrics } from './metrics';
import './body.css';

export const breathingMeta: Meta = {
  id: 'paced-breathing', name: 'Paced breathing', job: 'recovery', durationS: 180, device: 'any',
  blurb: 'Six slow breaths a minute with a guide; with a strap, see your heart rate follow',
};

const PAST_S = 20;
const AHEAD_S = 10;

/** Scrolling guide, like paper under a pen: the curve ahead is the breathing you are about to do. */
export function BreathChart(p: { tS: number; beats: Beat[]; startedAt: number; reduced: boolean }) {
  const [ref, W] = useWidth(600);
  const H = 150, nowX = (PAST_S / (PAST_S + AHEAD_S)) * W;
  const x = (s: number) => nowX + ((s - p.tS) / (PAST_S + AHEAD_S)) * W;
  const guideY = (fill: number) => 20 + (1 - fill) * 66;
  const pts: string[] = [];
  for (let s = p.tS - PAST_S; s <= p.tS + AHEAD_S; s += 0.2) {
    if (s < 0) continue;
    pts.push(`${x(s).toFixed(1)},${guideY(breathAt(s).fill).toFixed(1)}`);
  }
  const hr = p.beats
    .map((b) => ({ s: (b.t - p.startedAt) / 1000, v: b.rr ? 60000 / b.rr : b.hr }))
    .filter((b) => b.s >= p.tS - PAST_S && b.s <= p.tS && b.v > 30 && b.v < 220);
  let hrPath = '', lo = 0, hi = 0;
  if (hr.length > 1) {
    lo = Math.floor(Math.min(...hr.map((b) => b.v)) - 2);
    hi = Math.ceil(Math.max(...hr.map((b) => b.v)) + 2);
    const y = (v: number) => 138 - ((v - lo) / Math.max(hi - lo, 6)) * 38;
    hrPath = hr.map((b) => `${x(b.s).toFixed(1)},${y(b.v).toFixed(1)}`).join(' ');
  }
  const cur = breathAt(p.tS);
  return (
    <svg ref={ref} class="br-chart" viewBox={`0 0 ${W} ${H}`} style={{ height: `${H}px` }} role="img" aria-label={hr.length > 1 ? `Breathing guide with your heart rate between ${lo} and ${hi} beats per minute` : 'Breathing guide'}>
      <line x1="0" x2={W} y1={guideY(1)} y2={guideY(1)} class="br-grid" />
      <line x1="0" x2={W} y1={guideY(0)} y2={guideY(0)} class="br-grid" />
      <text x="4" y={guideY(1) - 4} class="br-label">in</text>
      <text x="4" y={guideY(0) + 14} class="br-label">out</text>
      <polyline points={pts.join(' ')} class="br-guide" />
      {hrPath && <polyline points={hrPath} class="br-hr" />}
      {hrPath && <text x={W - 4} y={H - 4} text-anchor="end" class="br-label">heart rate</text>}
      <line x1={nowX} x2={nowX} y1="6" y2={H - 4} class="br-now" />
      {!p.reduced && <circle cx={nowX} cy={guideY(cur.fill)} r="5" class="br-dot" />}
    </svg>
  );
}

function useBeats(live: LiveConnection | undefined, on: boolean): Beat[] {
  const [beats, setBeats] = useState<Beat[]>([]);
  useEffect(() => {
    if (!live || !on) return;
    const buf: Beat[] = [];
    const off = live.onBeat((b) => { buf.push(b); setBeats([...buf]); });
    return off;
  }, [live, on]);
  return beats;
}

function Run(p: { durationS: number; live?: LiveConnection; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void }) {
  const startedAt = useRef(Date.now()).current;
  const [tS, setTS] = useState(0);
  const reduced = useReducedMotion();
  const beats = useBeats(p.live, true);
  const ended = useRef(false);
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    const done = Math.min(p.durationS, (Date.now() - startedAt) / 1000);
    p.onEnd(breathingMetrics(beats, startedAt, p.durationS, done), completed);
  };
  const { left, elapsed } = useCountdown(true, p.durationS, () => end(true));
  useFrames(!reduced, (ms) => setTS(ms / 1000));
  const t = reduced ? elapsed : tS;
  const b = breathAt(t);
  // RSA of the last complete breath, from the live beats.
  let swing: number | null = null;
  if (beats.length > 4 && b.cycle > 0) {
    const from = startedAt + (b.cycle - 1) * BREATH_S * 1000, to = from + BREATH_S * 1000;
    const hr = beats.filter((x) => x.t >= from && x.t < to).map((x) => (x.rr ? 60000 / x.rr : x.hr));
    if (hr.length >= 4) swing = Math.max(...hr) - Math.min(...hr);
  }
  const lastHr = beats.length ? beats[beats.length - 1].hr : null;
  return (
    <RunFrame meta={breathingMeta} left={left} total={p.durationS} embedded={p.embedded} onStop={() => end(false)}>
      <div class="br-stage">
        <div class="br-cue" aria-live="polite">
          <span class="br-word">{b.phase === 'in' ? 'Breathe in' : 'Breathe out'}</span>
          <span class="br-count ax-mono" aria-hidden="true">{b.left}</span>
        </div>
        <p class="ax-small">{BREATH.inS} seconds in through your nose, {BREATH.outS} seconds out. Breath {b.cycle + 1} of {Math.floor(p.durationS / BREATH_S)}.</p>
        <BreathChart tS={t} beats={beats} startedAt={startedAt} reduced={reduced} />
        {p.live ? (
          <dl class="br-readout">
            <div><dt>Heart rate</dt><dd class="ax-mono">{lastHr ?? '–'}<small>bpm</small></dd></div>
            <div><dt>Swing last breath</dt>{swing == null ? <dd class="br-wait">After the first breath</dd> : <dd class="ax-mono">{swing.toFixed(0)}<small>bpm</small></dd>}</div>
          </dl>
        ) : (
          <p class="ax-note">Connect a heart-rate strap to see your heart rate rise as you breathe in and fall as you breathe out.</p>
        )}
      </div>
    </RunFrame>
  );
}

export function PacedBreathing(props: RunProps) {
  const f = useActivityFlow(props, breathingMeta);
  if (f.phase === 'intro') {
    return (
      <Intro meta={breathingMeta} lengthS={f.durationS} onStart={f.start} onCancel={props.onCancel}
        lead="Breathe along with the guide: in for 4 seconds, out for 6. Six breaths a minute is slow enough that your heart rate rises and falls with each breath."
        measures={props.live ? `With ${props.live.device}: your heart rate at the start and end, and how much it swings with each breath.` : 'How many guided breaths you complete. Connect a heart-rate strap to also see your heart rate follow your breathing.'}
        keeps="Heart-rate numbers only, if a device is connected." />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} durationS={f.durationS} live={props.live} embedded={props.embedded} onEnd={f.finish} />;
  return <ResultView meta={breathingMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done} />;
}
