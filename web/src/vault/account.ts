/**
 * Account flows, each combining crypto.ts, the API client and session.ts, so screens never handle
 * keys themselves. Every function takes the client last (default: `vault`), which tests replace.
 *
 * Exported surface:
 *   interface Account { me: Me; dataKey: CryptoKey }       dataKey is non-extractable
 *   signUp(email, password, api?): Promise<{ account, recoveryKey }>   show recoveryKey once, make the user keep it
 *   signIn(email, password, api?): Promise<Account>                   VaultError 401 on a wrong password
 *   resume(api?): Promise<Account | { me: MeWithKey; dataKey: null } | null>
 *       on load: null = signed out; dataKey null = signed in but this device lost the key → unlock()
 *   unlock(me, password, api?): Promise<Account>                      re-derives the key without a new session
 *   signOut(api?): Promise<void>                                      also works offline; wipes local data
 *   recoverAccount(email, recoveryKey, newPassword, api?): Promise<Account>   WrongRecoveryKey if it does not fit
 *   changePassword(currentPassword, newPassword, api?): Promise<void> signs out other devices
 *   regenerateRecoveryKey(password, api?): Promise<string>            the old recovery key stops working
 *   deleteAccount(password, api?): Promise<void>
 */
import { vault, type VaultClient } from './client';
import {
  derivePasswordKeys, deriveRecoveryKeys, newDataKey, newRecoveryKey, newSalt, unwrapDataKey, wrapDataKey,
} from './crypto';
import { clearLocalVault, loadDataKey, saveDataKey } from './session';
import type { Me, MeWithKey } from './types';

export interface Account { me: Me; dataKey: CryptoKey }

/** The recovery key does not open this account (or there is no such account: the two look the same). */
export class WrongRecoveryKey extends Error {
  constructor() {
    super('That recovery key does not match this email.');
    this.name = 'WrongRecoveryKey';
  }
}

async function passwordKeys(email: string, password: string, api: VaultClient) {
  const { salt, iterations } = await api.params(email);
  return derivePasswordKeys(password, salt, iterations);
}

async function keep(me: Me, dataKey: CryptoKey): Promise<Account> {
  await saveDataKey(me.user.id, dataKey).catch(() => undefined); // storage blocked: works until reload
  return { me, dataKey };
}

export async function signUp(email: string, password: string, api: VaultClient = vault) {
  const salt = newSalt();
  const { authKey, wrapKey } = await derivePasswordKeys(password, salt);
  const recoveryKey = newRecoveryKey();
  const { recoveryAuth, recoveryWrap } = await deriveRecoveryKeys(recoveryKey);
  const extractable = await newDataKey();
  const me = await api.signup({
    email, salt, authKey, recoveryAuth,
    wrappedByPassword: await wrapDataKey(extractable, wrapKey),
    wrappedByRecovery: await wrapDataKey(extractable, recoveryWrap),
  });
  // Keep a non-extractable copy only.
  const dataKey = await unwrapDataKey(await wrapDataKey(extractable, wrapKey), wrapKey);
  return { account: await keep(me, dataKey), recoveryKey };
}

export async function signIn(email: string, password: string, api: VaultClient = vault): Promise<Account> {
  const { authKey, wrapKey } = await passwordKeys(email, password, api);
  const me = await api.login(email, authKey);
  return keep({ user: me.user }, await unwrapDataKey(me.wrappedByPassword, wrapKey));
}

export async function resume(api: VaultClient = vault): Promise<Account | { me: MeWithKey; dataKey: null } | null> {
  const me = await api.me();
  if (!me) {
    await clearLocalVault();
    return null;
  }
  const dataKey = await loadDataKey(me.user.id);
  return dataKey ? { me: { user: me.user }, dataKey } : { me, dataKey: null };
}

export async function unlock(me: MeWithKey, password: string, api: VaultClient = vault): Promise<Account> {
  const { wrapKey } = await passwordKeys(me.user.email, password, api);
  let dataKey: CryptoKey;
  try {
    dataKey = await unwrapDataKey(me.wrappedByPassword, wrapKey);
  } catch {
    throw new Error('That password is not right.');
  }
  return keep({ user: me.user }, dataKey);
}

export async function signOut(api: VaultClient = vault): Promise<void> {
  await api.logout().catch(() => undefined);
  await clearLocalVault();
}

export async function recoverAccount(email: string, recoveryKey: string, newPassword: string, api: VaultClient = vault): Promise<Account> {
  const { recoveryAuth, recoveryWrap } = await deriveRecoveryKeys(recoveryKey);
  const { wrappedByRecovery } = await api.recoverStart(email);
  let extractable: CryptoKey;
  try {
    extractable = await unwrapDataKey(wrappedByRecovery, recoveryWrap, true);
  } catch {
    throw new WrongRecoveryKey();
  }
  const salt = newSalt();
  const { authKey, wrapKey } = await derivePasswordKeys(newPassword, salt);
  const wrappedByPassword = await wrapDataKey(extractable, wrapKey);
  const me = await api.recover({ email, recoveryAuth, salt, authKey, wrappedByPassword });
  await clearLocalVault();
  return keep(me, await unwrapDataKey(wrappedByPassword, wrapKey));
}

/** The data key in a form that can be wrapped again, after proving the password. */
async function extractableKey(password: string, api: VaultClient) {
  const me = await api.me();
  if (!me) throw new Error('Sign in again.');
  const { authKey, wrapKey } = await passwordKeys(me.user.email, password, api);
  let key: CryptoKey;
  try {
    key = await unwrapDataKey(me.wrappedByPassword, wrapKey, true);
  } catch {
    throw new Error('That password is not right.');
  }
  return { me, authKey, key };
}

export async function changePassword(currentPassword: string, newPassword: string, api: VaultClient = vault): Promise<void> {
  const { authKey, key } = await extractableKey(currentPassword, api);
  const salt = newSalt();
  const next = await derivePasswordKeys(newPassword, salt);
  await api.changePassword({ authKey, salt, newAuthKey: next.authKey, wrappedByPassword: await wrapDataKey(key, next.wrapKey) });
}

export async function regenerateRecoveryKey(password: string, api: VaultClient = vault): Promise<string> {
  const { authKey, key } = await extractableKey(password, api);
  const recoveryKey = newRecoveryKey();
  const { recoveryAuth, recoveryWrap } = await deriveRecoveryKeys(recoveryKey);
  await api.setRecoveryKey({ authKey, recoveryAuth, wrappedByRecovery: await wrapDataKey(key, recoveryWrap) });
  return recoveryKey;
}

export async function deleteAccount(password: string, api: VaultClient = vault): Promise<void> {
  const { authKey } = await extractableKey(password, api);
  await api.deleteAccount(authKey);
  await clearLocalVault();
}
