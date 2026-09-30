import { Fragment } from 'preact';
import type { Calibration } from '../model/calibrate';
import { MODELS, SIGNALS, type Channel, type Feature, type ReadingSet, type Signal } from '../model/score';
import { SIGNAL_NAME } from '../narrate/templates';
import { FEATURE_UI } from './features';
import { fmt, fmtSigned } from './format';
import { PenSwatch } from './pens';

const SCALE = 4; // logits at the end of a contribution bar

function Bar({ v }: { v: number }) {
  const w = 56;
  const half = w / 2;
  const len = (Math.min(Math.abs(v), SCALE) / SCALE) * half;
  return (
    <svg class="bar" width={w} height="10" viewBox={`0 0 ${w} 10`} aria-hidden="true">
      <line x1={half} x2={half} y1="0" y2="10" class="bar-axis" />
      <rect x={v >= 0 ? half : half - len} y="2" width={Math.max(len, 0.75)} height="6" class={v >= 0 ? 'bar-stress' : 'bar-calm'} />
      {Math.abs(v) > SCALE && <path d={v > 0 ? `M${w - 3} 1 l3 4 l-3 4` : 'M3 1 l-3 4 l3 4'} class="bar-over" />}
    </svg>
  );
}

export interface PenPanelProps {
  readings: ReadingSet | null;
  raw: Record<Channel, number> | null;
  cal: Calibration;
  included: Record<Signal, boolean>;
  onToggle: (s: Signal) => void;
  onActive: (s: Signal | null) => void;
  editing: boolean;
  edits: Partial<Record<Feature, number>> | null;
  onEdit: (f: Feature, v: number) => void;
  inCal: boolean;
}

export function PenPanel(p: PenPanelProps) {
  return (
    <ul class="pens">
      {SIGNALS.map((s) => {
        const m = MODELS.signals[s];
        const r = p.readings?.[s] ?? null;
        const on = p.included[s];
        const id = `pen-${s}`;
        return (
          <li class={`pen-row${on ? '' : ' lifted'}`} onMouseEnter={() => p.onActive(s)} onMouseLeave={() => p.onActive(null)}
            onFocusIn={() => p.onActive(s)} onFocusOut={() => p.onActive(null)}>
            <div class="pen-head">
              <PenSwatch signal={s} />
              <h3 id={id}>{SIGNAL_NAME[s]}</h3>
              <span class={`pen-score mono ${r && on ? (r.score >= 0.1 ? 'stress' : r.score <= -0.25 ? 'calm' : '') : 'none'}`}>
                {p.inCal ? '' : r ? fmtSigned(r.score) : '--'}
              </span>
              <label class="lift">
                <input type="checkbox" role="switch" checked={on} onChange={() => p.onToggle(s)} aria-label={`${SIGNAL_NAME[s]} in the fused score`} />
                <span class="lift-track" aria-hidden="true"><span class="lift-knob" /></span>
                <span class="lift-text">{on ? 'In fusion' : 'Pulled'}</span>
              </label>
            </div>
            <p class="pen-note">
              <span class={`tag${m.strength === 'weak' ? ' weak' : ''}`}>{m.strength === 'weak' ? 'weak' : 'strong'}</span>
              AUC {fmt(m.loso_rest5.roc_auc.mean, 2)} on held-out people.{m.weak_reason ? ` ${m.weak_reason}` : ''}
            </p>
            {!p.inCal && !r && !p.editing && (
              <p class="pen-note gap">{s === 'hr' || s === 'hrv' ? 'Too few clean beats in this window. The pen lifts itself until they return.' : 'No reading in this window.'}</p>
            )}
            {!p.inCal && (r || p.editing) && p.raw && (
              <table class="contrib">
                <caption class="sr-only">{SIGNAL_NAME[s]}: feature values and their contribution to the log-odds of stress</caption>
                <thead class="sr-only">
                  <tr><th scope="col">Feature</th><th scope="col">Value</th><th scope="col">Resting SDs from rest</th><th scope="col">Contribution</th></tr>
                </thead>
                <tbody>
                  {m.features.map((f, i) => {
                    const ui = FEATURE_UI[f.name];
                    const c = r?.contributions[i];
                    const v = p.raw![f.name];
                    return (
                      <Fragment key={f.name}>
                      <tr>
                        <th scope="row">{ui.label}</th>
                        <td class="val mono">{fmt(v, ui.digits)}<span class="unit"> {ui.unit}</span></td>
                        <td class="z mono">{c ? `z ${fmtSigned(c.z, 1)}` : ''}</td>
                        <td class="c">{c && <Bar v={c.value} />}<span class="mono">{c ? fmtSigned(c.value, 2) : ''}</span></td>
                      </tr>
                      {p.editing && (
                        <tr class="edit-row">
                          <td colSpan={4}>
                            <input type="range" min={ui.min} max={ui.max} step={ui.step} value={v}
                              aria-label={`${SIGNAL_NAME[s]}: ${ui.label}, ${ui.unit}`} aria-valuetext={`${fmt(v, ui.digits)} ${ui.unit}`}
                              class={p.edits && f.name in p.edits ? 'edited' : undefined}
                              onInput={(e) => p.onEdit(f.name, Number((e.target as HTMLInputElement).value))} />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    );
                  })}
                  <tr class="bias">
                    <th scope="row">Bias</th>
                    <td class="val mono" />
                    <td class="z mono" />
                    <td class="c"><Bar v={m.intercept} /><span class="mono">{fmtSigned(m.intercept, 2)}</span></td>
                  </tr>
                </tbody>
              </table>
            )}
          </li>
        );
      })}
    </ul>
  );
}
