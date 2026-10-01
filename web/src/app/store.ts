// App state: who is signed in, their decrypted records, sync status, the connected device, and the one
// unsaved guest check-in. A tiny observable; screens read it with useApp().
import { useEffect, useState } from 'preact/hooks';
import type { LiveConnection, LiveInput } from '../contract/inputs';
import { DEFAULT_SETTINGS, type Baseline, type CheckIn, type Me, type StressSession, type UserSettings } from '../contract/records';
import type { SyncStatus } from '../contract/vault';
import { SETTINGS_RECORD_ID, vault } from './vault';
import { liveStore } from '../inputs/live-store';
import { INPUTS } from './ports';
import type { ActivityId, ActivityResult } from '../contract/records';

export type Auth =
  | { state: 'loading' }
  | { state: 'out' }
  | { state: 'locked'; me: Me }
  | { state: 'in'; me: Me };

export interface AppState {
  auth: Auth;
  loaded: boolean;
  checkins: CheckIn[];
  sessions: StressSession[];
  baseline: Baseline | null;
  settings: UserSettings;
  sync: SyncStatus;
  device: { input: LiveInput; conn: LiveConnection; hr: number | null; battery: number | null } | null;
  /** the one check-in someone made without an account (kept for this tab only) */
  guest: CheckIn | null;
  /** shown once after sign-up, until saved */
  recoveryKey: string | null;
  toast: { text: string; id: number } | null;
}

const GUEST_KEY = 'ss-guest-checkin';
function readGuest(): CheckIn | null {
  try { return JSON.parse(sessionStorage.getItem(GUEST_KEY) ?? 'null'); } catch { return null; }
}

let state: AppState = {
  auth: { state: 'loading' },
  loaded: false,
  checkins: [],
  sessions: [],
  baseline: null,
  settings: DEFAULT_SETTINGS,
  sync: vault.status(),
  device: null,
  guest: readGuest(),
  recoveryKey: null,
  toast: null,
};
const subs = new Set<() => void>();

export const getState = () => state;
export function setState(p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof p === 'function' ? p(state) : p) };
  for (const cb of subs) cb();
}
export function useApp(): AppState {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    subs.add(cb);
    return () => { subs.delete(cb); };
  }, []);
  return state;
}

let toastTimer = 0;
export function toast(text: string) {
  clearTimeout(toastTimer);
  setState({ toast: { text, id: Date.now() } });
  toastTimer = window.setTimeout(() => setState({ toast: null }), 4200);
}

export function setGuest(c: CheckIn | null) {
  try { if (c) sessionStorage.setItem(GUEST_KEY, JSON.stringify(c)); else sessionStorage.removeItem(GUEST_KEY); } catch { /* private mode */ }
  setState({ guest: c });
}

export async function reload() {
  if (getState().auth.state !== 'in') { setState({ checkins: [], sessions: [], baseline: null, settings: DEFAULT_SETTINGS, loaded: true }); return; }
  const [c, b, s, ss] = await Promise.all([
    vault.list<CheckIn>('checkin'), vault.list<Baseline>('baseline'), vault.list<UserSettings>('settings'), vault.list<StressSession>('session'),
  ]);
  setState({
    checkins: c.map((r) => r.value).sort((a, x) => x.createdAt - a.createdAt),
    baseline: b[0]?.value ?? null,
    settings: { ...DEFAULT_SETTINGS, ...(s[0]?.value ?? {}) },
    sessions: ss.map((r) => r.value),
    loaded: true,
  });
}

export async function boot() {
  vault.onChange(() => void reload());
  vault.onStatus((sync) => setState({ sync }));
  try {
    const r = await vault.restore();
    setState({ auth: r ? (r.locked ? { state: 'locked', me: r.me } : { state: 'in', me: r.me }) : { state: 'out' }, sync: vault.status() });
  } catch {
    setState({ auth: { state: 'out' } });
  }
  await reload();
}

export async function signedIn(me: Me) {
  setState({ auth: { state: 'in', me } });
  await reload();
}

export async function signOut() {
  await liveStore.disconnect().catch(() => {});
  await vault.signOut();
  setState({ auth: { state: 'out' }, device: null, recoveryKey: null });
  await reload();
}

export async function saveSettings(p: Partial<UserSettings>) {
  const next = { ...getState().settings, ...p };
  setState({ settings: next });
  await vault.put('settings', SETTINGS_RECORD_ID, next);
}

// The connected device lives in the inputs agent's liveStore (its Devices panel sets it); the app mirrors
// it here with the live heart rate and battery, so Today and the check-in can show it.
function inputFor(conn: LiveConnection): LiveInput {
  const src = (conn as LiveConnection & { source?: string }).source;
  const id = src === 'polar-h10' ? 'ble-hr' : src ?? 'ble-hr';
  return (INPUTS.find((i) => i.id === id && i.kind === 'live') ?? INPUTS.find((i) => i.kind === 'live' && i.id === 'ble-hr')) as LiveInput;
}
let unsubBeat: (() => void) | null = null;
liveStore.subscribe((conn) => {
  unsubBeat?.(); unsubBeat = null;
  if (!conn) { setState({ device: null }); return; }
  setState({ device: { input: inputFor(conn), conn, hr: null, battery: null } });
  unsubBeat = conn.onBeat((b) => setState((s) => (s.device?.conn === conn ? { device: { ...s.device, hr: b.hr } } : {})));
  void conn.battery?.().then((battery) => setState((s) => (s.device?.conn === conn ? { device: { ...s.device, battery } } : {})));
});

export async function connectDevice(input: LiveInput) {
  const conn = await input.connect();
  const prev = liveStore.get();
  liveStore.set(conn);
  if (prev && prev !== conn) await prev.disconnect().catch(() => {});
  return conn;
}
export async function disconnectDevice() {
  await liveStore.disconnect().catch(() => {});
}

/** Completed runs of an activity the person did calm: standalone runs and the rest phase of stress sessions. */
export function calmRuns(id?: ActivityId): ActivityResult[] {
  const s = getState();
  const standalone = s.checkins.flatMap((c) => c.activities).filter((a) => a.completed);
  const rest = s.sessions.flatMap((x) => x.phases.filter((p) => p.name === 'rest').flatMap((p) => p.activities)).filter((a) => a.completed);
  const all = [...standalone, ...rest];
  return id ? all.filter((a) => a.activity === id) : all;
}
