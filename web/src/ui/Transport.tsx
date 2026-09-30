import { PRESETS } from '../sim/presets';
import type { Session } from '../sim/scenario';
import { clock } from './format';

export function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      {playing ? <path d="M2 1h3v10H2zM7 1h3v10H7z" fill="currentColor" /> : <path d="M2 1l9 5-9 5z" fill="currentColor" />}
    </svg>
  );
}

interface Pb {
  t: number; playing: boolean; speed: number;
  setSpeed: (n: number) => void; play: () => void; pause: () => void; seek: (t: number) => void; restart: () => void;
}

export function Transport({ pb, session, compact }: { pb: Pb; session: Session; compact?: boolean }) {
  const span = session.spans.find((s) => pb.t < s.end) ?? session.spans[session.spans.length - 1];
  const where = span.calibration ? 'Calibrating at rest' : PRESETS[span.preset].name;
  const done = pb.t >= session.total;
  return (
    <div class={`transport${compact ? ' compact' : ''}`}>
      <button type="button" class="btn primary" onClick={pb.playing ? pb.pause : pb.play} aria-label={pb.playing ? 'Pause' : done ? 'Replay session' : 'Play'}>
        <PlayIcon playing={pb.playing} /><span>{pb.playing ? 'Pause' : done ? 'Replay' : 'Play'}</span>
      </button>
      {!compact && <button type="button" class="btn" onClick={pb.restart}>Restart</button>}
      <div class="scrub">
        <input type="range" min={0} max={session.total} step={0.25} value={pb.t}
          aria-label="Simulated time" aria-valuetext={`${clock(pb.t)} of ${clock(session.total)}, ${where}`}
          onInput={(e) => { pb.pause(); pb.seek(Number((e.target as HTMLInputElement).value)); }} />
      </div>
      <span class="clock mono"><span class="now-t">{clock(pb.t)}</span><span class="of"> / {clock(session.total)}</span></span>
      {!compact && (
        <div class="speed" role="radiogroup" aria-label="Playback speed">
          {[1, 2, 4].map((s) => (
            <button type="button" role="radio" aria-checked={pb.speed === s} class={pb.speed === s ? 'on' : ''} onClick={() => pb.setSpeed(s)}>{s}×</button>
          ))}
        </div>
      )}
    </div>
  );
}
