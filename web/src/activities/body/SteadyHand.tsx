import { useEffect, useRef, useState } from 'preact/hooks';
import { Intro, ResultView, RunFrame, useActivityFlow, useCountdown, type Meta, type RunProps } from '../kit';
import { tremorMetrics, type MotionSample } from './metrics';
import './body.css';

export const steadyMeta: Meta = {
  id: 'steady-hand', name: 'Steady hand', job: 'check-in', durationS: 20, device: 'phone',
  blurb: 'Hold your phone out and keep it still; the motion sensor measures tremor',
};

type Perm = 'unknown' | 'needs-permission' | 'denied' | 'no-sensor' | 'ok';

type DMEWithPermission = typeof DeviceMotionEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

function motionSupport(): Perm {
  if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') return 'no-sensor';
  return typeof (DeviceMotionEvent as DMEWithPermission).requestPermission === 'function' ? 'needs-permission' : 'unknown';
}

function Run(p: { durationS: number; embedded?: boolean; onEnd: (m: Record<string, number>, completed: boolean) => void; onNoSensor: () => void }) {
  const samples = useRef<MotionSample[]>([]);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [live, setLive] = useState(false);
  const ended = useRef(false);
  const end = (completed: boolean) => {
    if (ended.current) return;
    ended.current = true;
    p.onEnd(tremorMetrics(samples.current), completed);
  };
  const { left } = useCountdown(live, p.durationS, () => end(true));
  useEffect(() => {
    let smooth = { x: 0, y: 0 };
    const on = (e: DeviceMotionEvent) => {
      const a = e.acceleration?.x != null ? e.acceleration : e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      samples.current.push({ t: e.timeStamp || performance.now(), x: a.x, y: a.y, z: a.z });
      const g = e.accelerationIncludingGravity;
      if (g?.x != null && g.y != null) {
        smooth = { x: smooth.x * 0.8 + g.x * 0.2, y: smooth.y * 0.8 + g.y * 0.2 };
        setTilt(smooth);
      }
      if (!live) setLive(true);
    };
    addEventListener('devicemotion', on);
    // No events within 1.5 s: there is no motion sensor (a laptop) or it is blocked.
    const id = setTimeout(() => { if (!samples.current.length) p.onNoSensor(); }, 1500);
    return () => { removeEventListener('devicemotion', on); clearTimeout(id); };
  }, []);
  // Tilt (m/s^2 of gravity along the screen) moves the dot; about 2 m/s^2 reaches the edge.
  const dx = Math.max(-1, Math.min(1, -tilt.x / 2)), dy = Math.max(-1, Math.min(1, tilt.y / 2));
  return (
    <RunFrame meta={steadyMeta} left={live ? left : p.durationS} total={p.durationS} embedded={p.embedded} onStop={() => end(false)}
      status={live ? 'Keep the dot in the centre ring.' : 'Waiting for the motion sensor…'}>
      <div class="ax-stage square sh-stage">
        <svg viewBox="-50 -50 100 100" aria-hidden="true">
          <circle r="40" class="sh-ring" />
          <circle r="20" class="sh-ring" />
          <circle r="6" class="sh-ring strong" />
          <line x1="-46" x2="46" y1="0" y2="0" class="sh-cross" />
          <line y1="-46" y2="46" x1="0" x2="0" class="sh-cross" />
          <circle cx={dx * 40} cy={dy * 40} r="3.2" class="sh-dot" />
        </svg>
      </div>
    </RunFrame>
  );
}

export function SteadyHand(props: RunProps) {
  const f = useActivityFlow(props, steadyMeta);
  const [perm, setPerm] = useState<Perm>(() => motionSupport());
  const ask = async () => {
    const D = DeviceMotionEvent as DMEWithPermission;
    try {
      const r = await D.requestPermission!();
      if (r === 'granted') { setPerm('ok'); f.start(); } else setPerm('denied');
    } catch { setPerm('denied'); }
  };
  if (f.phase === 'intro' || perm === 'no-sensor' || perm === 'denied') {
    const blocked = perm === 'no-sensor' || perm === 'denied';
    return (
      <Intro meta={steadyMeta} lengthS={f.durationS} onCancel={props.onCancel}
        onStart={perm === 'needs-permission' ? ask : () => { setPerm('ok'); f.start(); }}
        startLabel={perm === 'needs-permission' ? 'Allow motion and start' : 'Start'} startDisabled={blocked}
        lead="Hold your phone flat in front of you at arm's length, elbow unsupported, and keep the dot in the centre for 20 seconds."
        measures="Small, fast shakes in your hand (tremor) from the phone's motion sensor, and their frequency."
        keeps="Tremor numbers only."
        needs="A phone. Laptops and desktops have no motion sensor."
        extra={blocked && (
          <p class="ax-note" role="alert">
            {perm === 'denied'
              ? 'Motion access was not allowed. On iPhone, close this tab and open it again to be asked once more, or allow Motion & Orientation Access in Settings > Safari.'
              : 'This device has no motion sensor. Open SafeSpace on your phone to do this one.'}
          </p>
        )} />
    );
  }
  if (f.phase === 'run') return <Run key={f.runKey} durationS={f.durationS} embedded={props.embedded} onEnd={f.finish} onNoSensor={() => setPerm('no-sensor')} />;
  return <ResultView meta={steadyMeta} result={f.result!} calmCount={f.calmCount} onDone={f.done} />;
}
