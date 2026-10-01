// A LiveConnection over any stream of colour frames: the real camera and the dev fake both feed this,
// so the trace, the beats, the quality meter and the final Measurement always come from the same code.
import type { Beat, LiveConnection } from '../contract/inputs';
import type { Measurement, Quality } from '../contract/records';
import { measurementFromAnalysis } from './measure';
import { analyze, type Frame, type MotionSample } from './ppg';

export interface FramePump {
  device: string;
  torch: boolean;
  /** Starts delivering frames and motion; returns a stop function. */
  start(onFrame: (f: Frame) => void, onMotion: (m: MotionSample) => void, onEnded: () => void): () => void;
}

const LIVE_WINDOW_MS = 6000;
const TICK_MS = 500;
const KEEP_MS = 90_000;

export function pulseConnection(pump: FramePump): LiveConnection {
  const frames: Frame[] = [];
  const motion: MotionSample[] = [];
  const beatCbs = new Set<(b: Beat) => void>();
  const qualCbs = new Set<(q: Quality, why: string | null) => void>();
  const sampleCbs = new Set<(s: { t: number; v: number }) => void>();
  const endCbs = new Set<() => void>();
  let lastQ: { q: Quality; why: string | null } = { q: 'poor', why: 'Starting up' };
  let lastBeat = -Infinity;
  const recentHr: number[] = [];
  // causal display filter: slow EMA removes the baseline, fast EMA smooths
  let slow = NaN, fast = NaN, lastT = NaN;
  let ended = false;

  const onFrame = (f: Frame) => {
    frames.push(f);
    while (frames.length && frames[0].t < f.t - KEEP_MS) frames.shift();
    const dt = Number.isFinite(lastT) ? Math.min(0.2, (f.t - lastT) / 1000) : 1 / 30;
    lastT = f.t;
    const x = -f.r;
    // a finger going on or off the lens is a step, not a pulse: restart the baseline there
    if (!Number.isFinite(slow) || Math.abs(x - slow) > 25) { slow = x; fast = 0; }
    slow += (x - slow) * (1 - Math.exp(-dt / 1.2));
    fast += (x - slow - fast) * (1 - Math.exp(-dt / 0.07));
    for (const cb of sampleCbs) cb({ t: f.t, v: fast });
  };
  const onMotion = (m: MotionSample) => {
    motion.push(m);
    while (motion.length && motion[0].t < m.t - KEEP_MS) motion.shift();
  };

  const tick = () => {
    if (!frames.length) return;
    const now = frames[frames.length - 1].t;
    const win = frames.filter((f) => f.t >= now - LIVE_WINDOW_MS);
    const a = analyze(win, { torch: pump.torch, motion: motion.filter((m) => m.t >= now - LIVE_WINDOW_MS) });
    if (a.quality !== lastQ.q || a.why !== lastQ.why) {
      lastQ = { q: a.quality, why: a.why };
      for (const cb of qualCbs) cb(a.quality, a.why);
    }
    if (a.quality === 'poor') return;
    for (const t of a.beats) {
      if (t <= lastBeat + 250 || t > now - 350) continue;
      const rr = t - lastBeat;
      const okRR = rr >= 300 && rr <= 2000 ? rr : null;
      if (okRR) { recentHr.push(60000 / okRR); if (recentHr.length > 5) recentHr.shift(); }
      lastBeat = t;
      if (!recentHr.length) continue;
      const hr = [...recentHr].sort((p, q) => p - q)[recentHr.length >> 1];
      for (const cb of beatCbs) cb({ t, rr: okRR, hr });
    }
  };

  const stopPump = pump.start(onFrame, onMotion, () => {
    if (ended) return;
    ended = true;
    for (const cb of endCbs) cb();
  });
  const timer = setInterval(tick, TICK_MS);

  const sub = <T>(set: Set<T>, cb: T) => { set.add(cb); return () => { set.delete(cb); }; };

  return {
    device: pump.device,
    onBeat: (cb) => sub(beatCbs, cb),
    onQuality: (cb) => { cb(lastQ.q, lastQ.why); return sub(qualCbs, cb); },
    onSample: (cb) => sub(sampleCbs, cb),
    onDisconnect: (cb) => sub(endCbs, cb),
    battery: async () => null,
    measure(durationS: number, signal?: AbortSignal): Promise<Measurement> {
      return new Promise((resolve, reject) => {
        const startWall = Date.now();
        const start = frames.length ? frames[frames.length - 1].t : startWall;
        const abort = () => { clearInterval(poll); reject(new DOMException('The measurement was cancelled.', 'AbortError')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        const poll = setInterval(() => {
          if (ended) { clearInterval(poll); signal?.removeEventListener('abort', abort); reject(new DOMException('The camera stopped.', 'NotReadableError')); return; }
          const last = frames.length ? frames[frames.length - 1].t : start;
          if (last - start < durationS * 1000 && Date.now() - startWall < durationS * 1000 + 5000) return;
          clearInterval(poll);
          signal?.removeEventListener('abort', abort);
          const end = start + durationS * 1000;
          const w = frames.filter((f) => f.t >= start && f.t <= end);
          const opts = { torch: pump.torch, motion: motion.filter((m) => m.t >= start && m.t <= end) };
          const a = analyze(w, opts);
          resolve(measurementFromAnalysis(a, opts, { device: pump.device, startedAt: start, durationS, keepBeats: true }));
        }, 200);
      });
    },
    async disconnect() {
      clearInterval(timer);
      ended = true;
      stopPump();
    },
  };
}
