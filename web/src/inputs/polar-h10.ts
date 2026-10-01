// Polar H10 extras: raw ECG (130 Hz) and chest acceleration over the Polar Measurement
// Data (PMD) service, alongside the standard heart-rate service.
//
// FOLLOWS POLAR'S PUBLISHED DOCS: the UUIDs, the control-point opcodes and setting ids,
// the start-command byte layouts and the data frame layout below come from the Polar BLE
// SDK technical documentation ("Polar Measurement Data specification for 3rd party",
// github.com/polarofficial/polar-ble-sdk, technical_documentation/). In short:
//   control point write:  [op, measurement type, (setting id, count, uint16 LE value)...]
//     op 0x01 get settings, 0x02 start, 0x03 stop
//     type 0x00 ECG, 0x02 ACC;  setting 0x00 sample rate, 0x01 resolution, 0x02 range
//   control point response (indication): [0xF0, op, type, error (0 = ok), ...]
//   data notification: [type, timestamp uint64 LE (ns since 2000-01-01), frame type, samples...]
//     ECG frame type 0x00: int24 LE samples in microvolts
//     ACC frame type 0x00/0x01/0x02: int8/int16/int24 LE x, y, z per sample, in milli-g
// OUR OWN CHOICES (not from Polar): 200 Hz / 8 g for ACC, acc_std as the SD of the vector
// magnitude in g (the same definition as training/features.py uses for the E4 wrist), the
// motion flag threshold, and keeping only the last few minutes of samples in memory.
// Raw ECG is never stored or sent anywhere (contract: "Data that never leaves the device").
import type { BtCharacteristic, BtService } from './bluetooth-types';

export const PMD_SERVICE = 'FB005C80-02E7-F387-1CAD-8ACD2D8DF0C8';
export const PMD_CONTROL = 'FB005C81-02E7-F387-1CAD-8ACD2D8DF0C8';
export const PMD_DATA = 'FB005C82-02E7-F387-1CAD-8ACD2D8DF0C8';

export const PMD_TYPE = { ECG: 0x00, ACC: 0x02 } as const;
export const PMD_OP = { GET_SETTINGS: 0x01, START: 0x02, STOP: 0x03 } as const;

/** Start ECG at 130 Hz, 14-bit resolution (the H10's only ECG setting). */
export const START_ECG = new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]);
/** Start ACC at 200 Hz, 16-bit, range 8 g. */
export const START_ACC = new Uint8Array([0x02, 0x02, 0x00, 0x01, 0xc8, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00]);
export const stopCommand = (type: number) => new Uint8Array([PMD_OP.STOP, type]);

export const ECG_HZ = 130;
export const ACC_HZ = 200;
/** Seconds since 1970 at 2000-01-01T00:00:00Z, the PMD epoch. */
const PMD_EPOCH_MS = Date.UTC(2000, 0, 1);

export interface ControlResponse { op: number; type: number; error: number; ok: boolean }
export function parseControlResponse(v: DataView): ControlResponse | null {
  if (v.byteLength < 4 || v.getUint8(0) !== 0xf0) return null;
  const error = v.getUint8(3);
  return { op: v.getUint8(1), type: v.getUint8(2), error, ok: error === 0 };
}

export type PmdFrame =
  | { type: 'ecg'; timestampNs: bigint; epochMs: number; samples: Int32Array }
  | { type: 'acc'; timestampNs: bigint; epochMs: number; samples: Int32Array /* x,y,z interleaved, milli-g */ }
  | { type: 'other'; measurementType: number };

function int24(v: DataView, o: number): number {
  const x = v.getUint8(o) | (v.getUint8(o + 1) << 8) | (v.getUint8(o + 2) << 16);
  return x & 0x800000 ? x - 0x1000000 : x;
}

/** Parses one PMD data notification. The timestamp is that of the last sample in the frame. */
export function parsePmdFrame(v: DataView): PmdFrame {
  const mtype = v.getUint8(0);
  if (v.byteLength < 10) return { type: 'other', measurementType: mtype };
  const ts = v.getBigUint64(1, true);
  const epochMs = PMD_EPOCH_MS + Number(ts / 1000000n);
  const frameType = v.getUint8(9);
  const body = 10;
  if (mtype === PMD_TYPE.ECG && frameType === 0x00) {
    const n = Math.floor((v.byteLength - body) / 3);
    const s = new Int32Array(n);
    for (let i = 0; i < n; i++) s[i] = int24(v, body + 3 * i);
    return { type: 'ecg', timestampNs: ts, epochMs, samples: s };
  }
  if (mtype === PMD_TYPE.ACC && frameType <= 0x02) {
    const width = frameType + 1; // 1, 2 or 3 bytes per axis
    const n = Math.floor((v.byteLength - body) / (3 * width));
    const s = new Int32Array(n * 3);
    for (let i = 0; i < n * 3; i++) {
      const o = body + i * width;
      s[i] = width === 1 ? v.getInt8(o) : width === 2 ? v.getInt16(o, true) : int24(v, o);
    }
    return { type: 'acc', timestampNs: ts, epochMs, samples: s };
  }
  return { type: 'other', measurementType: mtype };
}

/** Population SD of the acceleration magnitude in g (samples in milli-g, x,y,z interleaved). */
export function accStd(samples: ArrayLike<number>): number | null {
  const n = Math.floor(samples.length / 3);
  if (n < 2) return null;
  let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[3 * i] / 1000, y = samples[3 * i + 1] / 1000, z = samples[3 * i + 2] / 1000;
    const m = Math.sqrt(x * x + y * y + z * z);
    sum += m; sum2 += m * m;
  }
  const mu = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mu * mu));
}

/**
 * Chest motion above this SD of |acc| (g) flags the window as "moving". Our own threshold:
 * the WESAD wrist resting mean + 3 SD (0.027 + 3 x 0.016, models.json typical.rest.acc_std),
 * rounded up. A chest moves less than a wrist, so this errs towards not flagging.
 */
export const MOTION_FLAG_G = 0.08;

const KEEP_MS = 5 * 60 * 1000;

/** Streams ECG and ACC from an H10's PMD service. Created by BleHrConnection. */
export class PolarExtras {
  private control: BtCharacteristic | null = null;
  private data: BtCharacteristic | null = null;
  private pending: ((r: ControlResponse) => void) | null = null;
  private acc: { t: number; s: Int32Array }[] = [];
  private ecgSubs = new Set<(f: { t: number; uV: Int32Array }) => void>();
  private running = new Set<number>();

  constructor(private svc: BtService) {}

  private onControl = (ev: Event) => {
    const v = (ev.target as BtCharacteristic).value;
    const r = v && parseControlResponse(v);
    if (r && this.pending) { const p = this.pending; this.pending = null; p(r); }
  };

  private onData = (ev: Event) => {
    const v = (ev.target as BtCharacteristic).value;
    if (!v) return;
    const f = parsePmdFrame(v);
    // Use the phone's clock for the frame end; the strap's clock is only relative.
    const t = Date.now();
    if (f.type === 'acc') {
      this.acc.push({ t, s: f.samples });
      while (this.acc.length && this.acc[0].t < t - KEEP_MS) this.acc.shift();
    } else if (f.type === 'ecg') {
      for (const cb of this.ecgSubs) cb({ t, uV: f.samples });
    }
  };

  private async ensure() {
    if (this.control && this.data) return;
    // Polar's docs: enable indications on the control point before writing to it.
    this.control = await this.svc.getCharacteristic(PMD_CONTROL.toLowerCase());
    this.control.addEventListener('characteristicvaluechanged', this.onControl);
    await this.control.startNotifications();
    this.data = await this.svc.getCharacteristic(PMD_DATA.toLowerCase());
    this.data.addEventListener('characteristicvaluechanged', this.onData);
    await this.data.startNotifications();
  }

  private async command(bytes: Uint8Array<ArrayBuffer>): Promise<ControlResponse> {
    await this.ensure();
    const c = this.control!;
    const reply = new Promise<ControlResponse>((resolve, reject) => {
      this.pending = resolve;
      setTimeout(() => { if (this.pending === resolve) { this.pending = null; reject(new Error('PMD control point timed out')); } }, 3000);
    });
    await (c.writeValueWithResponse ?? c.writeValue)!.call(c, bytes);
    return reply;
  }

  async startAcc(): Promise<void> {
    const r = await this.command(START_ACC);
    if (!r.ok) throw new Error(`PMD ACC start refused (error ${r.error})`);
    this.running.add(PMD_TYPE.ACC);
  }
  async startEcg(): Promise<void> {
    const r = await this.command(START_ECG);
    if (!r.ok) throw new Error(`PMD ECG start refused (error ${r.error})`);
    this.running.add(PMD_TYPE.ECG);
  }
  async stopEcg(): Promise<void> {
    if (!this.running.delete(PMD_TYPE.ECG)) return;
    await this.command(stopCommand(PMD_TYPE.ECG)).catch(() => undefined);
  }
  async stopAll(): Promise<void> {
    for (const t of [...this.running]) await this.command(stopCommand(t)).catch(() => undefined);
    this.running.clear();
  }

  /** Raw ECG frames (microvolts, 130 Hz) for a live trace. Kept in memory only by the caller. */
  onEcg(cb: (f: { t: number; uV: Int32Array }) => void): () => void {
    this.ecgSubs.add(cb);
    if (!this.running.has(PMD_TYPE.ECG)) void this.startEcg().catch(() => undefined);
    return () => {
      this.ecgSubs.delete(cb);
      if (this.ecgSubs.size === 0) void this.stopEcg();
    };
  }

  motionBetween(from: number, to: number): { accStd: number; flagged: boolean } | null {
    const frames = this.acc.filter((f) => f.t >= from && f.t <= to);
    if (!frames.length) return null;
    const all = new Int32Array(frames.reduce((a, f) => a + f.s.length, 0));
    let o = 0;
    for (const f of frames) { all.set(f.s, o); o += f.s.length; }
    const s = accStd(all);
    return s == null ? null : { accStd: s, flagged: s > MOTION_FLAG_G };
  }
}
