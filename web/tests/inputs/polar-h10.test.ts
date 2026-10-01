import { describe, expect, it } from 'vitest';
import {
  accStd, parseControlResponse, parsePmdFrame, PMD_TYPE, START_ACC, START_ECG, stopCommand,
} from '../../src/inputs/polar-h10';

const dv = (bytes: number[] | Uint8Array) => new DataView(new Uint8Array(bytes).buffer);
function header(type: number, frameType: number, ns: bigint): number[] {
  const b = new Uint8Array(10);
  const v = new DataView(b.buffer);
  v.setUint8(0, type);
  v.setBigUint64(1, ns, true);
  v.setUint8(9, frameType);
  return [...b];
}
const i24 = (x: number) => { const u = x < 0 ? x + 0x1000000 : x; return [u & 0xff, (u >> 8) & 0xff, (u >> 16) & 0xff]; };
const i16 = (x: number) => { const u = x < 0 ? x + 0x10000 : x; return [u & 0xff, (u >> 8) & 0xff]; };

describe('PMD commands', () => {
  it('builds the documented start and stop commands', () => {
    expect([...START_ECG]).toEqual([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00]); // 130 Hz, 14 bit
    expect(START_ACC[1]).toBe(PMD_TYPE.ACC);
    expect(new DataView(START_ACC.buffer).getUint16(4, true)).toBe(200);
    expect([...stopCommand(PMD_TYPE.ECG)]).toEqual([0x03, 0x00]);
  });

  it('parses control point responses', () => {
    expect(parseControlResponse(dv([0xf0, 0x02, 0x00, 0x00, 0x00]))).toEqual({ op: 2, type: 0, error: 0, ok: true });
    expect(parseControlResponse(dv([0xf0, 0x02, 0x02, 0x06]))?.ok).toBe(false); // error 6: already in state
    expect(parseControlResponse(dv([0x0f, 0x00, 0x00, 0x00]))).toBeNull();
  });
});

describe('PMD frames', () => {
  it('parses ECG type-0 frames: signed 24-bit microvolts', () => {
    const ns = 599_000_000_000_000_000n; // ~19 years after 2000-01-01
    const bytes = [...header(PMD_TYPE.ECG, 0x00, ns), ...i24(-120), ...i24(1450), ...i24(-8388608), ...i24(8388607)];
    const f = parsePmdFrame(dv(bytes));
    expect(f.type).toBe('ecg');
    if (f.type !== 'ecg') return;
    expect([...f.samples]).toEqual([-120, 1450, -8388608, 8388607]);
    expect(f.timestampNs).toBe(ns);
    expect(new Date(f.epochMs).getUTCFullYear()).toBe(2018);
  });

  it('parses 16-bit ACC frames as x,y,z milli-g', () => {
    const bytes = [...header(PMD_TYPE.ACC, 0x01, 1n), ...i16(12), ...i16(-3), ...i16(1001), ...i16(15), ...i16(-1), ...i16(998)];
    const f = parsePmdFrame(dv(bytes));
    expect(f.type).toBe('acc');
    if (f.type === 'acc') expect([...f.samples]).toEqual([12, -3, 1001, 15, -1, 998]);
  });

  it('parses 8-bit ACC frames', () => {
    const f = parsePmdFrame(dv([...header(PMD_TYPE.ACC, 0x00, 1n), 1, 0xff, 100]));
    if (f.type === 'acc') expect([...f.samples]).toEqual([1, -1, 100]);
    else throw new Error('expected acc');
  });

  it('leaves unknown measurement types alone', () => {
    expect(parsePmdFrame(dv([...header(0x01, 0x00, 1n), 1, 2, 3]))).toEqual({ type: 'other', measurementType: 1 });
    expect(parsePmdFrame(dv([0x00, 1, 2]))).toMatchObject({ type: 'other' });
  });
});

describe('acc_std', () => {
  it('is zero for a still strap and grows with movement', () => {
    const still: number[] = [];
    for (let i = 0; i < 200; i++) still.push(0, 0, 1000);
    expect(accStd(still)).toBeCloseTo(0, 9);
    const moving: number[] = [];
    for (let i = 0; i < 200; i++) moving.push(0, 0, 1000 + (i % 2 ? 100 : -100));
    expect(accStd(moving)).toBeCloseTo(0.1, 6);
    expect(accStd([1, 2, 3])).toBeNull();
  });
});
