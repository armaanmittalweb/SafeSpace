// Shared pieces: the score scale, day cells, the quality meter, the live trace, form controls.
import type { ComponentChildren, CSSProperties } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { CheckIn, Quality } from '../contract/records';
import type { SyncStatus } from '../contract/vault';
import { addDays, ago, DAYS_SHORT, fmtSigned, sameDay, startOfWeek } from './format';
import { IconCloud, IconOffline } from './icons';
import { levelOf, LEVEL_TEXT, tone } from './scoring';

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The calm–stressed scale: −1 … +1 with ticks, the stretch from 0 to the score filled, a needle that settles once. */
export function ScoreScale({ score, compact = false }: { score: number; compact?: boolean }) {
  const [shown, setShown] = useState(reducedMotion() ? score : 0);
  useEffect(() => { const t = requestAnimationFrame(() => setShown(score)); return () => cancelAnimationFrame(t); }, [score]);
  const x = (v: number) => 50 + v * 50;
  const t = tone(score);
  return (
    <div class={`scale ${compact ? 'compact' : ''}`}>
      <div class="scale-track" aria-hidden="true">
        {Array.from({ length: 21 }, (_, i) => <i class={`tick ${i % 5 === 0 ? 'major' : ''}`} style={{ left: `${i * 5}%` }} />)}
        <span class={`scale-fill ${t}`} style={{ left: `${Math.min(x(0), x(shown))}%`, width: `${Math.abs(x(shown) - x(0))}%` }} />
        <span class={`needle ${t}`} style={{ left: `${x(shown)}%` }} />
      </div>
      <div class="scale-ends" aria-hidden="true"><span class="calm-ink">Calm</span><span class="mono">0</span><span class="stress-ink">Stressed</span></div>
    </div>
  );
}

export function ScoreFigure({ score, label = 'Score', size = 'xl' }: { score: number; label?: string; size?: 'xl' | 'l' }) {
  return (
    <div class="score-figure">
      <span class={`num num-${size} ${tone(score)}`}>{fmtSigned(score)}</span>
      <span class="score-word">
        <span class="sr-only">{label} </span>
        {LEVEL_TEXT[levelOf(score)]}
      </span>
    </div>
  );
}

/** Background for a day cell: calm blue or stress red, stronger the further from zero. */
export function dayStyle(score: number | null | undefined): CSSProperties | undefined {
  if (score == null) return undefined;
  const pct = Math.round(14 + Math.min(1, Math.abs(score)) * 50);
  return { background: `color-mix(in oklab, var(--${score >= 0 ? 'stress' : 'calm'}) ${pct}%, var(--card))` };
}
export const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const dayScore = (cs: CheckIn[], day: number) => {
  const on = cs.filter((c) => sameDay(c.createdAt, day));
  return { n: on.length, score: avg(on.map((c) => c.score?.fused).filter((v): v is number => v != null)) };
};

/** Mon–Sun of the current week, each day coloured by its average score. */
export function WeekStrip({ checkins, now = Date.now(), label = 'This week' }: { checkins: CheckIn[]; now?: number; label?: string }) {
  const start = startOfWeek(now);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div class="week">
      <ol class="week-days" aria-label={label}>
        {days.map((d) => {
          const { n, score } = dayScore(checkins, d);
          const future = d > now;
          const today = sameDay(d, now);
          const name = DAYS_SHORT[new Date(d).getDay()];
          const desc = future ? 'not yet' : n === 0 ? 'no check-in' : score == null ? `${n} check-in${n > 1 ? 's' : ''}, no score yet` : `${fmtSigned(score)}, ${LEVEL_TEXT[levelOf(score)].toLowerCase()}`;
          return (
            <li class={`week-day ${today ? 'today' : ''}`}>
              <span class="week-name" aria-hidden="true">{name[0]}</span>
              <span class={`cell ${n === 0 ? 'none' : ''} ${future ? 'future' : ''}`} style={dayStyle(score)}>
                {n > 0 && score == null && <i class="dot" />}
              </span>
              <span class="week-val mono" aria-hidden="true">{score == null ? '' : fmtSigned(score, 1)}</span>
              <span class="sr-only">{today ? 'Today, ' : ''}{name}: {desc}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Legend() {
  return (
    <div class="legend-scale" aria-hidden="true">
      <span>Calm</span>
      {[-0.9, -0.5, -0.15, 0.15, 0.5, 0.9].map((v) => <i style={dayStyle(v)} />)}
      <span>Stressed</span>
    </div>
  );
}

export const QUALITY_TEXT: Record<Quality, string> = { good: 'Good', fair: 'Fair', poor: 'Poor' };
export function QualityMeter({ q, why }: { q: Quality; why: string | null }) {
  const lvl = q === 'good' ? 3 : q === 'fair' ? 2 : 1;
  return (
    <div class={`quality q-${q}`}>
      <span class="quality-bars" aria-hidden="true">{[1, 2, 3].map((i) => <i class={i <= lvl ? 'on' : ''} />)}</span>
      <span class="quality-label">Signal <b>{QUALITY_TEXT[q].toLowerCase()}</b></span>
      <span class="sr-only" aria-live="polite">{`Signal ${QUALITY_TEXT[q].toLowerCase()}. ${why ?? ''}`}</span>
    </div>
  );
}

/** The live pulse on recorder paper: the last `seconds` of samples, beats marked along the top. */
export function Trace({ subscribe, beats, seconds = 6, height = 132 }: {
  subscribe: (cb: (s: { t: number; v: number }) => void) => () => void;
  beats: number[];
  seconds?: number;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const buf = useRef<{ t: number; v: number }[]>([]);
  const beatsRef = useRef(beats);
  beatsRef.current = beats;
  useEffect(() => subscribe((s) => {
    buf.current.push(s);
    const cut = s.t - (seconds + 1) * 1000;
    while (buf.current.length && buf.current[0].t < cut) buf.current.shift();
  }), [subscribe]);
  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    const still = reducedMotion();
    const draw = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = getComputedStyle(c);
      ctx.clearRect(0, 0, w, h);
      // grid: minor every 0.2 s, major every second, as on chart paper
      const pps = w / seconds;
      const b = buf.current;
      const tEnd = b.length ? b[b.length - 1].t : Date.now();
      const phase = still ? 0 : (tEnd % 1000) / 1000;
      for (let i = -1; i <= seconds * 5 + 1; i++) {
        const xx = w - (i / 5 - phase) * pps;
        ctx.strokeStyle = css.getPropertyValue(i % 5 === 0 ? '--grid-major' : '--grid');
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(Math.round(xx) + 0.5, 0); ctx.lineTo(Math.round(xx) + 0.5, h); ctx.stroke();
      }
      for (let j = 1; j < 6; j++) {
        const yy = Math.round((h * j) / 6) + 0.5;
        ctx.strokeStyle = css.getPropertyValue(j === 3 ? '--grid-major' : '--grid');
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
      }
      if (b.length > 2) {
        const t0 = tEnd - seconds * 1000;
        const vis = b.filter((s) => s.t >= t0);
        // scale to the 3rd–97th percentile so one jolt does not flatten the pulse; clip the rest
        const sorted = vis.map((s) => s.v).sort((a, b) => a - b);
        const lo = sorted[Math.floor(sorted.length * 0.03)] ?? 0, hi = sorted[Math.floor(sorted.length * 0.97)] ?? 1;
        const span = Math.max(hi - lo, 0.5);
        const y = (v: number) => Math.min(h - 4, Math.max(4, h * 0.82 - ((v - lo) / span) * h * 0.62));
        ctx.strokeStyle = css.getPropertyValue('--ink');
        ctx.lineWidth = 1.8;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        vis.forEach((s, i) => { const xx = w - ((tEnd - s.t) / 1000) * pps; if (i) ctx.lineTo(xx, y(s.v)); else ctx.moveTo(xx, y(s.v)); });
        ctx.stroke();
        ctx.fillStyle = css.getPropertyValue('--ink');
        for (const bt of beatsRef.current) {
          if (bt < t0) continue;
          const xx = w - ((tEnd - bt) / 1000) * pps;
          ctx.fillRect(Math.round(xx) - 1, 6, 2, 9);
        }
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    draw();
    const iv = still ? window.setInterval(draw, 1000) : 0;
    return () => { cancelAnimationFrame(raf); clearInterval(iv); };
  }, [seconds]);
  return <canvas ref={ref} class="trace" style={{ height: `${height}px` }} aria-hidden="true" />;
}

export function SyncLine({ s, signedIn }: { s: SyncStatus; signedIn: boolean }) {
  if (!signedIn) return null;
  if (!s.online) return <p class="sync off"><IconOffline size={16} /><span>{s.pending ? `Offline. ${s.pending} saved on this phone; they will sync when you're back online.` : 'Offline. New check-ins are saved on this phone and sync later.'}</span></p>;
  if (s.error) return <p class="sync err"><IconOffline size={16} /><span>Could not sync: {s.error}</span></p>;
  if (s.syncing || s.pending) return <p class="sync"><IconCloud size={16} /><span>Syncing…</span></p>;
  return <p class="sync"><IconCloud size={16} /><span>{s.lastSyncedAt ? `Synced ${ago(s.lastSyncedAt)}` : 'Synced'}</span></p>;
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: ComponentChildren; disabled?: boolean }) {
  const id = useId();
  return (
    <div class="row switch-row">
      <div class="row-text">
        <label for={id} class="row-label">{label}</label>
        {hint && <p class="row-hint" id={`${id}-h`}>{hint}</p>}
      </div>
      <span class="switch">
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={hint ? `${id}-h` : undefined}
          onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
        <span class="switch-track" aria-hidden="true"><span class="switch-knob" /></span>
      </span>
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ComponentChildren; error?: string | null; children: (id: string, describedBy: string | undefined) => ComponentChildren }) {
  const id = useId();
  const desc = [hint ? `${id}-h` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div class={`field ${error ? 'has-error' : ''}`}>
      <label for={id}>{label}</label>
      {children(id, desc)}
      {hint && <p class="hint" id={`${id}-h`}>{hint}</p>}
      {error && <p class="error" id={`${id}-e`} role="alert">{error}</p>}
    </div>
  );
}

export function Stamp({ children }: { children: ComponentChildren }) {
  return <span class="stamp">{children}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span class="spinner" role="status"><span class="sr-only">{label}</span></span>;
}

export function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** The last `days` days on recorder paper: each check-in a dot (calm blue, stress red), a line through the daily averages. */
export function TrendChart({ checkins, days = 14, now = Date.now() }: { checkins: CheckIn[]; days?: number; now?: number }) {
  const W = 340, H = 128, L = 8, R = 8, T = 10, B = 22;
  const start = addDays(now, -(days - 1));
  const d0 = new Date(start); d0.setHours(0, 0, 0, 0);
  const t0 = d0.getTime();
  const span = days * 864e5;
  const x = (t: number) => L + ((t - t0) / span) * (W - L - R);
  const y = (v: number) => T + ((1 - v) / 2) * (H - T - B);
  const pts = checkins.filter((c) => c.createdAt >= t0 && c.score?.fused != null);
  const daily: [number, number][] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(t0, i);
    const { score } = dayScore(pts, d);
    if (score != null) daily.push([x(d + 432e5), y(score)]);
  }
  const labels = [0, 7, days - 1].map((i) => addDays(t0, i));
  return (
    <svg class="trend-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Scores over the last ${days} days: ${pts.length} check-ins, one dot each, with a line through the daily averages.`}>
      <rect class="paper" x={L} y={T} width={W - L - R} height={H - T - B} rx="4" />
      {Array.from({ length: days + 1 }, (_, i) => <line class={`g ${i % 7 === 0 ? 'major' : ''}`} x1={x(addDays(t0, i))} x2={x(addDays(t0, i))} y1={T} y2={H - B} />)}
      {[-0.5, 0.5].map((v) => <line class="g" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />)}
      <line class="zero" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
      {daily.length > 1 && <polyline class="line" points={daily.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')} />}
      {pts.map((c) => <circle class={`pt ${tone(c.score!.fused) || 'mid'}`} cx={x(c.createdAt)} cy={y(c.score!.fused!)} r="3.4" />)}
      {labels.map((d, i) => <text x={i === 0 ? L : i === 2 ? W - R : x(d)} y={H - 6} text-anchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{i === 2 ? 'TODAY' : `${new Date(d).getDate()} ${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][new Date(d).getMonth()]}`}</text>)}
    </svg>
  );
}
