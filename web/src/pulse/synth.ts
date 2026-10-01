// Synthetic fingertip PPG: what the camera's centre-of-frame colour means look like with a finger over
// a lit lens, at a known heart rate. A systolic wave and a smaller dicrotic wave per beat, breathing-
// linked variation in the beat intervals, baseline wander, sensor noise, frame-time jitter, and on
// request a motion burst and a run of dropped frames.
import type { Frame, MotionSample } from './ppg';

export interface SynthOptions {
  bpm: number;
  seconds?: number;
  fps?: number;
  /** SD of white noise as a fraction of the pulse amplitude */
  noise?: number;
  /** baseline wander amplitude as a multiple of the pulse amplitude */
  wander?: number;
  /** frame time jitter SD, ms */
  jitterMs?: number;
  motion?: { at: number; dur: number };
  drop?: { at: number; dur: number };
  seed?: number;
}

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const n = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

export function synth(o: SynthOptions) {
  const seconds = o.seconds ?? 60, fps = o.fps ?? 30, amp = 3;
  const R = rng(o.seed ?? 7);
  const t0 = 1_700_000_000_000;
  // Beat onsets: RR modulated ±4% at the breathing rate (0.25 Hz) plus 8 ms of noise.
  const rr0 = 60000 / o.bpm;
  const onsets: number[] = [];
  let tb = -rr0 * R.u();
  while (tb < seconds * 1000 + 2000) {
    onsets.push(tb);
    tb += rr0 * (1 + 0.04 * Math.sin((2 * Math.PI * 0.25 * tb) / 1000)) + 8 * R.n();
  }
  const trueRR: number[] = [];
  for (let i = 1; i < onsets.length; i++) if (onsets[i] > 0 && onsets[i] < seconds * 1000) trueRR.push(onsets[i] - onsets[i - 1]);
  const trueHr = 60000 / (trueRR.reduce((a, b) => a + b, 0) / trueRR.length);

  const pulse = (t: number) => {
    // sum over nearby beats of a systolic gaussian (peak 150 ms after onset) and a dicrotic one
    let v = 0;
    for (const on of onsets) {
      const d = (t - on) / 1000;
      if (d < -0.5 || d > 1.5) continue;
      v += Math.exp(-(((d - 0.15) / 0.07) ** 2) / 2) + 0.35 * Math.exp(-(((d - 0.42) / 0.09) ** 2) / 2);
    }
    return v;
  };

  const frames: Frame[] = [];
  const motion: MotionSample[] = [];
  let walk = 0;
  const wph = R.u() * 6;
  for (let k = 0; ; k++) {
    const t = (k * 1000) / fps + (o.jitterMs ?? 3) * R.n();
    if (t > seconds * 1000) break;
    if (o.drop && t >= o.drop.at * 1000 && t < (o.drop.at + o.drop.dur) * 1000) continue;
    const moving = !!o.motion && t >= o.motion.at * 1000 && t < (o.motion.at + o.motion.dur) * 1000;
    if (moving) walk += 4 * amp * R.n(); else walk *= 0.9;
    const wander = (o.wander ?? 0.5) * amp * (Math.sin((2 * Math.PI * 0.12 * t) / 1000 + wph) + 0.6 * Math.sin((2 * Math.PI * 0.31 * t) / 1000));
    const noise = (o.noise ?? 0.05) * amp;
    const p = pulse(t);
    const spike = moving && R.u() < 0.1 ? 15 * amp * R.n() : 0;
    frames.push({
      t: t0 + t,
      r: 205 - amp * p + wander + walk + spike + noise * R.n(),
      g: 38 - 0.5 * amp * p + 0.3 * (wander + walk) + noise * R.n(),
      b: 22 - 0.2 * amp * p + 0.2 * (wander + walk) + noise * R.n(),
    });
    motion.push({ t: t0 + t, a: moving ? 2.5 * Math.abs(R.n()) : 0.03 * Math.abs(R.n()) });
  }
  return { frames, motion, trueHr, trueRR, t0 };
}
