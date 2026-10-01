// A simulated heart-rate strap for the playground, screenshots and tests. Beats swing with
// a slow breath (about 6 per minute, like paced breathing) and the level can be raised to
// mimic a challenge. Never offered to users.
import type { LiveInput } from '../contract';
import { BaseConnection, type LiveStatus } from './live-base';

export class FakeConnection extends BaseConnection {
  readonly device: string;
  readonly source = 'ble-hr' as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private t0 = Date.now();
  private phase = 0;
  /** Resting heart rate the simulation swings around. */
  base = 68;
  /** Extra bpm on top of base (e.g. +15 during a challenge). */
  lift = 0;

  constructor(opts: { device?: string; base?: number; battery?: number | null; hasRR?: boolean; history?: number } = {}) {
    super();
    this.device = opts.device ?? 'Polar H10 8C4F21A0';
    if (opts.base) this.base = opts.base;
    this.setStatus({ state: 'connected', battery: opts.battery === undefined ? 82 : opts.battery, hasRR: opts.hasRR ?? true, contact: true });
    this.emitQuality('good', null);
    // Pre-fill some history so charts are not empty on first paint.
    const hist = opts.history ?? 25;
    let t = Date.now() - hist * 1000;
    while (t < Date.now()) { const rr = this.nextRR(t); t += rr; this.pushBeat(t, rr); }
    this.schedule();
  }

  private nextRR(t: number): number {
    const s = (t - this.t0) / 1000;
    this.phase += 0.37;
    const hr = this.base + this.lift + 5 * Math.sin((2 * Math.PI * s) / 10) + 1.2 * Math.sin(this.phase);
    return 60000 / hr;
  }
  private pushBeat(t: number, rr: number) {
    this.emitBeat({ t: Math.round(t), rr: this.st.hasRR ? rr : null, hr: Math.round(60000 / rr) });
  }
  private schedule() {
    const rr = this.nextRR(Date.now());
    this.timer = setTimeout(() => { this.pushBeat(Date.now(), rr); this.schedule(); }, rr);
  }
  /** For the playground: show a link state without a real device. */
  simulate(p: Partial<LiveStatus>) { this.setStatus(p); }

  async disconnect(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setStatus({ state: 'disconnected' });
  }
}

export const fakeStrap: LiveInput = {
  kind: 'live', id: 'ble-hr', label: 'Simulated strap', gives: ['hr', 'hrv'],
  available: async () => ({ ok: true }),
  connect: async () => new FakeConnection(),
};
