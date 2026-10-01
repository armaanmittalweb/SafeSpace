// Bluetooth heart-rate straps and watches over Web Bluetooth, using the standard GATT
// Heart Rate service (0x180D) that every strap speaks: Polar, Garmin HRM, Wahoo TICKR,
// Coospo, and watches that broadcast heart rate. Battery comes from 0x180F when present.
//
// Heart Rate Measurement (0x2A37) layout, Bluetooth SIG "Heart Rate Service 1.0":
//   byte 0 flags  bit0 HR value format (0 = uint8, 1 = uint16)
//                 bit1 sensor contact detected, bit2 sensor contact supported
//                 bit3 energy expended present (uint16, kJ)
//                 bit4 RR intervals present (uint16 each, units of 1/1024 s)
//   then HR, then energy expended if flagged, then zero or more RR intervals.
import type { Availability, LiveConnection, LiveInput } from '../contract';
import { beatFeatures, beatQuality } from '../signal/hrv';
import { bluetooth, type BtCharacteristic, type BtDevice, type BtServer } from './bluetooth-types';
import { BaseConnection } from './live-base';
import { PMD_SERVICE, PolarExtras } from './polar-h10';

export const HR_SERVICE = 0x180d;
export const HR_MEASUREMENT = 0x2a37;
export const BATTERY_SERVICE = 0x180f;
export const BATTERY_LEVEL = 0x2a19;

export interface HrPacket {
  hr: number;
  /** true/false when the device reports contact, null when it does not support it. */
  contact: boolean | null;
  /** kJ since the last reset, when sent. */
  energy: number | null;
  /** RR intervals in ms (converted from 1/1024 s), possibly empty. */
  rr: number[];
  /** Whether the RR flag was set (a device may set it and send zero intervals). */
  rrFlag: boolean;
}

export function parseHeartRate(v: DataView): HrPacket {
  if (v.byteLength < 2) throw new RangeError('Heart-rate packet too short');
  const flags = v.getUint8(0);
  let o = 1;
  let hr: number;
  if (flags & 0x01) {
    if (v.byteLength < 3) throw new RangeError('Heart-rate packet too short');
    hr = v.getUint16(o, true); o += 2;
  } else {
    hr = v.getUint8(o); o += 1;
  }
  const contact = flags & 0x04 ? !!(flags & 0x02) : null;
  let energy: number | null = null;
  if (flags & 0x08) {
    if (o + 2 <= v.byteLength) energy = v.getUint16(o, true);
    o += 2;
  }
  const rr: number[] = [];
  const rrFlag = !!(flags & 0x10);
  if (rrFlag) {
    for (; o + 1 < v.byteLength; o += 2) rr.push((v.getUint16(o, true) * 1000) / 1024);
  }
  return { hr, contact, energy, rr, rrFlag };
}

// ---------- availability and errors ----------

export const NO_BLUETOOTH_REASON =
  "Safari on iPhone and Firefox don't support Bluetooth in the browser. Use Chrome or Edge on Android, Windows or Mac, or use the camera.";

export async function bluetoothAvailable(): Promise<Availability> {
  const bt = bluetooth();
  if (!bt) return { ok: false, reason: NO_BLUETOOTH_REASON };
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
    return { ok: false, reason: 'Bluetooth only works on a secure (https) page.' };
  }
  try {
    if (bt.getAvailability && !(await bt.getAvailability())) {
      return { ok: false, reason: 'Bluetooth is turned off or this computer has no Bluetooth adapter. Turn it on in your system settings and try again.' };
    }
  } catch { /* some builds throw when the adapter state is unknown: let connect() decide */ }
  return { ok: true };
}

/**
 * Maps a Web Bluetooth failure to the contract's DOMException names (the app picks the
 * designed state from `name`) with a sentence the UI can show as is.
 */
export function bluetoothError(e: unknown): DOMException {
  const name = (e as { name?: string })?.name ?? '';
  const msg = String((e as { message?: string })?.message ?? '');
  if (name === 'NotFoundError' && /cancel/i.test(msg)) return new DOMException('No device was chosen.', 'NotFoundError');
  if (name === 'NotFoundError') return new DOMException('No heart-rate device was found. Wake the strap by wetting the electrodes and putting it on, or turn on heart-rate broadcast on your watch.', 'NotFoundError');
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return new DOMException('Bluetooth permission was blocked. Allow Bluetooth for this site in the browser’s site settings, then try again.', 'NotAllowedError');
  }
  if (name === 'NotSupportedError') return new DOMException('This device does not offer the standard heart-rate service.', 'NotSupportedError');
  if (/adapter|bluetooth.*(off|unavailable)|globally disabled/i.test(msg)) {
    return new DOMException('Bluetooth is turned off. Turn it on and try again.', 'NotSupportedError');
  }
  if (name === 'NetworkError' || /GATT|connect/i.test(msg)) {
    return new DOMException('The device stopped responding while connecting. Move closer, make sure no other app is connected to it, and try again.', 'NetworkError');
  }
  if (name === 'AbortError') return new DOMException('Connecting was cancelled.', 'AbortError');
  return new DOMException(msg || 'Could not connect to the device.', 'NetworkError');
}

// ---------- the connection ----------

/** Backoff between reconnection attempts, in ms. After the last one the connection gives up. */
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];

export class BleHrConnection extends BaseConnection {
  readonly device: string;
  source: 'ble-hr' | 'polar-h10' = 'ble-hr';
  /** Polar Measurement Data (ECG, acceleration) when the strap is a Polar H10. */
  extras: PolarExtras | null = null;
  private hrChar: BtCharacteristic | null = null;
  private closedByUser = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private lastPacketAt = 0;

  constructor(private dev: BtDevice, private opts: { wantPolar?: boolean } = {}) {
    super();
    this.device = dev.name?.trim() || 'Heart-rate device';
    dev.addEventListener('gattserverdisconnected', this.onDropped);
  }

  private onPacket = (ev: Event) => {
    const v = (ev.target as BtCharacteristic).value;
    if (!v) return;
    let p: HrPacket;
    try { p = parseHeartRate(v); } catch { return; }
    const now = this.now();
    this.lastPacketAt = now;
    if (p.contact !== this.st.contact || (p.rr.length > 0 && !this.st.hasRR) || this.st.hasRR === null) {
      this.setStatus({ contact: p.contact, hasRR: this.st.hasRR || p.rr.length > 0 });
    }
    if (p.contact === false) {
      this.emitQuality('poor', 'The strap isn’t reading skin contact. Wet the electrodes and tighten the strap.');
      return;
    }
    if (p.hr === 0) return;
    if (p.rr.length) {
      // RRs in one packet end at or before now; spread them back in time from now.
      let t = now - p.rr.slice(1).reduce((a, b) => a + b, 0);
      for (let i = 0; i < p.rr.length; i++) {
        this.emitBeat({ t: Math.round(t), rr: p.rr[i], hr: p.hr });
        if (i + 1 < p.rr.length) t += p.rr[i + 1];
      }
    } else {
      this.emitBeat({ t: now, rr: null, hr: p.hr });
    }
  };

  private assessQuality = () => {
    if (this.st.state !== 'connected') return;
    if (this.now() - this.lastPacketAt > 4000) {
      this.emitQuality('poor', 'No readings for a few seconds. Check the strap is on and close by.');
      return;
    }
    if (this.st.contact === false) return;
    const recent = this.recent(20);
    const rr = recent.filter((b) => b.rr != null).map((b) => b.rr as number);
    if (rr.length === 0) {
      this.emitQuality('fair', 'This device sends heart rate only, not beat-to-beat intervals, so HRV is not measured.');
      return;
    }
    const q = beatQuality(beatFeatures(rr, 20));
    this.emitQuality(q.quality, q.why);
  };

  private onDropped = () => {
    if (this.closedByUser) return;
    this.hrChar = null;
    this.reconnect(0);
  };

  private reconnect(attempt: number) {
    if (this.closedByUser) return;
    if (attempt >= RECONNECT_DELAYS.length) {
      this.setStatus({ state: 'disconnected', attempt, message: `${this.device} went out of range. Bring it closer and connect again.` });
      this.emitGone();
      return;
    }
    this.setStatus({ state: 'reconnecting', attempt: attempt + 1, message: `Lost ${this.device}. Reconnecting…` });
    this.retryTimer = setTimeout(async () => {
      try {
        await this.start();
      } catch {
        this.reconnect(attempt + 1);
      }
    }, RECONNECT_DELAYS[attempt]);
  }

  /** Connects GATT and subscribes; used for the first connection and for reconnects. */
  async start(): Promise<void> {
    const gatt = this.dev.gatt;
    if (!gatt) throw new DOMException('This device has no GATT server.', 'NotSupportedError');
    const server: BtServer = await gatt.connect();
    const svc = await server.getPrimaryService(HR_SERVICE);
    const ch = await svc.getCharacteristic(HR_MEASUREMENT);
    ch.addEventListener('characteristicvaluechanged', this.onPacket);
    await ch.startNotifications();
    this.hrChar = ch;
    this.lastPacketAt = this.now();
    this.setStatus({ state: 'connected', attempt: 0, message: null });
    void this.readBattery(server);
    if (this.opts.wantPolar !== false && /polar h10/i.test(this.device)) void this.startPolar(server);
    if (!this.qualityTimer) this.qualityTimer = setInterval(this.assessQuality, 2000);
  }

  private async readBattery(server: BtServer) {
    try {
      const svc = await server.getPrimaryService(BATTERY_SERVICE);
      const ch = await svc.getCharacteristic(BATTERY_LEVEL);
      const v = await ch.readValue();
      this.setStatus({ battery: v.getUint8(0) });
      ch.addEventListener('characteristicvaluechanged', (ev) => {
        const x = (ev.target as BtCharacteristic).value;
        if (x) this.setStatus({ battery: x.getUint8(0) });
      });
      await ch.startNotifications().catch(() => undefined);
    } catch { /* no battery service: leave null */ }
  }

  private async startPolar(server: BtServer) {
    try {
      const svc = await server.getPrimaryService(PMD_SERVICE);
      const extras = new PolarExtras(svc);
      await extras.startAcc();
      this.extras?.stopAll().catch(() => undefined);
      this.extras = extras;
      this.source = 'polar-h10';
    } catch {
      this.extras = null; // PMD not offered or refused: plain heart rate still works
    }
  }

  protected override motionBetween(from: number, to: number) {
    return this.extras?.motionBetween(from, to) ?? null;
  }

  async disconnect(): Promise<void> {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    this.dev.removeEventListener('gattserverdisconnected', this.onDropped);
    try { await this.extras?.stopAll(); } catch { /* already gone */ }
    try {
      this.hrChar?.removeEventListener('characteristicvaluechanged', this.onPacket);
      await this.hrChar?.stopNotifications();
    } catch { /* already gone */ }
    this.dev.gatt?.disconnect();
    this.setStatus({ state: 'disconnected', message: null });
  }
}

export async function connectBle(filters: { namePrefix?: string } = {}): Promise<BleHrConnection> {
  const bt = bluetooth();
  if (!bt) throw new DOMException(NO_BLUETOOTH_REASON, 'NotSupportedError');
  let dev: BtDevice;
  try {
    dev = await bt.requestDevice({
      filters: [filters.namePrefix ? { namePrefix: filters.namePrefix, services: [HR_SERVICE] } : { services: [HR_SERVICE] }],
      optionalServices: [BATTERY_SERVICE, PMD_SERVICE.toLowerCase()],
    });
  } catch (e) {
    throw bluetoothError(e);
  }
  const conn = new BleHrConnection(dev);
  try {
    await conn.start();
  } catch (e) {
    await conn.disconnect().catch(() => undefined);
    throw bluetoothError(e);
  }
  return conn;
}

export const bleHr: LiveInput = {
  kind: 'live',
  id: 'ble-hr',
  label: 'Heart-rate strap or watch',
  gives: ['hr', 'hrv'],
  available: bluetoothAvailable,
  connect: (): Promise<LiveConnection> => connectBle(),
};

/** The same link filtered to Polar H10 straps, which adds chest motion (and ECG on request). */
export const polarH10: LiveInput = {
  kind: 'live',
  id: 'polar-h10',
  label: 'Polar H10 chest strap',
  gives: ['hr', 'hrv'],
  available: bluetoothAvailable,
  connect: (): Promise<LiveConnection> => connectBle({ namePrefix: 'Polar H10' }),
};
