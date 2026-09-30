// The one place that wires in modules owned by the other rebuild agents. While a module is not in this
// branch, its line points at a stub in src/stubs/ that follows the contract; swap the path when the real
// module lands (nothing else imports the stubs).
import type { AnyInput } from '../contract/inputs';
import { fakeCamera } from '../dev/fakeCamera';
import { INPUTS as REGISTRY } from '../stubs/registry'; //                         → '../inputs/registry'
export { ACTIVITIES, StressSessionView, SESSION_MINUTES } from '../stubs/activities'; // → '../activities' and '../session'

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
