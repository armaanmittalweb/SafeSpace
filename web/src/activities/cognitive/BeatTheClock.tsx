import { useEffect, useRef, useState } from 'preact/hooks';
import { Intro, ResultView, RunFrame, useActivityFlow, useCountdown, useReducedMotion, type Meta, type RunProps } from '../kit';
import { rng } from '../stats';
import { clockMetrics, makeProblem, Staircase, timeLimitS, type Problem } from './metrics';
import './cognitive.css';

export const clockMeta: Meta = {
  id: 'beat-the-clock', name: 'Beat the clock', job: 'challenge', durationS: 180, device: 'any',
  blurb: 'Mental arithmetic against a timer, tuned to about half right',
};

const FEEDBACK_MS = 700;

function Run(p: { seed: number; durationS: number; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void }) {
  const rand = useRef(rng(p.seed)).current;
  const stair = useRef(new Staircase(2)).current;
  const [prob, setProb] = useState<Problem>(() => makeProblem(stair.level, rand));
  const [entry, setEntry] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [probLeft, setProbLeft] = useState(timeLimitS(stair.level));
  const shownAt = useRef(performance.now());
  const ended = useRef(false);
  const reduced = useReducedMotion();
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    p.onEnd(clockMetrics(stair, !completed), completed);
  };
  const { left } = useCountdown(true, p.durationS, () => end(true));

  const nextProblem = () => {
    if (ended.current) return;
    const q = makeProblem(stair.level, rand);
    setProb(q); setEntry(''); setFeedback(null);
    setProbLeft(timeLimitS(stair.level));
    shownAt.current = performance.now();
  };
  const settle = (value: string | null) => {
    if (feedback || ended.current) return;
    const rt = performance.now() - shownAt.current;
    const ok = value != null && value !== '' && Number(value) === prob.answer;
    stair.record(ok, value == null ? null : rt, value == null);
    setFeedback(ok ? { ok, text: 'Right' } : { ok, text: value == null ? `Out of time. It was ${prob.answer}.` : `It was ${prob.answer}.` });
    setTimeout(nextProblem, FEEDBACK_MS);
  };
  // The per-problem timer.
  useEffect(() => {
    if (feedback) return;
    const limit = timeLimitS(prob.level) * 1000;
    const id = setInterval(() => {
      const l = limit - (performance.now() - shownAt.current);
      setProbLeft(Math.max(0, l / 1000));
      if (l <= 0) { clearInterval(id); settle(null); }
    }, 100);
    return () => clearInterval(id);
  }, [prob, feedback]);

  const press = (k: string) => {
    if (feedback) return;
    if (k === 'back') setEntry((e) => e.slice(0, -1));
    else if (k === 'enter') settle(entry);
    else setEntry((e) => (e.length < 5 ? e + k : e));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Enter') press('enter');
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const h = stair.history;
  const right = h.filter((x) => x.correct).length;
  const limit = timeLimitS(prob.level);
  return (
    <RunFrame meta={clockMeta} left={left} total={p.durationS} embedded={p.embedded} onStop={() => end(false)} stopLabel="Stop"
      status={h.length ? `Level ${stair.level} of 10 · ${right} of ${h.length} right` : 'Type the answer, then Enter. Stop whenever you like.'}>
      <div class="bc-stage">
        <p class="bc-problem ax-mono" aria-live="polite"><span class="sr-only">What is </span>{prob.text.replace('−', ' − ').replace(/\s+/g, ' ')}</p>
        <div class="bc-timer" aria-hidden="true"><i style={{ transform: `scaleX(${feedback ? 0 : probLeft / limit})`, transition: reduced ? 'none' : undefined }} /></div>
        <p class="bc-entry ax-mono" aria-label="Your answer">{entry || ' '}</p>
        <p class={`bc-feedback${feedback && !feedback.ok ? ' miss' : ''}`} role="status">{feedback?.text ?? ' '}</p>
      </div>
      <div class="bc-pad" role="group" aria-label="Number pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button type="button" key={k} class="ax-btn bc-key ax-mono" onClick={() => press(k)}>{k}</button>
        ))}
        <button type="button" class="ax-btn bc-key" onClick={() => press('back')} aria-label="Delete">Del</button>
        <button type="button" class="ax-btn bc-key ax-mono" onClick={() => press('0')}>0</button>
        <button type="button" class="ax-btn bc-key primary" onClick={() => press('enter')}>Enter</button>
      </div>
    </RunFrame>
  );
}

export function BeatTheClock(props: RunProps) {
  const f = useActivityFlow(props, clockMeta);
  const seed = props.seed ?? (Date.now() % 100000);
  if (f.phase === 'intro') {
    return (
      <Intro meta={clockMeta} lengthS={f.durationS} onStart={f.start} onCancel={props.onCancel}
        lead="Mental arithmetic with a timer on each problem. It gets harder when you are right and easier when you are not, so you will miss about half. That is how it is meant to feel. Stop whenever you like."
        measures="How many you answer, how many are right, the level you settle at and how long right answers take."
        keeps="Timings and right or wrong only. No comparison with anyone else." />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} seed={seed + f.runKey} durationS={f.durationS} embedded={props.embedded} onEnd={f.finish} />;
  return <ResultView meta={clockMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done}
    note={<p class="ax-note">Missing about half is expected: the problems adjust to keep it that way.</p>} />;
}
