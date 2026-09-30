import { useEffect, useRef } from 'preact/hooks';
import { SIGNALS } from '../model/score';
import { LEVEL_WORD, levelOf, SIGNAL_NAME } from '../narrate/templates';
import { DEFAULT_SCENARIO } from '../sim/scenario';
import { fmtSigned } from '../ui/format';
import { PenSwatch } from '../ui/pens';
import { Recorder } from '../ui/Recorder';
import { Transport } from '../ui/Transport';
import { ALL_IN, useRecorder } from '../ui/useRecorder';
import { applyTheme, parseIncoming, post } from './bridge';
import { runPipeline } from './pipeline';

export function Embed() {
  // Opens with the whole default session written; "play" replays it.
  const r = useRecorder(Number.POSITIVE_INFINITY);
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useRef(r);
  live.current = r;

  const report = (scenario = live.current.scenario, included = live.current.included) => {
    for (const s of runPipeline(scenario, included)) post({ type: 'stage', ...s, ms: Math.round(s.ms * 1000) / 1000 });
  };

  useEffect(() => {
    document.documentElement.classList.add('is-embed');
    const onMessage = (e: MessageEvent) => {
      const m = parseIncoming(e);
      if (!m) return;
      const x = live.current;
      if (m.type === 'theme') { applyTheme(m.tokens); return; }
      switch (m.name) {
        case 'play': report(); x.pb.restart(); break;
        case 'pull': {
          const next = { ...x.included, [m.signal]: !x.included[m.signal] };
          x.setIncluded(next);
          report(x.scenario, next);
          break;
        }
        case 'refit': {
          const next = { ...x.scenario, seed: x.scenario.seed + 1 };
          x.setScenario(next);
          report(next);
          x.pb.restart();
          break;
        }
        case 'reset':
          x.setScenario(DEFAULT_SCENARIO);
          x.setIncluded(ALL_IN);
          x.pb.pause();
          x.pb.seek(Number.POSITIVE_INFINITY);
          report(DEFAULT_SCENARIO, ALL_IN);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    report();
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      const px = Math.ceil(rootRef.current?.getBoundingClientRect().height ?? 0);
      if (px && px !== lastH) { lastH = px; post({ type: 'height', px }); }
    });
    if (rootRef.current) ro.observe(rootRef.current);
    return () => { window.removeEventListener('message', onMessage); ro.disconnect(); };
  }, []);

  const cur = r.now.fused;
  return (
    <div class="embed" ref={rootRef}>
      <main>
        <h1 class="sr-only">SafeSpace stress recorder</h1>
        <div class="embed-top">
          <span class="stamp mono">Simulated</span>
          <span class="embed-claim">Simulated session. Not recorded data.</span>
          <span class={`embed-now mono ${cur && !r.inCal ? (cur.score >= 0.1 ? 'stress' : cur.score <= -0.25 ? 'calm' : '') : ''}`}>
            {r.inCal ? 'calibrating' : cur ? `fused ${fmtSigned(cur.score)} ${LEVEL_WORD[levelOf(cur.score)]}` : 'no pens down'}
          </span>
        </div>
        <Recorder compact session={r.session} readings={r.readings} fused={r.fused} included={r.included}
          t={r.pb.t} at={r.at} now={r.now} active={null} onSeek={(t) => { r.pb.pause(); r.pb.seek(t); }} />
        <div class="embed-ctl">
          <Transport compact pb={r.pb} session={r.session} />
          <div class="pull-row" role="group" aria-label="Pens in the fused score">
            {SIGNALS.map((s) => (
              <button type="button" class={`pull${r.included[s] ? '' : ' off'}`} aria-pressed={r.included[s]}
                aria-label={`${SIGNAL_NAME[s]} in the fused score`}
                onClick={() => { const next = { ...r.included, [s]: !r.included[s] }; r.setIncluded(next); report(r.scenario, next); }}>
                <PenSwatch signal={s} w={20} /><span class="mono">{s.toUpperCase()}</span>
              </button>
            ))}
          </div>
        </div>
        <p class="embed-foot">
          Research demo, not a medical tool. <a href="/" target="_blank" rel="noopener">Open the full recorder</a>
        </p>
      </main>
    </div>
  );
}
