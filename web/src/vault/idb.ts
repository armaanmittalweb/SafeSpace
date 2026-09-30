/**
 * A few promise helpers over one IndexedDB database, `safespace-vault`, shared by session.ts (the
 * data key) and sync.ts (records and the pull cursor). Internal to the vault folder.
 */
export const DB_NAME = 'safespace-vault';
export type StoreName = 'keys' | 'records' | 'meta';

let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return done(fn(db.transaction(store, mode).objectStore(store)));
}

export const idbGet = <T>(store: StoreName, key: IDBValidKey) => tx(store, 'readonly', s => s.get(key)) as Promise<T | undefined>;
export const idbAll = <T>(store: StoreName) => tx(store, 'readonly', s => s.getAll()) as Promise<T[]>;
export const idbPut = (store: StoreName, value: unknown, key?: IDBValidKey) => tx(store, 'readwrite', s => s.put(value, key)).then(() => undefined);
export const idbDelete = (store: StoreName, key: IDBValidKey) => tx(store, 'readwrite', s => s.delete(key));
export const idbClear = (store: StoreName) => tx(store, 'readwrite', s => s.clear());
