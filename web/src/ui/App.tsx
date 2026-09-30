import { useEffect, useState } from 'preact/hooks';
import { SIGNALS, type Signal } from '../model/score';
import { LEVEL_WORD, levelOf, SIGNAL_NAME } from '../narrate/templates';
import { PRESETS } from '../sim/presets';
import { Builder } from './Builder';
import { clock, fmtSigned } from './format';
import { ModelNotes } from './ModelNotes';
import { Narration } from './Narration';
import { PenPanel } from './PenPanel';
import { PenSwatch } from './pens';
import { Recorder } from './Recorder';
import { Transport } from './Transport';
import { useRecorder } from './useRecorder';

type Theme = 'light' | 'dark';
function readTheme(): Theme | null {
  try { const v = localStorage.getItem('ss-theme'); return v === 'light' || v === 'dark' ? v : null; } catch { return null; }
}
function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(readTheme);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  const effective = theme ?? systemTheme();
  const next: Theme = effective === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" class="btn ghost theme-toggle" aria-pressed={effective === 'dark'}
      onClick={() => { setTheme(next); try { localStorage.setItem('ss-theme', next); } catch { /* private mode */ } }}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2" />
        <path d="M7 1.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
      </svg>
      <span>Night panel</span>
    </button>
  );
}

function initialT(): number | null {
  const v = new URLSearchParams(location.search).get('at');
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function App() {
  const r = useRecorder(initialT());
  const [active, setActive] = useState<Signal | null>(null);
  const [editing, setEditing] = useState(false);
  const span = r.session.spans.find((s) => r.pb.t < s.end) ?? r.session.spans[r.session.spans.length - 1];
  const cur = r.now.fused;
  const lifted = SIGNALS.filter((s) => !r.included[s]);

  return (
    <>
      <a class="skip" href="#recorder">Skip to the recorder</a>
      <header class="masthead">
        <div class="brand">
          <h1><span class="wordmark">SafeSpace</span> <span class="sub">stress recorder</span></h1>
        </div>
        <nav aria-label="Sections">
          <a href="#scenario">Scenario</a>
          <a href="#model-notes">Model notes</a>
          <ThemeToggle />
        </nav>
      </header>
      <main id="main">
      <div class="lede">
        <p>Four wrist signals, each with its own small model, each writing its own trace between calm (−1) and stressed (+1). The fused score is the mean of their log-odds. Pull a pen and the fused score is recomputed from the others.</p>
        <p class="not-medical-inline mono">Research demo · not a medical tool</p>
      </div>

      <div class="deck" id="recorder">
        <div class="bench">
          <div class="sim-banner" role="note">
            <span class="stamp mono">Simulated</span>
            <span>Simulated from the settings you chose. Not recorded data.</span>
          </div>
          <Recorder session={r.session} readings={r.readings} fused={r.fused} included={r.included}
            t={r.pb.t} at={r.at} now={r.now} active={active && r.included[active] ? active : null} onSeek={(t) => { r.pb.pause(); r.pb.seek(t); }} />
          <ul class="legend" aria-label="Legend">
            <li class="fused-key"><svg width="28" height="10" aria-hidden="true"><line x1="1" y1="5" x2="27" y2="5" stroke="currentColor" stroke-width="2.6" /></svg>Fused</li>
            {SIGNALS.map((s) => (
              <li class={r.included[s] ? '' : 'off'}><PenSwatch signal={s} />{SIGNAL_NAME[s]}{!r.included[s] && <span class="sr-only"> (pulled)</span>}</li>
            ))}
            <li><span class="key-motion" aria-hidden="true" />Motion flag</li>
            <li><span class="key-cal" aria-hidden="true" />Calibration</li>
          </ul>
          <Transport pb={r.pb} session={r.session} />
        </div>

        <aside class="readout" aria-label="Reading at the playhead">
          <div class="now">
            <div class="now-meta mono">
              <span>{clock(r.pb.t)}</span>
              <span>{span.calibration ? 'Calibrating' : PRESETS[span.preset].name}</span>
              {r.win?.motion && !r.inCal && <span class="motion-chip">motion</span>}
            </div>
            <div class="now-main">
              <span class="now-label">Fused score</span>
              <span class={`now-value mono ${cur && !r.inCal ? (cur.score >= 0.1 ? 'stress' : cur.score <= -0.25 ? 'calm' : '') : ''}`}>
                {r.inCal || !cur ? <span class="placeholder">--</span> : fmtSigned(cur.score)}
              </span>
              <span class="now-word">{r.inCal ? 'calibrating' : cur ? LEVEL_WORD[levelOf(cur.score)] : 'no pens down'}</span>
            </div>
            {lifted.length > 0 && !r.inCal && (
              <p class="now-note">Fused from {SIGNALS.length - lifted.length} of 4 pens: {lifted.map((s) => SIGNAL_NAME[s].toLowerCase()).join(' and ')} pulled.</p>
            )}
            {r.now.edited && (
              <p class="now-note edited">What-if values at this moment. <button type="button" class="link-btn" onClick={r.clearEdits}>Back to the simulated values</button></p>
            )}
          </div>

          <Narration n={r.narration} readings={r.now.readings} settled={!r.pb.playing} inCal={r.inCal} />

          <div class="pens-head">
            <h2 class="kicker">Pens at this moment</h2>
            <button type="button" class="btn small" aria-pressed={editing} disabled={r.inCal}
              onClick={() => { setEditing(!editing); if (!editing) r.pb.pause(); else r.clearEdits(); }}>
              {editing ? 'Done' : 'What if...'}
            </button>
          </div>
          {r.inCal ? (
            <p class="empty-pens">The pens start writing at 05:00, once the resting reference is set. Each will show its score, the features behind it and how hard each one pushes.</p>
          ) : (
            <>
              <p class="pens-help">Bars show each feature's push on the log-odds of stress: coefficient × z, where z counts resting SDs from your baseline.{editing && ' Drag a value to try it.'}</p>
              <PenPanel readings={r.now.readings} raw={r.raw} cal={r.session.calibration} included={r.included}
                onToggle={r.toggle} onActive={setActive} editing={editing} edits={r.edits} onEdit={r.setEdit} inCal={r.inCal} />
            </>
          )}
        </aside>
      </div>

      <Builder scenario={r.scenario} session={r.session} onChange={r.setScenario} />
      <ModelNotes />
      </main>

      <footer class="colophon">
        <p>SafeSpace v2 · four logistic regressions trained on WESAD wrist signals, scored in your browser.</p>
        <p class="mono">Research demo · not a medical tool</p>
      </footer>
    </>
  );
}
