import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BleHrConnection, bluetoothAvailable, bluetoothError, NO_BLUETOOTH_REASON, parseHeartRate, RECONNECT_DELAYS,
} from '../../src/inputs/ble-hr';
import type { BtDevice } from '../../src/inputs/bluetooth-types';

const dv = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

// Byte fixtures laid out as each device family sends them (flags and field order per the
// Bluetooth SIG Heart Rate Service spec; flag values as these straps set them).
const FIX = {
  // Polar H10 worn: flags 0x16 (uint8 HR, contact supported + detected, RR present), 60 bpm,
  // RR 0x03EC = 1004/1024 s = 980.47 ms.
  polarH10: [0x16, 0x3c, 0xec, 0x03],
  // Polar H10 packet with two RRs after a slower BLE connection interval: 72 bpm, 853 and 846 /1024 s.
  polarH10TwoRR: [0x16, 0x48, 0x55, 0x03, 0x4e, 0x03],
  // Polar H10 lying on a table: flags 0x14 (contact supported, not detected), HR 0.
  polarH10NoContact: [0x14, 0x00],
  // Garmin HRM-style: flags 0x10 (contact not supported, RR present), 75 bpm, RR 819/1024 s.
  garminHrm: [0x10, 0x4b, 0x33, 0x03],
  // 16-bit HR with energy expended and RR: flags 0x19, 150 bpm, 1234 kJ, RR 410/1024 s.
  hr16EnergyRR: [0x19, 0x96, 0x00, 0xd2, 0x04, 0x9a, 0x01],
  // A watch broadcasting heart rate only: flags 0x00, 88 bpm, nothing else.
  watchHrOnly: [0x00, 0x58],
};

describe('parseHeartRate', () => {
  it('reads a Polar H10 packet with one RR', () => {
    const p = parseHeartRate(dv(FIX.polarH10));
    expect(p).toMatchObject({ hr: 60, contact: true, energy: null, rrFlag: true });
    expect(p.rr).toHaveLength(1);
    expect(p.rr[0]).toBeCloseTo(980.469, 2);
  });

  it('reads two RR intervals in one packet', () => {
    const p = parseHeartRate(dv(FIX.polarH10TwoRR));
    expect(p.hr).toBe(72);
    expect(p.rr.map((x) => Math.round(x * 10) / 10)).toEqual([833, 826.2]);
  });

  it('reports no skin contact', () => {
    expect(parseHeartRate(dv(FIX.polarH10NoContact))).toMatchObject({ hr: 0, contact: false, rr: [] });
  });

  it('reads a Garmin HRM-style packet (contact not supported)', () => {
    const p = parseHeartRate(dv(FIX.garminHrm));
    expect(p.contact).toBeNull();
    expect(p.hr).toBe(75);
    expect(p.rr[0]).toBeCloseTo(799.8, 1);
  });

  it('reads 16-bit HR and energy expended before the RRs', () => {
    const p = parseHeartRate(dv(FIX.hr16EnergyRR));
    expect(p).toMatchObject({ hr: 150, energy: 1234 });
    expect(p.rr[0]).toBeCloseTo(400.39, 2);
  });

  it('reads HR-only broadcasts', () => {
    expect(parseHeartRate(dv(FIX.watchHrOnly))).toMatchObject({ hr: 88, contact: null, rr: [], rrFlag: false });
  });

  it('ignores a trailing odd byte and rejects a truncated packet', () => {
    expect(parseHeartRate(dv([0x10, 0x40, 0x00, 0x04, 0x07])).rr).toEqual([1000]);
    expect(() => parseHeartRate(dv([0x01]))).toThrow();
    expect(() => parseHeartRate(dv([0x01, 0x40]))).toThrow();
  });
});

describe('availability and errors', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('explains missing Web Bluetooth', async () => {
    vi.stubGlobal('navigator', {});
    expect(await bluetoothAvailable()).toEqual({ ok: false, reason: NO_BLUETOOTH_REASON });
    expect(NO_BLUETOOTH_REASON).toMatch(/Safari on iPhone and Firefox/);
  });

  it('explains a switched-off adapter', async () => {
    vi.stubGlobal('navigator', { bluetooth: { requestDevice: vi.fn(), getAvailability: async () => false } });
    vi.stubGlobal('isSecureContext', true);
    const r = await bluetoothAvailable();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/turned off/);
  });

  it('maps browser errors to the contract names', () => {
    expect(bluetoothError(new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError')).name).toBe('NotFoundError');
    expect(bluetoothError(new DOMException('Permission denied', 'SecurityError')).name).toBe('NotAllowedError');
    expect(bluetoothError(new DOMException('Bluetooth adapter not available.', 'NotFoundError')).message).toMatch(/No heart-rate device|turned off/);
    expect(bluetoothError(new DOMException('GATT Server is disconnected.', 'NetworkError')).name).toBe('NetworkError');
  });
});

// ---------- a fake GATT device ----------

class FakeChar extends EventTarget {
  value: DataView | null = null;
  constructor(public uuid: string) { super(); }
  async startNotifications() { return this; }
  async stopNotifications() { return this; }
  async readValue() { return dv([87]); }
  send(bytes: number[]) { this.value = dv(bytes); this.dispatchEvent(new Event('characteristicvaluechanged')); }
}
function fakeDevice(name = 'Polar H10 A1B2C3D4', opts: { failConnects?: number } = {}) {
  const hr = new FakeChar('2a37');
  const battery = new FakeChar('2a19');
  let fails = opts.failConnects ?? 0;
  const dev = new EventTarget() as BtDevice & EventTarget & { connects: number };
  dev.connects = 0;
  const server = {
    connected: true,
    async connect() {
      dev.connects++;
      if (fails-- > 0) throw new DOMException('GATT operation failed', 'NetworkError');
      return server;
    },
    disconnect: vi.fn(),
    async getPrimaryService(uuid: string | number) {
      if (uuid === 0x180d) return { uuid: '180d', getCharacteristic: async () => hr };
      if (uuid === 0x180f) return { uuid: '180f', getCharacteristic: async () => battery };
      throw new DOMException('No service', 'NotFoundError');
    },
  };
  Object.assign(dev, { id: 'x', name, gatt: server });
  return { dev, hr, battery, server };
}

describe('BleHrConnection', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits beats spread back in time and reads the battery', async () => {
    const { dev, hr } = fakeDevice();
    const c = new BleHrConnection(dev, { wantPolar: false });
    await c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.status()).toMatchObject({ state: 'connected', battery: 87 });
    expect(await c.battery()).toBe(87);
    const beats: { t: number; rr: number | null }[] = [];
    c.onBeat((b) => beats.push(b));
    hr.send(FIX.polarH10TwoRR);
    expect(beats).toHaveLength(2);
    expect(beats[1].t).toBe(1_700_000_000_000);
    expect(beats[1].t - beats[0].t).toBe(Math.round(beats[1].rr!));
    expect(c.status().hasRR).toBe(true);
    await c.disconnect();
  });

  it('reports poor quality without skin contact', async () => {
    const { dev, hr } = fakeDevice();
    const c = new BleHrConnection(dev, { wantPolar: false });
    await c.start();
    const q: string[] = [];
    c.onQuality((x) => q.push(x));
    hr.send(FIX.polarH10NoContact);
    expect(q).toEqual(['poor']);
    expect(c.status().contact).toBe(false);
    await c.disconnect();
  });

  it('measures a window from RR intervals', async () => {
    const { dev, hr } = fakeDevice();
    const c = new BleHrConnection(dev, { wantPolar: false });
    await c.start();
    const p = c.measure(60);
    for (let i = 0; i < 75; i++) {
      await vi.advanceTimersByTimeAsync(800);
      hr.send([0x16, 75, ...(i % 2 ? [0x33, 0x03] : [0x47, 0x03])]); // 800 / 819.3 ms alternating
    }
    const m = await p;
    expect(m.source).toBe('ble-hr');
    expect(m.device).toBe('Polar H10 A1B2C3D4');
    expect(m.features.hr_mean).toBeGreaterThan(72);
    expect(m.features.rmssd).toBeGreaterThan(10);
    expect(m.beats).toBeUndefined();
    await c.disconnect();
  });

  it('measures heart rate only when the device sends no RR', async () => {
    const { dev, hr } = fakeDevice('Forerunner 265');
    const c = new BleHrConnection(dev, { wantPolar: false });
    await c.start();
    const p = c.measure(10);
    for (let i = 0; i < 10; i++) { await vi.advanceTimersByTimeAsync(1000); hr.send(FIX.watchHrOnly); }
    const m = await p;
    expect(m.features).toEqual({ hr_mean: 88 });
    await c.disconnect();
  });

  it('stops a measurement on abort', async () => {
    const { dev } = fakeDevice();
    const c = new BleHrConnection(dev, { wantPolar: false });
    await c.start();
    const ac = new AbortController();
    const p = c.measure(60, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await c.disconnect();
  });

  it('reconnects with backoff, then gives up and fires onDisconnect', async () => {
    const { dev } = fakeDevice('Polar H10 1', { failConnects: 0 });
    const c = new BleHrConnection(dev, { wantPolar: false });
    await c.start();
    const states: string[] = [];
    c.onStatus((s) => states.push(`${s.state}:${s.attempt}`));
    const gone = vi.fn();
    c.onDisconnect(gone);
    // From now on every connect fails.
    (dev.gatt as unknown as { connect: () => Promise<never> }).connect = async () => { throw new DOMException('x', 'NetworkError'); };
    dev.dispatchEvent(new Event('gattserverdisconnected'));
    for (const d of RECONNECT_DELAYS) await vi.advanceTimersByTimeAsync(d);
    expect(states).toContain('reconnecting:1');
    expect(states).toContain('reconnecting:5');
    expect(states.at(-1)).toBe('disconnected:5');
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('reconnects when the device comes back', async () => {
    const { dev } = fakeDevice();
    const c = new BleHrConnection(dev, { wantPolar: false });
    await c.start();
    dev.dispatchEvent(new Event('gattserverdisconnected'));
    expect(c.status().state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS[0]);
    expect(c.status()).toMatchObject({ state: 'connected', attempt: 0, message: null });
    await c.disconnect();
    expect(c.status().state).toBe('disconnected');
  });
});
