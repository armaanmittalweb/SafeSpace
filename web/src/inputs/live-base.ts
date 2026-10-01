// Common plumbing for live beat sources (Bluetooth straps, the Polar H10, the fake
// connection used by the playground and tests). Subclasses call emitBeat / emitQuality /
// setStatus; measure() and the subscriptions are handled here.
import type { Beat, InputSource, LiveConnection, Measurement, Quality } from '../contract';
import { measurementFromHr, measurementFromRR } from '../signal/hrv';

export type LinkState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface LiveStatus {
  state: LinkState;
  /** Battery level 0..100 when the device reports it. */
  battery: number | null;
  /** Whether the device sends beat-to-beat intervals (null until the first reading). */
  hasRR: boolean | null;
  /** Skin contact as reported by the device; null when the device does not say. */
  contact: boolean | null;
  /** Reconnection attempt number while state is 'reconnecting'. */
  attempt: number;
  /** A sentence for the UI when something is wrong, else null. */
  message: string | null;
}

export type { Beat };

/** A LiveConnection with the extra status the Devices panel shows. */
export interface StatusConnection extends LiveConnection {
  readonly source: InputSource;
  status(): LiveStatus;
  onStatus(cb: (s: LiveStatus) => void): () => void;
  /** Beats received in the last `seconds` seconds, oldest first. */
  recent(seconds: number): Beat[];
}

const KEEP_MS = 20 * 60 * 1000;

export abstract class BaseConnection implements StatusConnection {
  abstract readonly device: string;
  abstract readonly source: InputSource;
  protected beats: Beat[] = [];
  private beatSubs = new Set<(b: Beat) => void>();
  private qualitySubs = new Set<(q: Quality, why: string | null) => void>();
  private statusSubs = new Set<(s: LiveStatus) => void>();
  private goneSubs = new Set<() => void>();
  private lastQuality: [Quality, string | null] | null = null;
  protected st: LiveStatus = { state: 'connecting', battery: null, hasRR: null, contact: null, attempt: 0, message: null };
  /** Set by subclasses that keep raw beats in the Measurement (user setting). */
  keepBeats = false;

  protected now(): number { return Date.now(); }

  onBeat(cb: (b: Beat) => void): () => void {
    this.beatSubs.add(cb);
    return () => this.beatSubs.delete(cb);
  }
  onQuality(cb: (q: Quality, why: string | null) => void): () => void {
    this.qualitySubs.add(cb);
    if (this.lastQuality) cb(...this.lastQuality);
    return () => this.qualitySubs.delete(cb);
  }
  onStatus(cb: (s: LiveStatus) => void): () => void {
    this.statusSubs.add(cb);
    cb(this.st);
    return () => this.statusSubs.delete(cb);
  }
  status(): LiveStatus { return this.st; }
  battery(): Promise<number | null> { return Promise.resolve(this.st.battery); }
  /** Fires once when the device goes away for good (reconnection gave up), not on a user disconnect. */
  onDisconnect(cb: () => void): () => void {
    this.goneSubs.add(cb);
    return () => this.goneSubs.delete(cb);
  }
  protected emitGone(): void {
    for (const cb of this.goneSubs) cb();
    this.goneSubs.clear();
  }

  recent(seconds: number): Beat[] {
    const from = this.now() - seconds * 1000;
    let i = this.beats.length;
    while (i > 0 && this.beats[i - 1].t >= from) i--;
    return this.beats.slice(i);
  }

  protected emitBeat(b: Beat): void {
    this.beats.push(b);
    if (this.beats.length > 64 && this.beats[0].t < b.t - KEEP_MS) {
      const cut = this.beats.findIndex((x) => x.t >= b.t - KEEP_MS);
      this.beats.splice(0, cut);
    }
    for (const cb of this.beatSubs) cb(b);
  }
  protected emitQuality(q: Quality, why: string | null): void {
    if (this.lastQuality && this.lastQuality[0] === q && this.lastQuality[1] === why) return;
    this.lastQuality = [q, why];
    for (const cb of this.qualitySubs) cb(q, why);
  }
  protected setStatus(p: Partial<LiveStatus>): void {
    this.st = { ...this.st, ...p };
    for (const cb of this.statusSubs) cb(this.st);
  }

  /** Motion over [from, to] (epoch ms) when the device measures it; subclasses override. */
  protected motionBetween(_from: number, _to: number): { accStd: number; flagged: boolean } | null { return null; }

  /** Builds a Measurement from the beats between two times (used by measure and the stress session). */
  measurementBetween(from: number, to: number): Measurement {
    const win = this.beats.filter((b) => b.t >= from && b.t < to);
    const durationS = (to - from) / 1000;
    const rr = win.filter((b) => b.rr != null).map((b) => b.rr as number);
    const motion = this.motionBetween(from, to);
    const hasRR = rr.length >= 3;
    const m = hasRR
      ? measurementFromRR(rr, { source: this.source, device: this.device, startedAt: from, durationS, keepBeats: this.keepBeats, accStd: motion?.accStd, motionFlagged: motion?.flagged })
      : measurementFromHr(win.map((b) => b.hr), { source: this.source, device: this.device, startedAt: from, durationS, expected: durationS });
    if (!hasRR && motion) { m.features.acc_std = motion.accStd; m.motion = { flagged: motion.flagged, accStd: motion.accStd }; }
    return m;
  }

  measure(durationS: number, signal?: AbortSignal): Promise<Measurement> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Measurement stopped', 'AbortError'));
      const from = this.now();
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(this.measurementBetween(from, this.now()));
      }, durationS * 1000);
      const onAbort = () => { clearTimeout(timer); reject(new DOMException('Measurement stopped', 'AbortError')); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  abstract disconnect(): Promise<void>;
}
