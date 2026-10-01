import { Link } from '../router';

export function NotFound() {
  return (
    <div class="page narrow">
      <div class="empty not-found">
        <svg class="flatline" viewBox="0 0 240 48" aria-hidden="true"><path d="M0 30h70l8-20 10 34 8-14h144" /></svg>
        <p class="kicker">404</p>
        <h1>There is no page here</h1>
        <p class="muted">The link may be old, or the address mistyped.</p>
        <div class="actions center">
          <Link href="/" class="btn primary">Go to Today</Link>
          <Link href="/how-it-works" class="btn secondary">How it works</Link>
        </div>
      </div>
    </div>
  );
}
