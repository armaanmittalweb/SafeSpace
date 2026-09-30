// The app's Vault facade over the vault agent's web/src/vault: account flows from account.ts, the
// offline-first record store from sync.ts, the rest from the API client. Syncs after every write,
// when the browser comes back online, and every minute while the tab is visible.
import type { NarrationFacts, RecordKind } from '../../contract/records';
import type { SyncStatus, Vault, VaultError as FacadeError, VaultRecord } from '../../contract/vault';
import {
  changePassword, createVaultStore, deleteAccount, recoverAccount, regenerateRecoveryKey, resume, signIn, signOut, signUp, unlock,
  vault as api, VaultError, WrongRecoveryKey, type Account, type VaultStore,
} from '../../vault';
import type { MeWithKey } from '../../vault/types';

function plain(e: unknown): Error {
  if (e instanceof VaultError) {
    const msg = e.code === 'offline' ? 'You are offline. This needs a connection.'
      : e.code === 'rate_limited' ? 'Too many tries. Wait a minute and try again.'
      : e.code === 'unauthenticated' && e.status === 401 ? 'That email and password do not match.'
      : e.code === 'forbidden' ? 'That password is not right.'
      : e.code === 'conflict' ? 'An account with this email already exists.'
      : e.message || 'Something went wrong. Try again.';
    return Object.assign(new Error(msg), { code: e.code, status: e.status }) as FacadeError;
  }
  if (e instanceof WrongRecoveryKey) return Object.assign(new Error(e.message), { code: 'unauthenticated', status: 401 }) as FacadeError;
  return e instanceof Error ? e : new Error(String(e));
}
const wrap = async <T>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { throw plain(e); } };

export function createRealVault(): Vault {
  let store: VaultStore | null = null;
  let unsubStore: (() => void) | null = null;
  let locked: MeWithKey | null = null;
  const changeCbs = new Set<() => void>();
  const statusCbs = new Set<(s: SyncStatus) => void>();
  let status: SyncStatus = { online: typeof navigator === 'undefined' || navigator.onLine !== false, pending: 0, syncing: false, lastSyncedAt: null, error: null };
  const setStatus = (p: Partial<SyncStatus>) => { status = { ...status, ...p }; for (const cb of statusCbs) cb(status); };

  const use = (a: Account) => {
    unsubStore?.();
    store = createVaultStore({ api, dataKey: a.dataKey });
    unsubStore = store.subscribe(() => {
      for (const cb of changeCbs) cb();
      void store?.pending().then((pending) => setStatus({ pending }));
    });
    locked = null;
    void doSync();
    return a.me;
  };
  const drop = () => { unsubStore?.(); unsubStore = null; store = null; setStatus({ pending: 0, lastSyncedAt: null, error: null }); };

  let running: Promise<void> | null = null;
  const doSync = (): Promise<void> => {
    if (!store) return Promise.resolve();
    if (running) return running;
    const s = store;
    setStatus({ syncing: true });
    running = (async () => {
      try {
        const r = await s.sync();
        setStatus({ online: true, syncing: false, lastSyncedAt: Date.now(), error: r.rejected.length ? `${r.rejected.length} record${r.rejected.length > 1 ? 's were' : ' was'} refused by the server (too large).` : null, pending: await s.pending() });
      } catch (e) {
        const code = e instanceof VaultError ? e.code : null;
        setStatus({ syncing: false, online: code !== 'offline', error: code === 'offline' ? null : code === 'unauthenticated' ? 'Your session ended. Sign in again to sync.' : 'The server did not answer.', pending: await s.pending().catch(() => status.pending) });
      } finally {
        running = null;
      }
    })();
    return running;
  };
  if (typeof window !== 'undefined') {
    addEventListener('online', () => { setStatus({ online: true }); void doSync(); });
    addEventListener('offline', () => setStatus({ online: false }));
    setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) void doSync(); }, 60_000);
  }
  const need = () => { if (!store) throw Object.assign(new Error('Signed out'), { code: 'unauthenticated', status: 401 }); return store; };

  return {
    async restore() {
      const r = await resume().catch(() => null);
      if (!r) return null;
      if (r.dataKey === null) { locked = r.me as MeWithKey; return { me: { user: r.me.user }, locked: true }; }
      return { me: use(r as Account), locked: false };
    },
    unlock: (password) => wrap(async () => {
      if (!locked) throw new Error('Sign in again.');
      return use(await unlock(locked, password));
    }),
    signUp: (email, password) => wrap(async () => {
      const r = await signUp(email, password);
      if (!r) throw new Error('The account could not be created.');
      return { me: use(r.account), recoveryKey: r.recoveryKey };
    }),
    signIn: (email, password) => wrap(async () => use(await signIn(email, password))),
    async signOut() { drop(); await signOut(); for (const cb of changeCbs) cb(); },
    recover: (email, key, pw) => wrap(async () => use(await recoverAccount(email, key, pw))),
    changePassword: (cur, next) => wrap(() => changePassword(cur, next)),
    regenerateRecoveryKey: (pw) => wrap(() => regenerateRecoveryKey(pw)),
    sessions: () => wrap(() => api.sessions()),
    revokeSession: (id) => wrap(() => api.revokeSession(id)),
    async put<T>(kind: RecordKind, id: string, value: T) {
      await need().save(kind, value, id);
      void doSync();
    },
    async remove(id) {
      await need().remove(id);
      void doSync();
    },
    async list<T>(kind: RecordKind): Promise<VaultRecord<T>[]> {
      if (!store) return [];
      return (await store.list<T>(kind)).map((r) => ({ id: r.id, kind: r.kind, value: r.data, updatedAt: r.updatedAt, pending: r.pending }));
    },
    onChange(cb) { changeCbs.add(cb); return () => { changeCbs.delete(cb); }; },
    sync: doSync,
    status: () => status,
    onStatus(cb) { statusCbs.add(cb); return () => { statusCbs.delete(cb); }; },
    exportSealed: () => wrap(async () => new Blob([JSON.stringify(await api.exportAll(), null, 2)], { type: 'application/json' })),
    deleteAccount: (pw) => wrap(async () => { await deleteAccount(pw); drop(); for (const cb of changeCbs) cb(); }),
    async narrate(facts: NarrationFacts) {
      try { return await api.narrate(facts); } catch { return null; }
    },
  };
}
