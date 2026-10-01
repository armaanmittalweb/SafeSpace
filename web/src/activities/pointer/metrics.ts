// Pointer activities: Follow the dot and Target taps. Positions are in stage units
// (0..1 on both axes of a square-normalised stage) so results do not depend on screen size.
// Pointer movement is recorded only inside the activity's stage.
import { finite, mean, median, rng, round, sd } from '../stats';

// ---------- Follow the dot ----------

/** A smooth pseudo-random path: two sums of incommensurate sines per axis, inside 0.12..0.88. */
export function dotPath(seed: number): (tS: number) => { x: number; y: number } {
  const r = rng(seed);
  const comp = () => [0, 1, 2].map((i) => ({ f: 0.07 + 0.09 * i + 0.03 * r(), p: r() * Math.PI * 2, a: [0.5, 0.3, 0.2][i] }));
  const cx = comp(), cy = comp();
  const ev = (c: typeof cx, t: number) => c.reduce((s, k) => s + k.a * Math.sin(2 * Math.PI * k.f * t + k.p), 0);
  return (t) => ({ x: 0.5 + 0.38 * ev(cx, t), y: 0.5 + 0.38 * ev(cy, t) });
}

export interface TrackSample { t: number; px: number; py: number; tx: number; ty: number }

/** Distance within which the pointer counts as on target (stage units). */
export const ON_TARGET = 0.04;

export function followMetrics(s: readonly TrackSample[]): Record<string, number> {
  // Ignore the first second while the person finds the dot.
  const t0 = s.length ? s[0].t + 1000 : 0;
  const x = s.filter((p) => p.t >= t0);
  if (x.length < 10) return {};
  const err = x.map((p) => Math.hypot(p.px - p.tx, p.py - p.ty));
  // Resample the pointer path to 50 Hz for derivatives.
  const dt = 0.02;
  const rx: number[] = [], ry: number[] = [];
  let j = 0;
  for (let t = x[0].t; t <= x[x.length - 1].t; t += dt * 1000) {
    while (j < x.length - 2 && x[j + 1].t < t) j++;
    const a = x[j], b = x[j + 1] ?? a;
    const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    rx.push(a.px + (b.px - a.px) * u);
    ry.push(a.py + (b.py - a.py) * u);
  }
  // Smooth with a 5-sample moving average before differencing (pointer events are jittery).
  const smooth = (v: number[]) => v.map((_, i) => mean(v.slice(Math.max(0, i - 2), i + 3)));
  const sx = smooth(rx), sy = smooth(ry);
  const d = (v: number[]) => v.slice(1).map((y, i) => (y - v[i]) / dt);
  const jx = d(d(d(sx))), jy = d(d(d(sy)));
  const jerk = jx.map((v, i) => Math.hypot(v, jy[i]));
  // Over-corrections: the pointer error flips side on an axis, from more than ON_TARGET
  // behind to more than ON_TARGET past the dot.
  let flips = 0;
  for (const axis of ['x', 'y'] as const) {
    let side = 0;
    for (const p of x) {
      const e = axis === 'x' ? p.px - p.tx : p.py - p.ty;
      const sgn = e > ON_TARGET ? 1 : e < -ON_TARGET ? -1 : 0;
      if (sgn && side && sgn !== side) flips++;
      if (sgn) side = sgn;
    }
  }
  const minutes = (x[x.length - 1].t - x[0].t) / 60000;
  return finite({
    meanErrorPct: round(mean(err) * 100, 2),
    rmsErrorPct: round(Math.sqrt(mean(err.map((e) => e * e))) * 100, 2),
    onTargetPct: round((err.filter((e) => e <= ON_TARGET).length / err.length) * 100, 1),
    jerk: round(median(jerk), 1),
    overCorrectionsPerMin: minutes > 0 ? round(flips / minutes, 1) : NaN,
  });
}

// ---------- Target taps ----------

export interface Target { x: number; y: number; r: number }
/** Target radii (stage units): large, medium, small. */
export const TARGET_SIZES = [0.075, 0.05, 0.03];

export function targetSequence(seed: number, n: number): Target[] {
  const r = rng(seed);
  const out: Target[] = [];
  let prev = { x: 0.5, y: 0.5 };
  for (let i = 0; i < n; i++) {
    const size = TARGET_SIZES[Math.floor(r() * TARGET_SIZES.length)];
    let t: Target;
    do t = { x: size + 0.02 + r() * (1 - 2 * size - 0.04), y: size + 0.02 + r() * (1 - 2 * size - 0.04), r: size };
    while (Math.hypot(t.x - prev.x, t.y - prev.y) < 0.25);
    out.push(t);
    prev = t;
  }
  return out;
}

export interface TapTrial {
  target: Target;
  start: { x: number; y: number };
  shownAt: number;
  /** Pointer samples while the target was shown (mouse/pen only; empty for touch). */
  path: { t: number; x: number; y: number }[];
  tap: { t: number; x: number; y: number };
  pointer: 'mouse' | 'pen' | 'touch';
}

export function tapMetrics(trials: readonly TapTrial[]): Record<string, number> {
  if (!trials.length) return {};
  const hits = trials.filter((t) => Math.hypot(t.tap.x - t.target.x, t.tap.y - t.target.y) <= t.target.r);
  const total = trials.map((t) => t.tap.t - t.shownAt);
  const errR = trials.map((t) => Math.hypot(t.tap.x - t.target.x, t.tap.y - t.target.y) / t.target.r);
  const reaction: number[] = [], movement: number[] = [], dwell: number[] = [], tp: number[] = [];
  let overshoots = 0, withPath = 0;
  for (const t of trials) {
    if (t.pointer === 'touch' || t.path.length < 3) continue;
    withPath++;
    const moveStart = t.path.find((p) => Math.hypot(p.x - t.start.x, p.y - t.start.y) > 0.01);
    if (!moveStart) continue;
    reaction.push(moveStart.t - t.shownAt);
    const mt = t.tap.t - moveStart.t;
    movement.push(mt);
    // Hesitation: time from the last entry into the target to the click.
    let entered: number | null = null;
    let inside = false;
    for (const p of t.path) {
      const now = Math.hypot(p.x - t.target.x, p.y - t.target.y) <= t.target.r;
      if (now && !inside) entered = p.t;
      inside = now;
    }
    if (entered != null && inside) dwell.push(t.tap.t - entered);
    // Overshoot: along the start->target axis the path went past the far edge of the target.
    const dx = t.target.x - t.start.x, dy = t.target.y - t.start.y;
    const D = Math.hypot(dx, dy);
    const ux = dx / D, uy = dy / D;
    const maxAlong = Math.max(...t.path.map((p) => (p.x - t.start.x) * ux + (p.y - t.start.y) * uy));
    if (maxAlong > D + t.target.r) overshoots++;
    if (mt > 0) tp.push(Math.log2(D / (2 * t.target.r) + 1) / (mt / 1000));
  }
  return finite({
    trials: trials.length,
    accuracyPct: round((hits.length / trials.length) * 100, 1),
    timeToTapMs: round(median(total)),
    timeToTapSdMs: round(sd(total)),
    errorRadii: round(mean(errR), 2),
    reactionMs: round(median(reaction)),
    movementMs: round(median(movement)),
    hesitationMs: round(median(dwell)),
    overshootPct: withPath ? round((overshoots / withPath) * 100, 1) : NaN,
    throughputBits: round(mean(tp), 2),
  });
}
