import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Intro, ResultView, RunFrame, useActivityFlow, useCountdown, type Meta, type RunProps } from '../kit';
import { PASSAGES, TypingRecorder } from './metrics';
import './typing.css';

export const typingMeta: Meta = {
  id: 'typing', name: 'Typing check', job: 'baseline', durationS: 45, device: 'keyboard',
  blurb: 'Key timing, rhythm and corrections, compared with your calm typing',
};

function Run(p: { passage: string; durationS: number; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void }) {
  const rec = useRef(new TypingRecorder(p.passage));
  const box = useRef<HTMLTextAreaElement>(null);
  // Only the length and the correct prefix are held in state for drawing; the text stays in the box.
  const [view, setView] = useState({ len: 0, ok: 0 });
  const [started, setStarted] = useState(false);
  const ended = useRef(false);
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    if (box.current) box.current.value = '';
    p.onEnd(rec.current.result(), completed);
  };
  const { left } = useCountdown(started, p.durationS, () => end(true));
  useEffect(() => { box.current?.focus(); }, []);

  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    const now = performance.now();
    if (!started) setStarted(true);
    rec.current.input(el.value, now);
    setView({ len: el.value.length, ok: rec.current.correctPrefix });
    if (rec.current.finished) end(true);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') e.preventDefault();
    rec.current.keyDown(e.code || 'u', performance.now());
  };
  const onKeyUp = (e: KeyboardEvent) => rec.current.keyUp(e.code || 'u', performance.now());

  const text = p.passage;
  const wrong = Math.max(0, view.len - view.ok);
  return (
    <RunFrame meta={typingMeta} left={started ? left : p.durationS} total={p.durationS} embedded={p.embedded} onStop={() => end(false)}
      status={started ? (wrong ? `${wrong} ${wrong === 1 ? 'character' : 'characters'} to fix before you go on` : `${Math.round((view.ok / text.length) * 100)}% of the passage`) : 'The clock starts with your first key.'}>
      <div class="ty-wrap" onClick={() => box.current?.focus()}>
        <p class="ty-passage" aria-hidden="true">
          <span class="ty-done">{text.slice(0, view.ok)}</span>
          {wrong > 0 && <span class="ty-wrong">{text.slice(view.ok, view.len) || ' '}</span>}
          <span class="ty-caret" />
          <span class="ty-rest">{text.slice(Math.max(view.len, view.ok))}</span>
        </p>
        <label class="sr-only" for="ty-box">Type the passage: {text}</label>
        <textarea id="ty-box" ref={box} class="ty-box" autocomplete="off" autocapitalize="off" spellcheck={false}
          {...{ autocorrect: 'off' }} rows={1} onInput={onInput} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPaste={(e) => e.preventDefault()} />
      </div>
    </RunFrame>
  );
}

export function Typing(props: RunProps) {
  const f = useActivityFlow(props, typingMeta);
  const passage = useMemo(() => PASSAGES[(props.seed ?? Math.floor(Math.random() * 1e6)) % PASSAGES.length], [props.seed, f.runKey]);
  if (f.phase === 'intro') {
    return (
      <Intro meta={typingMeta} lengthS={f.durationS} onStart={f.start} onCancel={props.onCancel}
        lead="Type a short passage at your normal pace. Mistakes are fine; fix them as you would in a message."
        measures="How long you hold each key, the gaps between keys and how even they are, your speed, corrections and pauses."
        keeps="Timings only. What you type and which keys you press are never stored."
        needs="A physical keyboard gives the fullest result. A phone keyboard works without hold times." />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} passage={passage} durationS={f.durationS} embedded={props.embedded} onEnd={f.finish} />;
  return <ResultView meta={typingMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done} />;
}
