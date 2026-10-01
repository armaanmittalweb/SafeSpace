import { useState } from 'preact/hooks';
import { IconBack, IconCamera, IconFile, IconStrap, Mark } from '../icons';
import { navigate } from '../router';
import { setState, useApp } from '../store';
import { Field } from '../ui';
import { vault } from '../vault';
import { RecoveryKeyPanel } from './Auth';

function Progress({ step }: { step: number }) {
  return (
    <div class="flow-progress">
      <span class="kicker">Step {step} of 3</span>
      <ol aria-hidden="true">{[1, 2, 3].map((i) => <li class={i <= step ? 'on' : ''} />)}</ol>
    </div>
  );
}

function NewKey({ onKey }: { onKey(k: string): void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form class="form" onSubmit={async (e) => {
      e.preventDefault();
      try { onKey(await vault.regenerateRecoveryKey(pw)); } catch (x) { setErr((x as Error).message); }
    }}>
      <p class="muted">The key from sign-up is only shown once and this page was reloaded, so make a new one now. The old one will stop working.</p>
      <Field label="Password" error={err}>{(id, d) => <input id={id} type="password" autocomplete="current-password" aria-describedby={d} value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />}</Field>
      <button class="btn primary block">Make a recovery key</button>
    </form>
  );
}

export function Welcome() {
  const s = useApp();
  const [step, setStep] = useState(1);
  const [key, setKey] = useState<string | null>(s.recoveryKey);
  return (
    <div class="welcome">
      <header class="flow-bar">
        {step > 1 ? <button type="button" class="icon-btn" aria-label="Back" onClick={() => setStep(step - 1)}><IconBack /></button> : <Mark size={28} />}
        <Progress step={step} />
      </header>

      {step === 1 && (
        <section class="welcome-step" aria-labelledby="w1">
          <h1 id="w1">What SafeSpace can tell you, and what it can't</h1>
          <div class="two-lists">
            <div>
              <h2 class="kicker">It measures</h2>
              <ul class="plain-list">
                <li><b>Heart rate</b> from your fingertip on the phone camera, or from a heart-rate strap.</li>
                <li><b>Heart-rate variability</b>, when the signal is clean enough to trust.</li>
                <li><b>Skin conductance and temperature</b>, only with a wearable that records them.</li>
              </ul>
            </div>
            <div>
              <h2 class="kicker">It cannot</h2>
              <ul class="plain-list">
                <li>Diagnose anything, or tell you why you feel the way you do.</li>
                <li>Compare you with other people. Every score is against your own resting baseline.</li>
                <li>Tell stress from exercise or coffee on its own. Tags help you tell them apart.</li>
              </ul>
            </div>
          </div>
          <p class="fine">SafeSpace is not a medical device. If you are worried about your heart or your mental health, talk to a doctor.</p>
          <button type="button" class="btn primary block" onClick={() => setStep(2)}>Continue</button>
        </section>
      )}

      {step === 2 && (
        <section class="welcome-step" aria-labelledby="w2">
          <h1 id="w2">Your data, and your recovery key</h1>
          <ul class="plain-list">
            <li>Check-ins are encrypted on this device before they are sent. The server stores what it cannot read.</li>
            <li>Camera frames never leave your phone. Only the numbers from each minute are kept.</li>
            <li>This key is the only way back in if you forget your password. We cannot reset it for you.</li>
          </ul>
          {key ? (
            <RecoveryKeyPanel keyText={key} onContinue={() => { setState({ recoveryKey: null }); setStep(3); }} />
          ) : (
            <NewKey onKey={setKey} />
          )}
        </section>
      )}

      {step === 3 && (
        <section class="welcome-step" aria-labelledby="w3">
          <h1 id="w3">How will you measure?</h1>
          <p class="lead">Start with the camera; you can connect a device at any time.</p>
          <ul class="option-list">
            <li class="option static">
              <IconCamera />
              <span><b>Phone camera</b><small>Fingertip over the lens and flash for 60 seconds. Heart rate and HRV. Works on every phone.</small></span>
            </li>
            <li class="option static">
              <IconStrap />
              <span><b>Heart-rate strap or watch</b><small>More accurate HRV over Bluetooth, in Chrome or Edge. Connect it from Devices.</small></span>
            </li>
            <li class="option static">
              <IconFile />
              <span><b>Import a file</b><small>Apple Health, Fitbit or Empatica E4 exports, read on this device.</small></span>
            </li>
          </ul>
          <div class="baseline-intro">
            <h2 class="card-title">Next: baseline 1 of 3</h2>
            <p class="muted">Scores need to know what calm looks like for you. Sit quietly for two minutes, then take a one-minute reading. Do this on three different days; scores start after the third.</p>
          </div>
          <button type="button" class="btn primary block" onClick={() => navigate('/baseline', { replace: true })}>Take baseline reading 1</button>
          <button type="button" class="btn ghost block" onClick={() => navigate('/', { replace: true })}>Later</button>
        </section>
      )}
    </div>
  );
}
