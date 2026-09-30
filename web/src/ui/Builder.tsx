import { MODELS, SIGNALS, type Feature } from '../model/score';
import { SIGNAL_NAME } from '../narrate/templates';
import { PRESET_ORDER, PRESETS, type PresetId } from '../sim/presets';
import { CAL_MIN, DEFAULT_SCENARIO, type Scenario, type Session } from '../sim/scenario';
import { FEATURE_UI } from './features';
import { fmt } from './format';

export function Builder({ scenario, session, onChange }: { scenario: Scenario; session: Session; onChange: (s: Scenario) => void }) {
  const setBase = (f: Feature, v: number) => onChange({ ...scenario, baseline: { ...scenario.baseline, [f]: v } });
  const segs = scenario.segments;
  const setSegs = (segments: typeof segs) => onChange({ ...scenario, segments });
  const total = session.total;

  return (
    <section class="builder" id="scenario" aria-labelledby="builder-h">
      <div class="section-head">
        <h2 id="builder-h">Scenario</h2>
        <p>Recorded sessions cannot be published yet, so the recorder plays a session simulated from these settings. Change anything and it is rewritten at once.</p>
      </div>

      <div class="builder-grid">
        <fieldset class="baseline">
          <legend>Resting baseline</legend>
          <p class="hint">Your values at rest, in natural units. Defaults are the medians of the 15 WESAD subjects' first five minutes at rest.</p>
          {SIGNALS.map((s) => (
            <div class="base-group">
              <h3 class="kicker">{SIGNAL_NAME[s]}</h3>
              {MODELS.signals[s].features.map(({ name }) => {
                const ui = FEATURE_UI[name];
                const v = scenario.baseline[name];
                const id = `base-${name}`;
                return (
                  <div class="field">
                    <label for={id}>{ui.label}</label>
                    <input id={id} type="range" min={ui.min} max={ui.max} step={ui.step} value={v}
                      aria-valuetext={`${fmt(v, ui.digits)} ${ui.unit}`}
                      onInput={(e) => setBase(name, Number((e.target as HTMLInputElement).value))} />
                    <output for={id} class="mono">{fmt(v, ui.digits)}<span class="unit"> {ui.unit}</span></output>
                  </div>
                );
              })}
            </div>
          ))}
          <p class="cal-readout mono">
            Calibrated on {session.calibration.n} windows: HR {fmt(session.calibration.mean.hr_mean, 1)} ± {fmt(session.calibration.sd.hr_mean, 1)} bpm,
            EDA {fmt(session.calibration.mean.eda_tonic, 2)} ± {fmt(session.calibration.sd.eda_tonic, 2)} µS
          </p>
        </fieldset>

        <fieldset class="script">
          <legend>Session script</legend>
          <p class="hint">Each step lasts whole minutes. Levels move towards the step's targets with realistic lag: heart rate in seconds, skin conductance over minutes, temperature slower still.</p>
          <ol class="steps">
            <li class="step fixed">
              <span class="step-n mono">00</span>
              <div class="step-body">
                <span class="step-name">Calibrate at rest</span>
                <span class="step-blurb">Fixed. The first {CAL_MIN} minutes set the reference every score is measured from.</span>
              </div>
              <span class="step-min mono">{CAL_MIN} min</span>
            </li>
            {segs.map((seg, i) => {
              const P = PRESETS[seg.preset];
              const selId = `seg-${i}`;
              return (
                <li class="step">
                  <span class="step-n mono">{String(i + 1).padStart(2, '0')}</span>
                  <div class="step-body">
                    <label class="sr-only" for={selId}>Step {i + 1} activity</label>
                    <select id={selId} value={seg.preset}
                      onChange={(e) => setSegs(segs.map((x, j) => (j === i ? { ...x, preset: (e.target as HTMLSelectElement).value as PresetId } : x)))}>
                      {PRESET_ORDER.map((id) => <option value={id}>{PRESETS[id].name}</option>)}
                    </select>
                    <span class="step-blurb">{P.blurb}</span>
                  </div>
                  <div class="step-ctl">
                    <div class="stepper" role="group" aria-label={`Step ${i + 1} length`}>
                      <button type="button" aria-label="One minute shorter" disabled={seg.minutes <= 1}
                        onClick={() => setSegs(segs.map((x, j) => (j === i ? { ...x, minutes: x.minutes - 1 } : x)))}>−</button>
                      <span class="mono" aria-live="polite">{seg.minutes} min</span>
                      <button type="button" aria-label="One minute longer" disabled={seg.minutes >= 30}
                        onClick={() => setSegs(segs.map((x, j) => (j === i ? { ...x, minutes: x.minutes + 1 } : x)))}>+</button>
                    </div>
                    <button type="button" class="link-btn" aria-label={`Remove step ${i + 1}, ${P.name}`} disabled={segs.length <= 1}
                      onClick={() => setSegs(segs.filter((_, j) => j !== i))}>Remove</button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div class="add-row" role="group" aria-label="Add a step">
            <span class="kicker">Add</span>
            {PRESET_ORDER.map((id) => (
              <button type="button" class="chip" disabled={segs.length >= 12}
                onClick={() => setSegs([...segs, { preset: id, minutes: id === 'speaking' ? 10 : 5 }])}>{PRESETS[id].name}</button>
            ))}
          </div>
          <div class="script-foot">
            <span class="mono">Total {total} simulated minutes · noise seed {scenario.seed}</span>
            <span class="script-actions">
              <button type="button" class="link-btn" onClick={() => onChange({ ...scenario, seed: scenario.seed + 1 })}>Reshuffle noise</button>
              <button type="button" class="link-btn" onClick={() => onChange(DEFAULT_SCENARIO)}>Restore defaults</button>
            </span>
          </div>
          <p class="hint source-note">Where the shifts come from: public speaking and amusement use the WESAD medians for those conditions; walking is hand-set, since WESAD has no walking condition.</p>
        </fieldset>
      </div>
    </section>
  );
}
