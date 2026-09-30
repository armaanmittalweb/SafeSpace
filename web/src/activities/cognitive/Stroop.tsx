import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Intro, ResultView, RunFrame, useActivityFlow, useCountdown, type Meta, type RunProps } from '../kit';
import { INKS, STROOP_TIMEOUT_MS, stroopMetrics, stroopTrials, type Ink, type StroopResponse } from './metrics';
import './cognitive.css';

export const stroopMeta: Meta = {
  id: 'stroop', name: 'Colour words', job: 'challenge', durationS: 120, device: 'any',
  blurb: 'Name the ink colour, not the word. The mismatch is the challenge',
};

const KEY: Record<string, Ink> = { r: 'red', g: 'green', b: 'blue', y: 'yellow' };
const NAME: Record<Ink, string> = { red: 'Red', green: 'Green', blue: 'Blue', yellow: 'Yellow' };
const GAP_MS = 350;

function Run(p: { seed: number; durationS: number; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void }) {
  const trials = useMemo(() => stroopTrials(p.seed, 400), [p.seed]);
  const [i, setI] = useState(0);
  const [showing, setShowing] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const shownAt = useRef(performance.now());
  const responses = useRef<StroopResponse[]>([]);
  const ended = useRef(false);
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    p.onEnd(stroopMetrics(responses.current), completed);
  };
  const { left } = useCountdown(true, p.durationS, () => end(true));

  const next = () => {
    setShowing(false);
    setTimeout(() => { if (ended.current) return; setI((x) => x + 1); shownAt.current = performance.now(); setShowing(true); }, GAP_MS);
  };
  const answer = (ink: Ink | null) => {
    if (!showing || ended.current) return;
    const trial = trials[i];
    responses.current.push({ trial, rtMs: ink ? performance.now() - shownAt.current : null, answer: ink });
    setNote(ink == null ? 'Missed. Next one.' : ink !== trial.ink ? `That was ${trial.ink}.` : null);
    next();
  };
  // A word left unanswered counts as missed.
  useEffect(() => {
    if (!showing) return;
    const id = setTimeout(() => answer(null), STROOP_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [i, showing]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ink = KEY[e.key.toLowerCase()];
      if (ink && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); answer(ink); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const t = trials[i];
  return (
    <RunFrame meta={stroopMeta} left={left} total={p.durationS} embedded={p.embedded} onStop={() => end(false)} status={note ?? ' '}>
      <div class="cg-stage">
        <p class="cg-word" style={{ color: `var(--st-${t.ink})`, visibility: showing ? 'visible' : 'hidden' }} aria-live="off">
          <span class="sr-only">Word {t.word.toUpperCase()} in {t.ink} ink</span>
          <span aria-hidden="true">{t.word.toUpperCase()}</span>
        </p>
      </div>
      <div class="cg-answers" role="group" aria-label="Ink colour">
        {INKS.map((ink) => (
          <button type="button" key={ink} class="ax-btn cg-answer" onClick={() => answer(ink)}>
            <span class="cg-swatch" style={{ background: `var(--st-${ink})` }} aria-hidden="true" />
            {NAME[ink]}
            <kbd aria-hidden="true">{ink[0].toUpperCase()}</kbd>
          </button>
        ))}
      </div>
    </RunFrame>
  );
}

export function Stroop(props: RunProps) {
  const f = useActivityFlow(props, stroopMeta);
  const seed = props.seed ?? (Date.now() % 100000);
  if (f.phase === 'intro') {
    return (
      <Intro meta={stroopMeta} lengthS={f.durationS} onStart={f.start} onCancel={props.onCancel}
        lead="Words appear in coloured ink. Answer with the colour of the ink, not the word. Use the buttons, or the R, G, B and Y keys."
        preview={<p class="cg-example" aria-label="Example: the word BLUE in red ink. The answer is red."><span style={{ color: 'var(--st-red)' }} aria-hidden="true">BLUE</span><span class="ax-small" aria-hidden="true">answer: red</span></p>}
        measures="Reaction time for matching and mismatched words, errors, and how much the mismatch slows you."
        keeps="Timings and right or wrong only." />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} seed={seed + f.runKey} durationS={f.durationS} embedded={props.embedded} onEnd={f.finish} />;
  return <ResultView meta={stroopMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done} />;
}
