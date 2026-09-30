import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/** Simulated minutes per real second at 1x. */
const RATE = 2;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The recorder's clock. With reduced motion the pens never animate: "play" writes the
 * whole session at once.
 */
export function usePlayback(total: number, initial: { t: number; playing: boolean }) {
  const [t, setT] = useState(() => Math.min(total, Math.max(0, initial.t)));
  const [playing, setPlaying] = useState(initial.playing && !prefersReducedMotion());
  const [speed, setSpeed] = useState(1);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (t > total) setT(total);
  }, [total]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const next = Math.min(total, tRef.current + dt * RATE * speed);
      setT(next);
      if (next >= total) { setPlaying(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, total]);

  const play = useCallback(() => {
    if (prefersReducedMotion()) { setT(total); setPlaying(false); return; }
    if (tRef.current >= total) setT(0);
    setPlaying(true);
  }, [total]);
  const pause = useCallback(() => setPlaying(false), []);
  const seek = useCallback((v: number) => setT(Math.max(0, Math.min(total, v))), [total]);
  const restart = useCallback(() => {
    if (prefersReducedMotion()) { setT(total); return; }
    setT(0);
    setPlaying(true);
  }, [total]);

  return { t, playing, speed, setSpeed, play, pause, seek, restart };
}
