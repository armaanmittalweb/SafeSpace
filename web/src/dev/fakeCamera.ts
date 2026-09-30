// Dev and screenshot builds only (`?fake=1`): a camera that plays a synthetic fingertip pulse through the
// real pipeline, so the check-in can be run and photographed without a phone. `?fake=fair` adds noise,
// `?fake=poor` adds movement, `&bpm=` sets the rate. Never included in a production bundle's path:
// src/app/inputs.ts only imports it when import.meta.env.VITE_FAKE or DEV is set.
import type { LiveInput } from '../contract/inputs';
import { pulseConnection } from '../pulse/live';
import { synth } from '../pulse/synth';

export function fakeCamera(mode: string, bpm: number): LiveInput {
  return {
    id: 'camera',
    kind: 'live',
    label: 'Phone camera',
    gives: ['hr', 'hrv'],
    async available() { return { ok: true }; },
    async connect() {
      if (mode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
      const noise = mode === 'fair' ? 0.3 : 0.05;
      const s = synth({ bpm, seconds: 240, fps: 30, noise, wander: 0.6, seed: 11, motion: mode === 'poor' ? { at: 2, dur: 200 } : undefined });
      return pulseConnection({
        device: 'Rear camera with flash',
        torch: true,
        start(onFrame, onMotion) {
          const t0 = Date.now();
          let i = 0;
          // the first second shows "cover the lens" as a real start would
          const timer = setInterval(() => {
            const el = Date.now() - t0;
            while (i < s.frames.length && s.frames[i].t - s.t0 <= el) {
              const f = s.frames[i];
              const t = t0 + (f.t - s.t0);
              const covered = el > 1200;
              onFrame(covered ? { t, r: f.r, g: f.g, b: f.b } : { t, r: 96, g: 90, b: 84 });
              onMotion({ t, a: s.motion[i].a });
              i++;
            }
          }, 33);
          return () => clearInterval(timer);
        },
      });
    },
  };
}
