// /how-it-works: the original four-pen recorder and model notes, under the product's top bar.
// Its stylesheet is scoped under .sim so it cannot leak into the app.
import '../../styles/sim.css';
import { App as Simulator } from '../../ui/App';
import { PublicShell } from '../App';
import { Link } from '../router';

export function HowItWorks() {
  return (
    <PublicShell wide>
      <div class="hiw-intro">
        <p class="kicker">How it works</p>
        <h1>Four signals, one small model each</h1>
        <p class="lead">A check-in scores each signal it measured with its own model, against your resting baseline, and fuses them. This recorder plays a simulated session so you can see how: pull a pen out and the fused score is recomputed from the rest. <Link href="/check-in">Try a real check-in</Link>.</p>
      </div>
      <div class="sim"><Simulator bare /></div>
    </PublicShell>
  );
}
