import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { SIGNALS, type Fused, type ReadingSet, type Signal } from '../model/score';
import { PRESETS } from '../sim/presets';
import { CAL_MIN, type Session } from '../sim/scenario';
import { LEVEL_WORD, levelOf, SIGNAL_NAME } from '../narrate/templates';
import { clock, fmtSigned } from './format';
import { PEN } from './pens';

export interface RecorderProps {
  session: Session;
  readings: ReadingSet[];
  fused: (Fused | null)[];
  included: Record<Signal, boolean>;
  /** Simulated minutes written so far. */
  t: number;
  /** Index of the window at the playhead, -1 before the first. */
  at: number;
  /** Readings and fused score at the playhead, possibly edited (what-if). */
  now: { readings: ReadingSet | null; fused: Fused | null; edited: boolean };
  active: Signal | null;
  compact?: boolean;
  onSeek?: (t: number) => void;
}

function useWidth<T extends Element>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Recorder(p: RecorderProps) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const narrow = W < 640;
  const H = p.compact ? (narrow ? 210 : 230) : narrow ? 280 : 400;
  const gaugeW = narrow ? 58 : 84;
  const gutter = !narrow && !p.compact ? 64 : 0; // pen labels between the paper and the gauge
  const x0 = narrow ? 30 : 40;
  const x1 = Math.max(x0 + 10, W - gaugeW - gutter);
  const y0 = 24;
  const y1 = H - 38;
  const T = p.session.total;
  const X = (m: number) => x0 + (m / T) * (x1 - x0);
  const Y = (s: number) => y0 + ((1 - s) / 2) * (y1 - y0);
  const wins = p.session.windows;
  const upto = p.at;

  const path = (val: (i: number) => number | null | undefined) => {
    let d = '';
    let pen = false;
    for (let i = p.session.firstScored; i <= upto; i++) {
      const v = val(i);
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${X(wins[i].end).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const areas = () => {
    const out: string[] = [];
    let run: string[] = [];
    let first = 0;
    let last = 0;
    const flush = () => {
      if (run.length > 1) out.push(`M${first.toFixed(1)} ${Y(0)}L${run.join('L')}L${last.toFixed(1)} ${Y(0)}Z`);
      run = [];
    };
    for (let i = p.session.firstScored; i <= upto; i++) {
      const f = p.fused[i];
      if (!f) { flush(); continue; }
      const x = X(wins[i].end);
      if (!run.length) first = x;
      last = x;
      run.push(`${x.toFixed(1)} ${Y(f.score).toFixed(1)}`);
    }
    flush();
    return out.join('');
  };

  const cur = p.now.fused;
  const tipX = upto >= 0 ? X(wins[upto].end) : X(0);
  const inCal = upto < p.session.firstScored;

  // pen labels in the gutter, pushed apart so they never overlap
  const labels: { s: Signal | 'fused'; y: number; text: string }[] = [];
  if (gutter && p.now.readings && !inCal) {
    for (const s of SIGNALS) {
      const r = p.now.readings[s];
      if (r && p.included[s]) labels.push({ s, y: Y(r.score), text: `${PEN[s].short} ${fmtSigned(r.score)}` });
    }
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
    const over = labels.length ? labels[labels.length - 1].y - (y1 - 4) : 0;
    if (over > 0) for (const l of labels) l.y -= over;
  }

  const minorEvery = T > 60 ? 5 : 1;
  const majorEvery = T > 60 ? 15 : 5;
  const vGrid: number[] = [];
  for (let m = 0; m <= T; m += minorEvery) vGrid.push(m);
  const hGrid: number[] = [];
  for (let k = -10; k <= 10; k++) hGrid.push(k / 10);

  const gx = W - gaugeW + 10; // gauge scale line
  const currentSpan = p.session.spans.find((s) => p.t < s.end) ?? p.session.spans[p.session.spans.length - 1];
  const describe = inCal
    ? `Calibrating at rest, ${clock(p.t)} of ${clock(T)} simulated minutes.`
    : `At ${clock(p.t)} of ${clock(T)} simulated minutes, ${PRESETS[currentSpan.preset].name}. Fused score ${cur ? fmtSigned(cur.score) : 'none'}. ` +
      SIGNALS.map((s) => {
        const r = p.now.readings?.[s];
        return `${SIGNAL_NAME[s]} ${!p.included[s] ? 'lifted' : r ? fmtSigned(r.score) : 'no reading'}`;
      }).join(', ') + '.';

  const seek = (e: PointerEvent) => {
    if (!p.onSeek) return;
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    const x = e.clientX - box.left;
    if (x < x0 || x > x1) return;
    p.onSeek(((x - x0) / (x1 - x0)) * T);
  };

  return (
    <div class={`recorder${p.compact ? ' compact' : ''}`} ref={ref}>
      {W > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={describe}
          onPointerDown={seek} class={p.onSeek ? 'seekable' : undefined}>
          <defs>
            <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" class="hatch-line" />
            </pattern>
            <clipPath id="clip-up"><rect x={x0} y={y0} width={x1 - x0} height={Y(0) - y0} /></clipPath>
            <clipPath id="clip-down"><rect x={x0} y={Y(0)} width={x1 - x0} height={y1 - Y(0)} /></clipPath>
          </defs>

          {/* paper */}
          <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} class="paper" />
          {vGrid.map((m) => (
            <line x1={X(m)} x2={X(m)} y1={y0} y2={y1} class={m % majorEvery === 0 ? 'grid major' : 'grid'} />
          ))}
          {hGrid.map((s) => (
            <line x1={x0} x2={x1} y1={Y(s)} y2={Y(s)} class={s === 0 ? 'grid zero' : Math.abs(s * 10) % 5 === 0 ? 'grid major' : 'grid'} />
          ))}

          {/* calibration: the first five minutes set the resting reference */}
          <rect x={X(0)} y={y0} width={X(CAL_MIN) - X(0)} height={y1 - y0} fill="url(#hatch)" class="cal" />
          {X(CAL_MIN) - X(0) > 70 && (
            <g class="cal-label">
              <text x={(X(0) + X(CAL_MIN)) / 2} y={Y(0) - 5} text-anchor="middle">CALIBRATING</text>
              <text x={(X(0) + X(CAL_MIN)) / 2} y={Y(0) + 12} text-anchor="middle">AT REST</text>
            </g>
          )}

          {/* event marks: one per segment of the script */}
          {p.session.spans.map((s) => {
            const w = X(s.end) - X(s.start);
            const label = s.calibration ? 'CAL' : PRESETS[s.preset].mark;
            const fits = w > label.length * 6.4 + 8;
            const on = s === currentSpan;
            return (
              <g class={`event${on ? ' on' : ''}`}>
                <line x1={X(s.start)} x2={X(s.start)} y1={y0 - 8} y2={y1} class="event-tick" />
                {fits && <text x={X(s.start) + 4} y={y0 - 8}>{label}</text>}
              </g>
            );
          })}

          {/* motion flags along the bottom edge */}
          {wins.map((w, i) => (w.motion && i <= upto && !w.calibration
            ? <rect x={X(w.end - 0.25)} y={y1 - 6} width={Math.max(1, X(0.25) - X(0))} height="6" class="motion" />
            : null))}

          {/* fused score: filled towards the side it leans */}
          <path d={areas()} class="fill-stress" clip-path="url(#clip-up)" />
          <path d={areas()} class="fill-calm" clip-path="url(#clip-down)" />

          {/* one pen per signal */}
          {SIGNALS.map((s) => p.included[s] && (
            <path d={path((i) => p.readings[i][s]?.score)} class={`pen pen-${s}${p.active && p.active !== s ? ' faded' : ''}${p.active === s ? ' hot' : ''}`}
              stroke-width={PEN[s].width} stroke-dasharray={PEN[s].dash || undefined} />
          ))}
          <path d={path((i) => p.fused[i]?.score)} class={`pen fused${p.active ? ' faded' : ''}`} />

          {/* carriage and pen tips */}
          {upto >= 0 && <line x1={tipX} x2={tipX} y1={y0} y2={y1} class="carriage" />}
          {!inCal && p.now.readings && SIGNALS.map((s) => {
            const r = p.now.readings![s];
            return r && p.included[s]
              ? <circle cx={tipX} cy={Y(r.score)} r={p.now.edited ? 3.5 : 2.4} class={`tip${p.now.edited ? ' edited' : ''}${p.active && p.active !== s ? ' faded' : ''}`} />
              : null;
          })}
          {!inCal && cur && <circle cx={tipX} cy={Y(cur.score)} r="4" class={`tip fused-tip${p.now.edited ? ' edited' : ''}`} />}

          {labels.map((l) => (
            <text x={x1 + 8} y={l.y + 3.5} class={`pen-label${p.active && p.active !== l.s ? ' faded' : ''}`}>{l.text}</text>
          ))}

          {/* y axis */}
          {[1, 0.5, 0, -0.5, -1].map((s) => (
            <text x={x0 - 6} y={Y(s) + 3.5} text-anchor="end" class="axis">{s === 0 ? '0' : fmtSigned(s, s % 1 ? 1 : 0).replace('0.', '.')}</text>
          ))}
          {/* time axis */}
          {vGrid.filter((m) => m % majorEvery === 0).map((m) => (
            <text x={X(m)} y={y1 + 15} text-anchor={m === 0 ? 'start' : m >= T - 1 ? 'end' : 'middle'} class="axis">{m}</text>
          ))}
          {!narrow && <text x={x1} y={y1 + 32} text-anchor="end" class="axis small">SIMULATED MINUTES</text>}

          {/* the fused score as a gauge needle at the right edge */}
          <g class="gauge">
            <text x={gx} y={y0 - 8} class="axis small">FUSED</text>
            <line x1={gx} x2={gx} y1={y0} y2={y1} class="gauge-scale" />
            {hGrid.filter((_, k) => k % 5 === 0).map((s) => (
              <line x1={gx} x2={gx + (s === 0 ? 10 : 6)} y1={Y(s)} y2={Y(s)} class="gauge-scale" />
            ))}
            <text x={gx + 12} y={y0 + 10} class="gauge-end stress">{narrow ? '+1' : 'stressed'}</text>
            <text x={gx + 12} y={y1 - 4} class="gauge-end calm">{narrow ? '−1' : 'calm'}</text>
            {cur && !inCal && (
              <g transform={`translate(0 ${Y(cur.score).toFixed(1)})`} class={`needle ${cur.score >= 0.1 ? 'stress' : cur.score <= -0.25 ? 'calm' : 'mid'}`}>
                <line x1={tipX} x2={gx} y1="0" y2="0" class="needle-trace" />
                <path d={`M${gx} 0 l9 -6 v12 z`} class="needle-head" />
                <text x={gx + 12} y="4" class="needle-value">{fmtSigned(cur.score)}</text>
              </g>
            )}
            {inCal && <text x={gx + 12} y={Y(0) + 4} class="axis">...</text>}
          </g>
        </svg>
      )}
      <p class="sr-only" aria-live="polite">{cur && !inCal ? `Fused ${LEVEL_WORD[levelOf(cur.score)]}` : ''}</p>
    </div>
  );
}
