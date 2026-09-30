import { useEffect, useRef, useState } from 'preact/hooks';
import { Intro, ResultView, RunFrame, useActivityFlow, type Meta, type RunProps } from '../kit';
import { RHYTHM, rhythmMetrics } from './metrics';
import './body.css';

export const rhythmMeta: Meta = {
  id: 'tap-rhythm', name: 'Tap the rhythm', job: 'check-in', durationS: 30, device: 'any',
  blurb: 'Tap along to a steady beat, then keep it going on your own',
};

const LEAD_IN = 4; // count-in beats before tapping starts

function click(ctx: AudioContext | null, at: number, accent: boolean) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1320 : 880;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.25, at + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
  o.connect(g).connect(ctx.destination);
  o.start(at); o.stop(at + 0.08);
}

function Run(p: { sound: boolean; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void }) {
  const { periodMs, pacedBeats, freeTaps } = RHYTHM;
  const t0 = useRef(performance.now() + 600).current;
  const beatTimes = useRef(Array.from({ length: LEAD_IN + pacedBeats }, (_, i) => t0 + i * periodMs)).current;
  const paced = useRef<number[]>([]);
  const free = useRef<number[]>([]);
  const [beat, setBeat] = useState(-1);
  const [taps, setTaps] = useState(0);
  const [flash, setFlash] = useState(false);
  const ended = useRef(false);
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    p.onEnd(rhythmMetrics(beatTimes.slice(LEAD_IN), paced.current, free.current), completed);
  };
  // Schedule the audible beat and the visual count.
  useEffect(() => {
    let ctx: AudioContext | null = null;
    if (p.sound && typeof AudioContext !== 'undefined') {
      try {
        ctx = new AudioContext();
        const base = ctx.currentTime + (t0 - performance.now()) / 1000;
        beatTimes.forEach((bt, i) => click(ctx, base + (bt - t0) / 1000, i < LEAD_IN));
      } catch { ctx = null; }
    }
    const ids = beatTimes.map((bt, i) => setTimeout(() => setBeat(i), Math.max(0, bt - performance.now())));
    // Give up if the person stops tapping for a long time in the free part.
    const guard = setTimeout(() => end(false), (LEAD_IN + pacedBeats + freeTaps * 2.5) * periodMs + 2000);
    return () => { ids.forEach(clearTimeout); clearTimeout(guard); void ctx?.close(); };
  }, []);

  const pacedEnd = beatTimes[beatTimes.length - 1] + periodMs / 2;
  const tap = () => {
    const now = performance.now();
    if (now < beatTimes[LEAD_IN] - periodMs / 2) return; // during the count-in
    if (now < pacedEnd) paced.current.push(now);
    else free.current.push(now);
    setTaps((n) => n + 1);
    setFlash(true); setTimeout(() => setFlash(false), 90);
    if (free.current.length >= freeTaps) end(true);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); tap(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const inCount = beat < LEAD_IN;
  const pacing = beat >= LEAD_IN && beat < LEAD_IN + pacedBeats;
  const freeN = free.current.length;
  const stage = inCount ? `Get ready: ${Math.max(1, LEAD_IN - Math.max(beat, 0))}` : pacing ? 'Tap with the beat' : `Keep going on your own: ${freeN} of ${freeTaps}`;
  return (
    <RunFrame meta={rhythmMeta} left={null} total={1} embedded={p.embedded} onStop={() => end(false)} status={`${taps} taps`}>
      <ol class="tr-beats" aria-hidden="true">
        {beatTimes.slice(LEAD_IN).map((_, i) => <li key={i} class={beat - LEAD_IN === i ? 'on' : beat - LEAD_IN > i ? 'past' : ''} />)}
        {Array.from({ length: freeTaps }, (_, i) => <li key={`f${i}`} class={`free${i < freeN ? ' past' : ''}`} />)}
      </ol>
      <button type="button" class={`tr-pad${flash ? ' hit' : ''}`} onPointerDown={(e) => { e.preventDefault(); tap(); }}>
        <span class="tr-stage-text" aria-live="polite">{stage}</span>
        <span class="ax-small">Tap here, or press the space bar</span>
      </button>
    </RunFrame>
  );
}

export function TapRhythm(props: RunProps) {
  const f = useActivityFlow(props, rhythmMeta);
  const [sound, setSound] = useState(true);
  if (f.phase === 'intro') {
    return (
      <Intro meta={rhythmMeta} lengthS={f.durationS} onStart={f.start} onCancel={props.onCancel}
        lead={`After a count of four, tap along with ${RHYTHM.pacedBeats} beats. Then the beat stops and you keep tapping at the same pace for ${RHYTHM.freeTaps} more taps.`}
        measures="How close you tap to the beat, how even your taps are, and whether you speed up or slow down on your own."
        keeps="Tap times only."
        extra={
          <label class="tr-sound">
            <input type="checkbox" checked={sound} onChange={(e) => setSound((e.currentTarget as HTMLInputElement).checked)} />
            Play the beat as a click (the ticks on screen show it too)
          </label>
        } />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} sound={sound} embedded={props.embedded} onEnd={f.finish} />;
  return <ResultView meta={rhythmMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done} />;
}
