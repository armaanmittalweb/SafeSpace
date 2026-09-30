import { MODELS, SIGNALS } from '../model/score';
import { SIGNAL_NAME } from '../narrate/templates';
import { FEATURE_UI } from './features';
import { fmt } from './format';
import { PenSwatch } from './pens';

const pct = (x: number) => `${Math.round(x * 100)}%`;

function AucCell({ v, sd }: { v: number; sd: number }) {
  return (
    <td class="num">
      <span class="mono">{fmt(v, v >= 0.99 ? 3 : 2)}</span>
      <span class="sd mono"> ± {fmt(sd, v >= 0.99 ? 3 : 2)}</span>
      <svg class="auc" width="64" height="6" viewBox="0 0 64 6" aria-hidden="true">
        <rect x="0" y="2" width="64" height="2" class="auc-track" />
        <line x1="32" x2="32" y1="0" y2="6" class="auc-chance" />
        <rect x="0" y="1" width={Math.max(0, v) * 64} height="4" class="auc-fill" />
      </svg>
    </td>
  );
}

export function ModelNotes() {
  const F = MODELS.fusion;
  const byc = F.by_condition_rest5;
  return (
    <section class="notes" id="model-notes" aria-labelledby="notes-h">
      <div class="section-head">
        <h2 id="notes-h">Model notes</h2>
        <p>What the four models were trained on, how well they did on people they had never seen, and where they fail.</p>
      </div>

      <div class="notes-grid">
        <div class="note">
          <h3>Data</h3>
          <p>WESAD: {MODELS.dataset.n_subjects} adults (12 men, 3 women, aged 24 to 35) in one lab session each, wearing an Empatica E4 on the wrist. Stress was induced with the Trier Social Stress Test (a speech to a panel, then mental arithmetic). Non-stress is sitting quietly and watching funny clips. Only the wrist signals are used: pulse (PPG), skin conductance, skin temperature and motion.</p>
        </div>
        <div class="note">
          <h3>Method</h3>
          <p>60-second windows every 15 seconds. Each feature is z-scored against the person's own first five minutes at rest, so a score means "this many resting standard deviations from you, at rest". One logistic regression per signal; the pen writes 2p − 1. The fused score is the mean of the pens' log-odds, so pulling a pen is exact, not an approximation. Tested leave-one-subject-out: every number below is for a person the model never saw.</p>
        </div>

        <div class="note">
          <h3>Engineering</h3>
          <p>Each model is exported to ONNX to prove it is portable, and this page scores with the same arithmetic directly: four dot products and a sigmoid, checked against onnxruntime to within 10<sup>−6</sup>. Nothing leaves your browser.</p>
        </div>

        <div class="note wide">
          <h3>Results on held-out people</h3>
          <table class="results">
            <caption class="sr-only">Leave-one-subject-out results with rest calibration, mean ± SD over held-out subjects</caption>
            <thead>
              <tr><th scope="col">Pen</th><th scope="col">Inputs</th><th scope="col" class="num">Balanced accuracy</th><th scope="col" class="num">ROC AUC</th></tr>
            </thead>
            <tbody>
              {SIGNALS.map((s) => {
                const m = MODELS.signals[s];
                return (
                  <tr>
                    <th scope="row"><PenSwatch signal={s} w={22} /> {SIGNAL_NAME[s]}{m.strength === 'weak' && <span class="tag weak">weak</span>}</th>
                    <td class="inputs">{m.features.map((f) => FEATURE_UI[f.name].label).join(', ')}</td>
                    <td class="num mono">{fmt(m.loso_rest5.balanced_accuracy.mean, 2)}<span class="sd"> ± {fmt(m.loso_rest5.balanced_accuracy.sd, 2)}</span></td>
                    <AucCell v={m.loso_rest5.roc_auc.mean} sd={m.loso_rest5.roc_auc.sd} />
                  </tr>
                );
              })}
              <tr class="fused-row">
                <th scope="row">Fused</th>
                <td class="inputs">mean of the four log-odds</td>
                <td class="num mono">{fmt(F.loso_rest5.balanced_accuracy.mean, 2)}<span class="sd"> ± {fmt(F.loso_rest5.balanced_accuracy.sd, 2)}</span></td>
                <AucCell v={F.loso_rest5.roc_auc.mean} sd={F.loso_rest5.roc_auc.sd} />
              </tr>
            </tbody>
          </table>
          <p class="fine">The fused score flags {pct(byc.stress.frac_flagged)} of stress windows, {pct(byc.baseline.frac_flagged)} of resting windows and {pct(byc.amusement.frac_flagged)} of amusement windows. Without the rest calibration the fused balanced accuracy falls to {fmt(F.loso_none.balanced_accuracy.mean, 2)}. The bar marks AUC against chance (0.5, the tick).</p>
        </div>

        <div class="note">
          <h3>Limitations</h3>
          <ul class="dash">
            <li>Fifteen people, one session each, one device. Other wearables differ in noise, rate and units.</li>
            <li>Lab stress only: it detects "TSST versus sitting quietly or watching clips", not everyday or chronic stress.</li>
            <li>Needs a clean resting segment first. Slow drifts after putting the device on (or a colder room, as for two WESAD subjects) can look like a change of state.</li>
            <li>HRV is weak: only {pct(MODELS.motion.hrv_valid_frac.stress)} of stress windows had enough clean beats, and it adds nothing measurable to the fused score.</li>
            <li>Temperature is weak: slow, and backwards for two subjects.</li>
          </ul>
        </div>
        <div class="note">
          <h3>Motion, the confound</h3>
          <p>During the stress test people stand, speak and gesture. Wrist motion alone separates stress from non-stress with an AUC of {fmt(MODELS.motion.auc_motion_alone, 2)}, and heart rate rises with movement whatever the mood. Motion is therefore never an input: it is only flagged (the marks along the bottom of the paper). The Walking step shows what happens: the heart-rate pen reads stress while skin conductance stays calm. Pull the heart-rate pen and the fused score settles.</p>
        </div>
        <div class="note">
          <h3>Why these are new models</h3>
          <p>The first SafeSpace monitor fitted a fresh scaler to each single sample before scoring it. A one-sample z-score is always zero, so every model saw the same input and every score was a constant, whatever the sensors said. The models were also split by window rather than by person. These v2 models were retrained from scratch on WESAD and tested on held-out people.</p>
        </div>
        <div class="note">
          <h3>What is not here yet</h3>
          <p>A typing and mouse pen is coming after retraining: its dataset needs a fresh download before it can be evaluated the same way. Recorded sessions will replace the simulator once the data licence question is settled.</p>
        </div>

        <div class="note wide cite">
          <h3>Data credit and terms</h3>
          <p>{MODELS.dataset.citation} WESAD may be used for scientific, non-commercial purposes, with credit. No WESAD data, raw or derived per window, is included in this page: the defaults are medians across subjects.</p>
          <p class="not-medical">SafeSpace is a research demo, not a medical tool. It cannot diagnose anything, and it should not be used to make decisions about health.</p>
        </div>
      </div>
    </section>
  );
}
