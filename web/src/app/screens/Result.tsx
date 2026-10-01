import type { ComponentChildren } from 'preact';
import type { Baseline, CheckIn, Signal } from '../../contract/records';
import { fmtSigned, stamp } from '../format';
import { SIGNALS } from '../../model/score';
import { BASELINE_NEEDED, describeSignal, feelingWord, isWeak, SIGNAL_LABEL, SIGNAL_SHORT, signalsIn, tone } from '../scoring';
import { QUALITY_TEXT, ScoreFigure, ScoreScale } from '../ui';

const SOURCE_TEXT: Record<string, string> = {
  camera: 'Phone camera', 'ble-hr': 'Heart-rate strap', 'polar-h10': 'Polar H10', 'import-apple': 'Apple Health', 'import-fitbit': 'Fitbit', 'import-e4': 'Empatica E4', manual: 'Self-report',
};

function SignalBar({ score }: { score: number }) {
  const w = Math.min(1, Math.abs(score)) * 50;
  return (
    <span class="sig-bar" aria-hidden="true">
      <i class="sig-zero" />
      <i class={`sig-fill ${score >= 0 ? 'stress' : 'calm'}`} style={{ left: score >= 0 ? '50%' : `${50 - w}%`, width: `${w}%` }} />
    </span>
  );
}

export function ResultView({ c, baseline, baselineCount, children }: { c: CheckIn; baseline: Baseline | null; baselineCount: number; children?: ComponentChildren }) {
  const m = c.measurement;
  const { used, notUsed } = signalsIn(m, c.score ? baseline : null);
  const fused = c.score?.fused ?? null;
  const heartOnly = used.every((s) => s === 'hr' || s === 'hrv');
  const scored = Object.keys(c.score?.bySignal ?? {}) as Signal[];
  const order = SIGNALS.filter((s) => scored.includes(s));
  return (
    <div class="result">
      <section class="card result-main" aria-labelledby="res-h">
        {fused != null ? (
          <>
            <h2 id="res-h" class="kicker">{heartOnly ? 'Heart-based score' : 'Score'}</h2>
            <ScoreFigure score={fused} label={heartOnly ? 'Heart-based score' : 'Score'} />
            <ScoreScale score={fused} />
            <p class="fine">From {order.map((s) => SIGNAL_LABEL[s].toLowerCase()).join(' and ')}, against your resting baseline. Not a medical device.</p>
          </>
        ) : m && m.features.hr_mean != null ? (
          <>
            <h2 id="res-h" class="kicker">Heart rate</h2>
            <div class="score-figure"><span class="num num-xl">{Math.round(m.features.hr_mean)}<span class="unit">bpm</span></span></div>
            {!c.score && (
              <p class="muted">No score yet. Scores start once your baseline has {BASELINE_NEEDED} resting readings on different days; you have {Math.min(baselineCount, BASELINE_NEEDED)}.</p>
            )}
            {c.score && <p class="muted">Nothing in this reading could be scored against your baseline.</p>}
          </>
        ) : (
          <>
            <h2 id="res-h" class="kicker">How you feel</h2>
            <div class="score-figure"><span class="num num-l">{feelingWord(c.feeling) ?? 'Not said'}</span></div>
            <p class="muted">{m ? 'The signal was too weak to read a heart rate. Your feeling and tags are still worth keeping.' : 'Nothing was measured this time, so there is no score.'}</p>
          </>
        )}
      </section>

      {order.length > 0 && (
        <section class="card" aria-labelledby="sig-h">
          <h2 id="sig-h" class="kicker">What went into it</h2>
          <ul class="sig-list">
            {order.map((s) => {
              const sc = c.score!.bySignal[s]!.score;
              const d = describeSignal(s, m!, baseline);
              return (
                <li class="sig">
                  <div class="sig-top">
                    <span class="sig-name">{SIGNAL_SHORT[s]} <span class="mono">{d.value}</span></span>
                    <span class={`mono sig-score ${tone(sc)}`}>{fmtSigned(sc)}</span>
                  </div>
                  <SignalBar score={sc} />
                  <p class="sig-words">
                    {d.vsRest}{d.vsRest ? '. ' : ''}
                    {sc >= 0.2 ? 'Pushes towards stressed.' : sc <= -0.2 ? 'Reads as calm.' : 'Close to neutral.'}
                    {isWeak(s) && ' Weak signal: this model is less reliable than the heart-rate one.'}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {m && notUsed.length > 0 && (
        <section class="card quiet" aria-labelledby="nm-h">
          <h2 id="nm-h" class="kicker">Not measured</h2>
          <ul class="nm-list">
            {notUsed.filter((n) => n.signal === 'hr' || n.signal === 'hrv').map((n) => <li><b>{SIGNAL_LABEL[n.signal]}.</b> {n.reason}</li>)}
            {(() => {
              const w = notUsed.filter((n) => n.signal === 'eda' || n.signal === 'temp');
              if (w.length === 2 && w[0].reason === w[1].reason) return <li><b>Skin conductance and skin temperature.</b> A phone camera cannot see them; they need a wearable such as an Empatica E4.</li>;
              return w.map((n) => <li><b>{SIGNAL_LABEL[n.signal]}.</b> {n.reason}</li>);
            })()}
          </ul>
        </section>
      )}

      {(c.feeling || c.tags.length > 0 || c.note) && (
        <section class="card" aria-labelledby="you-h">
          <h2 id="you-h" class="kicker">You said</h2>
          <dl class="kv">
            {c.feeling && <div><dt>Feeling</dt><dd>{feelingWord(c.feeling)}</dd></div>}
            {c.tags.length > 0 && <div><dt>Tags</dt><dd>{c.tags.map((t) => <span class="tag">{t}</span>)}</dd></div>}
            {c.note && <div><dt>Note</dt><dd>{c.note}</dd></div>}
          </dl>
        </section>
      )}

      {c.narration && (
        <section class="card note-card" aria-labelledby="note-h">
          <div class="card-head">
            <h2 id="note-h" class="kicker">Note</h2>
            <span class="kicker">{c.narration.source === 'llm' ? `Written by ${c.narration.model ?? 'a language model'}` : 'Written from your numbers'}</span>
          </div>
          <p class="note-text">{c.narration.text}</p>
        </section>
      )}

      {m && (
        <p class="provenance">
          {stamp(m.startedAt)} · {SOURCE_TEXT[m.source]}{m.device && m.source !== 'camera' ? ` (${m.device})` : ''} · {m.durationS} s · signal {QUALITY_TEXT[m.quality].toLowerCase()}
          {m.motion?.flagged ? ' · movement noticed' : ''}
        </p>
      )}
      {children}
    </div>
  );
}
