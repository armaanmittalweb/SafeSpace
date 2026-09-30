import type { Signal } from '../model/score';

/** Monochrome pens, told apart by stroke pattern (a technical drawing, not a rainbow). */
export const PEN: Record<Signal, { short: string; dash: string; width: number }> = {
  hr: { short: 'HR', dash: '', width: 1.6 },
  eda: { short: 'EDA', dash: '7 3', width: 1.6 },
  temp: { short: 'TEMP', dash: '1.2 3', width: 1.8 },
  hrv: { short: 'HRV', dash: '6 2.5 1.2 2.5', width: 1.3 },
};

export function PenSwatch({ signal, w = 28 }: { signal: Signal; w?: number }) {
  const p = PEN[signal];
  return (
    <svg class="swatch" width={w} height="10" viewBox={`0 0 ${w} 10`} aria-hidden="true">
      <line x1="1" y1="5" x2={w - 1} y2="5" stroke="currentColor" stroke-width={p.width + 0.2}
        stroke-dasharray={p.dash || undefined} stroke-linecap={p.dash.startsWith('1.2') ? 'round' : 'butt'} />
    </svg>
  );
}
