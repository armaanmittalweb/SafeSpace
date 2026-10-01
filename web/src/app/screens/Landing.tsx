import { useMemo } from 'preact/hooks';
import { Link } from '../router';
import { sampleData } from '../sample';
import { Stamp } from '../ui';
import { TodayView } from './Today';

export function Landing() {
  const now = Date.now();
  const sample = useMemo(() => sampleData(now), []);
  return (
    <div class="landing">
      <section class="landing-top" aria-labelledby="l-h">
        <div class="landing-intro">
          <h1 id="l-h">A stress <span class="nowrap">check-in</span> you can take with your phone.</h1>
          <p class="lead">Rest a fingertip on the camera for 60 seconds. SafeSpace reads your pulse, compares it with your own resting baseline, and tells you plainly what it saw and what it could not measure.</p>
          <div class="actions">
            <Link href="/check-in" class="btn primary">Try a check-in</Link>
            <Link href="/signup" class="btn secondary">Create an account</Link>
          </div>
          <p class="fine">Trying it needs no account, and nothing is saved.</p>
        </div>
        <figure class="sample-frame" aria-labelledby="sample-cap">
          <figcaption id="sample-cap" class="sample-cap">
            <Stamp>Sample</Stamp>
            <span>Asha's Today screen, five weeks in</span>
          </figcaption>
          <div class="sample-body" inert>
            <TodayView checkins={sample.checkins} baseline={sample.baseline} sample now={now} />
          </div>
        </figure>
      </section>

      <div class="landing-text">
        <section aria-labelledby="m-h">
          <h2 id="m-h">What it measures</h2>
          <p>Your phone's camera sees the tiny colour change in your fingertip each time your heart beats. From one minute of that, SafeSpace works out your heart rate and heart-rate variability, the two signals a camera can give. A wearable adds skin conductance and skin temperature.</p>
          <p>Each signal has its own small model, trained on the WESAD study of wrist signals under stress, and each is read against your own resting baseline rather than against other people. The result names every signal it used and every one it could not measure. It is not a medical device and does not diagnose anything.</p>
        </section>
        <section aria-labelledby="d-h">
          <h2 id="d-h">Devices it works with</h2>
          <dl class="dev-table">
            <div><dt>Phone camera</dt><dd>Every phone and laptop. Fingertip over the lens and flash. Heart rate, and heart-rate variability when the signal is good.</dd></div>
            <div><dt>Heart-rate strap or watch</dt><dd>Any Bluetooth heart-rate device (Polar H10, Garmin HRM, Wahoo TICKR, watches that broadcast heart rate). Chrome and Edge on Android, Windows and macOS; iPhone Safari has no Bluetooth.</dd></div>
            <div><dt>Files</dt><dd>Apple Health, Fitbit and Empatica E4 exports, read in your browser and never uploaded.</dd></div>
          </dl>
        </section>
        <section aria-labelledby="p-h">
          <h2 id="p-h">Privacy</h2>
          <p>Check-ins are encrypted on your device with a key only you hold, so the server stores data it cannot read. Camera frames never leave your phone; only the numbers from each minute are kept. At sign-up you get a recovery key: lose both it and your password and your data is gone, for us as much as for you.</p>
        </section>
        <section aria-labelledby="h-h">
          <h2 id="h-h">How it works</h2>
          <p>The models, their accuracy and their limits are on <Link href="/how-it-works">How it works</Link>, with the four-signal recorder you can play with. The <a href="https://github.com/armaanmittalweb/SafeSpace">case study and code</a> describe how the models were trained and why an earlier version's scores were constant.</p>
        </section>
      </div>
      <footer class="site-foot">
        <span>SafeSpace</span>
        <span>Not a medical device</span>
        <Link href="/how-it-works">How it works</Link>
        <a href="https://www.amittal.dev/">amittal.dev</a>
      </footer>
    </div>
  );
}
