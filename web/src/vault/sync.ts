/**
 * Offline-first record store. Saves land on this device first (IndexedDB) and are queued; sync()
 * pushes the queue, then pulls every change since the last cursor. Works the same with no network:
 * the app reads and writes locally and calls sync() when it can.
 *
 * Inside each record's ciphertext is an Envelope { updatedAt, data }: updatedAt is this device's
 * clock at the last edit.
 *
 * Conflicts (409, another device wrote first): last writer wins on the envelope's updatedAt.
 *   - The server's copy is newer: keep it and drop the local edit.
 *   - The local edit is newer (or the server copy is gone): write again on top of the server's version.
 *   - An edit against a deletion: the deletion's server updatedAt stands in for its edit time.
 *   - A deletion against a newer edit: the edit wins and the record comes back.
 * Ties keep the server's copy. Clocks are only compared across devices when two edits race, so a
 * skewed clock can at worst pick the wrong one of two near-simultaneous edits.
 *
 * Local records are kept as plaintext in IndexedDB on this device (next to the data key, which is
 * what protects them at rest anyway) and are wiped by clearLocalVault() at sign-out.
 *
 * Exported surface:
 *   createVaultStore({ api, dataKey, storage?, now? }): VaultStore
 *   idbStorage(): SyncStorage / memoryStorage(): SyncStorage
 *   SETTINGS_ID: the fixed id of the one 'settings' record
 *   interface VaultRecord<T> { id, kind, data: T, updatedAt, pending }
 *   interface VaultStore {
 *     list<T>(kind?): Promise<VaultRecord<T>[]>   newest first, deleted ones left out
 *     get<T>(id): Promise<VaultRecord<T> | null>
 *     save<T>(kind, data, id?): Promise<VaultRecord<T>>   id defaults to a new UUID
 *     remove(id): Promise<void>
 *     sync(): Promise<SyncResult>                 throws VaultError('offline' | 'unauthenticated' …)
 *     pending(): Promise<number>
 *     subscribe(fn): () => void                   called after local changes and after each sync
 *   }
 */
import { VaultError, type VaultClient } from './client';
import { openRecord, sealRecord } from './crypto';
import { idbAll, idbDelete, idbGet, idbPut } from './idb';
import type { Envelope, RecordKind, SealedRecord } from './types';

export const SETTINGS_ID = '00000000-0000-4000-8000-000000000001';
const MAX_ATTEMPTS = 4;

/** What the store keeps per record. version 0 = never reached the server. */
export interface LocalRecord<T = unknown> {
  id: string; kind: RecordKind; data: T; updatedAt: number
  version: number; dirty: boolean; deleted: boolean
  /** Set when the server refused the record (e.g. too_large); it is not retried until saved again. */
  error?: string
}

export interface VaultRecord<T = unknown> { id: string; kind: RecordKind; data: T; updatedAt: number; pending: boolean }

export interface SyncResult { pushed: number; pulled: number; conflicts: number; failed: number; rejected: { id: string; code: string }[] }

export interface SyncStorage {
  get(id: string): Promise<LocalRecord | undefined>
  all(): Promise<LocalRecord[]>
  put(rec: LocalRecord): Promise<void>
  delete(id: string): Promise<void>
  getMeta(key: string): Promise<string | undefined>
  setMeta(key: string, value: string): Promise<void>
}

export function idbStorage(): SyncStorage {
  return {
    get: id => idbGet<LocalRecord>('records', id),
    all: () => idbAll<LocalRecord>('records'),
    put: rec => idbPut('records', rec),
    delete: id => idbDelete('records', id).then(() => undefined),
    getMeta: key => idbGet<string>('meta', key),
    setMeta: (key, value) => idbPut('meta', value, key),
  };
}

export function memoryStorage(): SyncStorage {
  const recs = new Map<string, LocalRecord>(), meta = new Map<string, string>();
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    get: async id => (recs.has(id) ? copy(recs.get(id)!) : undefined),
    all: async () => [...recs.values()].map(copy),
    put: async rec => void recs.set(rec.id, copy(rec)),
    delete: async id => void recs.delete(id),
    getMeta: async key => meta.get(key),
    setMeta: async (key, value) => void meta.set(key, value),
  };
}

export interface VaultStore {
  list<T = unknown>(kind?: RecordKind): Promise<VaultRecord<T>[]>
  get<T = unknown>(id: string): Promise<VaultRecord<T> | null>
  save<T = unknown>(kind: RecordKind, data: T, id?: string): Promise<VaultRecord<T>>
  remove(id: string): Promise<void>
  sync(): Promise<SyncResult>
  pending(): Promise<number>
  subscribe(fn: () => void): () => void
}

const view = <T>(r: LocalRecord): VaultRecord<T> => ({ id: r.id, kind: r.kind, data: r.data as T, updatedAt: r.updatedAt, pending: r.dirty });

export function createVaultStore(opts: {
  api: Pick<VaultClient, 'pull' | 'put' | 'remove'>
  dataKey: CryptoKey
  storage?: SyncStorage
  now?: () => number
}): VaultStore {
  const { api, dataKey } = opts;
  const store = opts.storage ?? idbStorage();
  const now = opts.now ?? Date.now;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(fn => { try { fn(); } catch { /* a listener's problem */ } });
  let running: Promise<SyncResult> | null = null;

  async function open(rec: SealedRecord): Promise<Envelope | null> {
    try {
      const env = await openRecord<Envelope>(dataKey, rec.id, rec.kind, rec);
      return env && typeof env.updatedAt === 'number' && 'data' in env ? env : null;
    } catch {
      return null;
    }
  }

  /** Stores the server's copy as the clean local one, unless the record was edited meanwhile. */
  async function acceptRemote(rec: SealedRecord, env: Envelope, editedAt: number) {
    const latest = await store.get(rec.id);
    if (latest && latest.updatedAt !== editedAt) return;
    await store.put({ id: rec.id, kind: rec.kind, data: env.data, updatedAt: env.updatedAt, version: rec.version, dirty: false, deleted: false });
  }

  /** After the server took our write: clean, unless it was edited again while the request was out. */
  async function committed(r: LocalRecord, version: number) {
    const latest = await store.get(r.id);
    if (!latest) return;
    if (latest.updatedAt === r.updatedAt && latest.deleted === r.deleted) {
      if (r.deleted) await store.delete(r.id);
      else await store.put({ ...latest, version, dirty: false, error: undefined });
    } else {
      await store.put({ ...latest, version });
    }
  }

  async function pushOne(start: LocalRecord, result: SyncResult) {
    const r = { ...start };
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        if (r.deleted) {
          await api.remove(r.id, r.version);
          await committed(r, r.version + 1);
        } else {
          const sealed = await sealRecord(dataKey, r.id, r.kind, { updatedAt: r.updatedAt, data: r.data } satisfies Envelope);
          const { version } = await api.put(r.id, { kind: r.kind, ...sealed, baseVersion: r.version });
          await committed(r, version);
        }
        result.pushed++;
        return;
      } catch (e) {
        if (!(e instanceof VaultError)) throw e;
        if (e.code === 'too_large' || e.code === 'bad_request') {
          const latest = await store.get(r.id);
          if (latest && latest.updatedAt === r.updatedAt) await store.put({ ...latest, error: e.code });
          result.rejected.push({ id: r.id, code: e.code });
          return;
        }
        if (e.code !== 'conflict') throw e; // offline, signed out, rate limited: stop this sync
        result.conflicts++;
        const cur = (e.body.current ?? null) as SealedRecord | null;
        if (!cur) {
          r.version = 0; // gone from the server: write it as new
          continue;
        }
        if (cur.deleted) {
          if (r.deleted || Date.parse(cur.updatedAt) >= r.updatedAt) {
            const latest = await store.get(r.id);
            if (latest && latest.updatedAt === r.updatedAt) await store.delete(r.id);
            return;
          }
          r.version = cur.version; // our edit is newer than the deletion
          continue;
        }
        const env = await open(cur);
        if (!env) {
          result.failed++;
          return;
        }
        if (env.updatedAt >= r.updatedAt) {
          await acceptRemote(cur, env, r.updatedAt); // theirs is newer (ties keep the server's)
          return;
        }
        r.version = cur.version; // ours is newer: try again on top of theirs
      }
    }
  }

  async function pull(result: SyncResult) {
    let cursor = await store.getMeta('cursor');
    let reset = false;
    const seen = new Set<string>();
    for (;;) {
      const page = await api.pull(cursor);
      if (page.reset) reset = true;
      for (const rec of page.records) {
        seen.add(rec.id);
        const local = await store.get(rec.id);
        if (local?.dirty) continue; // our own change is queued; the push settles it
        if (rec.deleted) {
          if (local) {
            await store.delete(rec.id);
            result.pulled++;
          }
          continue;
        }
        if (local && local.version >= rec.version) continue;
        const env = await open(rec);
        if (!env) {
          result.failed++;
          continue;
        }
        const latest = await store.get(rec.id);
        if (latest?.dirty) continue;
        await store.put({ id: rec.id, kind: rec.kind, data: env.data, updatedAt: env.updatedAt, version: rec.version, dirty: false, deleted: false });
        result.pulled++;
      }
      cursor = page.cursor;
      await store.setMeta('cursor', cursor);
      if (!page.more) break;
    }
    if (reset) {
      for (const local of await store.all()) {
        if (!local.dirty && local.version > 0 && !seen.has(local.id)) await store.delete(local.id);
      }
    }
  }

  async function runSync(): Promise<SyncResult> {
    const result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0, failed: 0, rejected: [] };
    try {
      for (const r of await store.all()) if (r.dirty && !r.error) await pushOne(r, result);
      await pull(result);
      return result;
    } finally {
      notify();
    }
  }

  return {
    async list<T>(kind?: RecordKind) {
      const all = await store.all();
      return all.filter(r => !r.deleted && (!kind || r.kind === kind)).sort((a, b) => b.updatedAt - a.updatedAt).map(r => view<T>(r));
    },
    async get<T>(id: string) {
      const r = await store.get(id);
      return r && !r.deleted ? view<T>(r) : null;
    },
    async save<T>(kind: RecordKind, data: T, id: string = crypto.randomUUID()) {
      const prev = await store.get(id);
      // Strictly later than the previous edit, even if the clock has not moved.
      const updatedAt = Math.max(now(), (prev?.updatedAt ?? 0) + 1);
      const rec: LocalRecord<T> = { id, kind, data, updatedAt, version: prev?.version ?? 0, dirty: true, deleted: false };
      await store.put(rec);
      notify();
      return view<T>(rec);
    },
    async remove(id: string) {
      const prev = await store.get(id);
      if (!prev) return;
      if (prev.version === 0) await store.delete(id); // never left this device
      else await store.put({ ...prev, deleted: true, dirty: true, error: undefined, updatedAt: Math.max(now(), prev.updatedAt + 1) });
      notify();
    },
    sync() {
      running ??= runSync().finally(() => { running = null; });
      return running;
    },
    async pending() {
      return (await store.all()).filter(r => r.dirty).length;
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
