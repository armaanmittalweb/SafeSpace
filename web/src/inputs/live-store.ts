// The one live device connection the app is using right now (a strap stays connected while
// the person moves between Devices, Check-in and Activities). The Devices panel sets it;
// anything else reads it with useLive().
import { useEffect, useState } from 'preact/hooks';
import type { LiveConnection } from '../contract';

let current: LiveConnection | null = null;
const subs = new Set<(c: LiveConnection | null) => void>();

export const liveStore = {
  get: () => current,
  set(c: LiveConnection | null) {
    if (c === current) return;
    current = c;
    c?.onDisconnect?.(() => { if (current === c) liveStore.set(null); });
    for (const s of subs) s(current);
  },
  subscribe(cb: (c: LiveConnection | null) => void): () => void {
    subs.add(cb);
    return () => subs.delete(cb);
  },
  async disconnect() {
    const c = current;
    liveStore.set(null);
    await c?.disconnect();
  },
};

export function useLive(): LiveConnection | null {
  const [c, setC] = useState(current);
  useEffect(() => liveStore.subscribe(setC), []);
  return c;
}
