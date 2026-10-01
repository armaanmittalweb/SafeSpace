import { describe, expect, it } from 'vitest';
import { INPUTS, registerCamera, cameraPlaceholder, inputById } from '../../src/inputs/registry';
import { liveStore } from '../../src/inputs/live-store';
import { FakeConnection } from '../../src/inputs/fake';
import { ACTIVITIES } from '../../src/activities';

describe('registry', () => {
  it('lists Bluetooth, camera and the three imports in order', () => {
    expect(INPUTS.map((x) => `${x.kind}:${x.id}`)).toEqual(['live:ble-hr', 'live:camera', 'file:import-apple', 'file:import-fitbit', 'file:import-e4']);
    expect(inputById('polar-h10')?.id).toBe('polar-h10');
  });
  it('holds a camera placeholder until camera.ts registers', async () => {
    expect(await cameraPlaceholder.available()).toMatchObject({ ok: false });
    const cam = { ...cameraPlaceholder, label: 'Phone camera (test)', available: async () => ({ ok: true as const }) };
    registerCamera(cam);
    expect(INPUTS[1]).toBe(cam);
    registerCamera(cameraPlaceholder);
  });
  it('lists the eight activities with contract fields', () => {
    expect(ACTIVITIES.map((a) => a.id).sort()).toEqual(['beat-the-clock', 'follow-dot', 'paced-breathing', 'steady-hand', 'stroop', 'tap-rhythm', 'target-taps', 'typing']);
    for (const a of ACTIVITIES) {
      expect(['baseline', 'check-in', 'challenge', 'recovery']).toContain(a.job);
      expect(a.durationS).toBeGreaterThan(0);
      expect(typeof a.Component).toBe('function');
      expect(a.blurb).toBeTruthy();
    }
  });
});

describe('live store', () => {
  it('clears itself when the connection goes away', async () => {
    const c = new FakeConnection({ history: 0 });
    const seen: unknown[] = [];
    const off = liveStore.subscribe((x) => seen.push(x));
    liveStore.set(c);
    expect(liveStore.get()).toBe(c);
    await liveStore.disconnect();
    expect(liveStore.get()).toBeNull();
    expect(seen).toEqual([c, null]);
    off();
  });
});
