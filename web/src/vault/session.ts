/**
 * Keeps the unwrapped data key on this device for the life of the session, so a reload does not ask
 * for the password again. The key is a non-extractable CryptoKey stored in IndexedDB: page scripts
 * can use it to encrypt and decrypt but can never read its bytes. Sign-out deletes it together with
 * the local records.
 *
 * Exported surface:
 *   saveDataKey(userId, key): Promise<void>        key must be non-extractable (throws otherwise)
 *   loadDataKey(userId): Promise<CryptoKey | null> null if none, or it belongs to another user
 *   clearLocalVault(): Promise<void>               deletes the key, the local records and the cursor
 */
import { idbClear, idbDelete, idbGet, idbPut } from './idb';

interface Stored { userId: string; key: CryptoKey }
const SLOT = 'dataKey';

export async function saveDataKey(userId: string, key: CryptoKey): Promise<void> {
  if (key.extractable) throw new Error('Store only a non-extractable data key.');
  await idbPut('keys', { userId, key } satisfies Stored, SLOT);
}

export async function loadDataKey(userId: string): Promise<CryptoKey | null> {
  try {
    const s = await idbGet<Stored>('keys', SLOT);
    return s && s.userId === userId ? s.key : null;
  } catch {
    return null; // private mode or storage blocked: the app asks for the password
  }
}

export async function clearLocalVault(): Promise<void> {
  await Promise.allSettled([idbDelete('keys', SLOT), idbClear('records'), idbClear('meta')]);
}
