/**
 * Keeps the unwrapped data key on this device for the life of the session, so a reload does not ask
 * for the password again. The key is a non-extractable CryptoKey stored in IndexedDB: page scripts
 * can use it to encrypt and decrypt but can never read its bytes. Sign-out deletes it together with
 * the local records.
 *
 * Exported surface:
 *   saveDataKey(user, key): Promise<void>          key must be non-extractable (throws otherwise)
 *   loadDataKey(userId): Promise<CryptoKey | null> null if none, or it belongs to another user
 *   loadSaved(): Promise<{ user, key } | null>     whoever is signed in on this device (for offline start-up)
 *   clearLocalVault(): Promise<void>               deletes the key, the local records and the cursor
 */
import { idbClear, idbDelete, idbGet, idbPut } from './idb';
import type { Me } from './types';

interface Stored { userId: string; user: Me['user']; key: CryptoKey }
const SLOT = 'dataKey';

export async function saveDataKey(user: Me['user'], key: CryptoKey): Promise<void> {
  if (key.extractable) throw new Error('Store only a non-extractable data key.');
  await idbPut('keys', { userId: user.id, user, key } satisfies Stored, SLOT);
}

export async function loadSaved(): Promise<{ user: Me['user']; key: CryptoKey } | null> {
  try {
    const s = await idbGet<Stored>('keys', SLOT);
    return s ? { user: s.user, key: s.key } : null;
  } catch {
    return null; // private mode or storage blocked: the app asks for the password
  }
}

export async function loadDataKey(userId: string): Promise<CryptoKey | null> {
  const s = await loadSaved();
  return s && s.user.id === userId ? s.key : null;
}

export async function clearLocalVault(): Promise<void> {
  await Promise.allSettled([idbDelete('keys', SLOT), idbClear('records'), idbClear('meta')]);
}
