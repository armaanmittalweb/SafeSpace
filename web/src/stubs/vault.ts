// STUB for the vault (web/src/vault, vault agent) behind the app's Vault facade. Everything stays in this
// browser's localStorage, unencrypted, with a pretend server: it exists so the app can be built, run and
// photographed before the real client lands, and it is what `?fake=1` screenshot builds use. It must not
// ship: src/app/vault/index.ts picks the real adapter as soon as web/src/vault exists.
import type { Me, NarrationFacts, RecordKind, SessionInfo } from '../contract/records';
import type { SyncStatus, Vault, VaultError, VaultRecord } from '../contract/vault';

interface Db {
  users: Record<string, { id: string; email: string; password: string; recoveryKey: string; createdAt: string }>;
  session: { userId: string; locked?: boolean } | null;
  records: Record<string, Record<string, VaultRecord>>;
}
const KEY = 'ss-stub-vault';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function load(): Db {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '');
    if (v && v.users) return v as Db;
  } catch { /* fresh */ }
  return { users: {}, session: null, records: {} };
}
function save(db: Db) {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* private mode: memory only */ }
}
function err(code: VaultError['code'], message: string, status = 400): VaultError {
  return Object.assign(new Error(message), { code, status }) as VaultError;
}
export function newRecoveryKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  const chars = Array.from(b, (x) => CROCKFORD[x & 31]);
  return Array.from({ length: 8 }, (_, i) => chars.slice(i * 4, i * 4 + 4).join('')).join('-');
}
const normKey = (k: string) => k.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createStubVault(opts: { latencyMs?: number; forceOffline?: boolean } = {}): Vault {
  let db = load();
  const latency = opts.latencyMs ?? 250;
  const changeCbs = new Set<() => void>();
  const statusCbs = new Set<(s: SyncStatus) => void>();
  const online = () => !opts.forceOffline && (typeof navigator === 'undefined' || navigator.onLine !== false);
  let status: SyncStatus = { online: online(), pending: 0, syncing: false, lastSyncedAt: null, error: null };

  const me = (): Me => {
    const u = Object.values(db.users).find((x) => x.id === db.session?.userId);
    if (!u) throw err('unauthenticated', 'Signed out', 401);
    return { user: { id: u.id, email: u.email, createdAt: u.createdAt } };
  };
  const mine = () => (db.records[db.session!.userId] ??= {});
  const setStatus = (p: Partial<SyncStatus>) => { status = { ...status, ...p }; for (const cb of statusCbs) cb(status); };
  const countPending = () => (db.session ? Object.values(mine()).filter((r) => r.pending).length : 0);
  const changed = () => { save(db); for (const cb of changeCbs) cb(); };
  const net = async () => {
    await wait(latency);
    if (!online()) throw err('offline', 'You are offline.', 0);
  };

  const sync = async () => {
    if (!db.session || db.session.locked) return;
    if (!online()) { setStatus({ online: false, pending: countPending() }); return; }
    setStatus({ syncing: true, online: true });
    await wait(latency);
    for (const r of Object.values(mine())) r.pending = false;
    changed();
    setStatus({ syncing: false, pending: 0, lastSyncedAt: Date.now(), error: null });
  };
  if (typeof addEventListener === 'function') {
    addEventListener('online', () => { setStatus({ online: online() }); void sync(); });
    addEventListener('offline', () => setStatus({ online: false }));
  }
  const signedIn = (userId: string) => {
    db.session = { userId };
    save(db);
    setStatus({ pending: countPending(), lastSyncedAt: Date.now() });
  };

  return {
    async restore() {
      await wait(latency / 2);
      if (!db.session) return null;
      try { return { me: me(), locked: !!db.session.locked }; } catch { return null; }
    },
    async unlock(password) {
      await net();
      const u = Object.values(db.users).find((x) => x.id === db.session?.userId);
      if (!u || u.password !== password) throw err('unauthenticated', 'That password is not right.', 401);
      db.session = { userId: u.id };
      save(db);
      return me();
    },
    async signUp(email, password) {
      await net();
      const e = email.trim().toLowerCase();
      if (db.users[e]) throw err('conflict', 'An account with this email already exists.', 409);
      const recoveryKey = newRecoveryKey();
      const id = crypto.randomUUID();
      db.users[e] = { id, email: e, password, recoveryKey, createdAt: new Date().toISOString() };
      signedIn(id);
      return { me: me(), recoveryKey };
    },
    async signIn(email, password) {
      await net();
      const u = db.users[email.trim().toLowerCase()];
      if (!u || u.password !== password) throw err('unauthenticated', 'That email and password do not match.', 401);
      signedIn(u.id);
      void sync();
      return me();
    },
    async signOut() {
      db.session = null;
      save(db);
      setStatus({ pending: 0, lastSyncedAt: null });
      for (const cb of changeCbs) cb();
    },
    async recover(email, recoveryKey, newPassword) {
      await net();
      const u = db.users[email.trim().toLowerCase()];
      if (!u || normKey(u.recoveryKey) !== normKey(recoveryKey)) throw err('unauthenticated', 'That recovery key does not match this email.', 401);
      u.password = newPassword;
      signedIn(u.id);
      return me();
    },
    async changePassword(current, next) {
      await net();
      const u = Object.values(db.users).find((x) => x.id === db.session?.userId)!;
      if (u.password !== current) throw err('unauthenticated', 'Your current password is not right.', 401);
      u.password = next;
      save(db);
    },
    async regenerateRecoveryKey(password) {
      await net();
      const u = Object.values(db.users).find((x) => x.id === db.session?.userId)!;
      if (u.password !== password) throw err('unauthenticated', 'That password is not right.', 401);
      u.recoveryKey = newRecoveryKey();
      save(db);
      return u.recoveryKey;
    },
    async sessions(): Promise<SessionInfo[]> {
      await net();
      const now = new Date().toISOString();
      return [
        { id: 'this', current: true, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null, createdAt: now, lastSeenAt: now },
        { id: 'other', current: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', createdAt: new Date(Date.now() - 9 * 864e5).toISOString(), lastSeenAt: new Date(Date.now() - 2 * 864e5).toISOString() },
      ];
    },
    async revokeSession() { await net(); },
    async put<T>(kind: RecordKind, id: string, value: T) {
      if (!db.session) throw err('unauthenticated', 'Signed out', 401);
      mine()[id] = { id, kind, value, updatedAt: Date.now(), pending: true };
      changed();
      setStatus({ pending: countPending() });
      void sync();
    },
    async remove(id) {
      if (!db.session) throw err('unauthenticated', 'Signed out', 401);
      delete mine()[id];
      changed();
      void sync();
    },
    async list<T>(kind: RecordKind) {
      if (!db.session) return [];
      return Object.values(mine()).filter((r) => r.kind === kind).sort((a, b) => b.updatedAt - a.updatedAt) as VaultRecord<T>[];
    },
    onChange(cb) { changeCbs.add(cb); return () => changeCbs.delete(cb); },
    sync,
    status: () => status,
    onStatus(cb) { statusCbs.add(cb); return () => statusCbs.delete(cb); },
    async exportSealed() {
      await net();
      return new Blob([JSON.stringify({ note: 'Stub vault: records are not encrypted in this build.', records: db.session ? Object.values(mine()) : [] }, null, 2)], { type: 'application/json' });
    },
    async deleteAccount(password) {
      await net();
      const u = Object.values(db.users).find((x) => x.id === db.session?.userId);
      if (!u || u.password !== password) throw err('unauthenticated', 'That password is not right.', 401);
      delete db.users[u.email];
      delete db.records[u.id];
      db.session = null;
      save(db);
      for (const cb of changeCbs) cb();
    },
    async narrate(_facts: NarrationFacts) {
      await wait(latency * 2);
      return null;
    },
  };
}

/** Writes a signed-in user with the given records straight into the stub (screenshots and dev only). */
export function seedStub(email: string, records: { kind: RecordKind; id: string; value: unknown; updatedAt: number }[], opts: { pending?: boolean } = {}) {
  const db = load();
  const e = email.toLowerCase();
  const id = db.users[e]?.id ?? 'sample-user';
  db.users[e] = { id, email: e, password: 'correct horse battery', recoveryKey: '7K2M-Q9XD-4HNB-RW3T-8FJC-2VPA-6YEG-KM5S', createdAt: new Date(Date.now() - 40 * 864e5).toISOString() };
  db.session = { userId: id };
  db.records[id] = {};
  for (const r of records) db.records[id][r.id] = { ...r, pending: !!opts.pending };
  save(db);
}
