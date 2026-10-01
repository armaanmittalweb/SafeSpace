// The one place that wires in modules owned by the other rebuild agents (inputs, activities, session).
import type { AnyInput } from '../contract/inputs';
import { fakeCamera } from '../dev/fakeCamera';
import { INPUTS as REGISTRY } from '../inputs/registry';
export { ACTIVITIES } from '../activities';
export { StressSessionView, SESSION_MINUTES } from '../session';

/** `?fake=1|fair|poor|denied` swaps the camera for a synthetic pulse (dev server and shots builds only). */
export const FAKE: string | null = (() => {
  if (!(import.meta.env.DEV || import.meta.env.VITE_FAKE)) return null;
  try {
    const q = new URLSearchParams(location.search).get('fake');
    if (q) sessionStorage.setItem('ss-fake', q);
    return q ?? sessionStorage.getItem('ss-fake');
  } catch { return null; }
})();

export const INPUTS: AnyInput[] = FAKE
  ? REGISTRY.map((p) => (p.id === 'camera' ? fakeCamera(FAKE, Number(new URLSearchParams(location.search).get('bpm')) || 78) : p))
  : REGISTRY;
