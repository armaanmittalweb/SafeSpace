import { describe, expect, it } from 'vitest';
import {
  b64url, derivePasswordKeys, deriveRecoveryKeys, fromB64url, newDataKey, newRecoveryKey, newSalt, openRecord,
  parseRecoveryKey, sealRecord, unwrapDataKey, wrapDataKey,
} from '../../src/vault/crypto';

const FAST = 1000; // PBKDF2 rounds for tests that are not about PBKDF2

describe('vault crypto', () => {
  it('base64url round-trips any bytes, without padding', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7919) & 255);
    const text = b64url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromB64url(text)).toEqual(bytes);
    expect(newSalt()).toHaveLength(22);
  });

  it('derives the same authKey for the same password and salt, and a different one otherwise', async () => {
    const salt = newSalt();
    const a = await derivePasswordKeys('correct horse', salt, FAST);
    const b = await derivePasswordKeys('correct horse', salt, FAST);
    const c = await derivePasswordKeys('correct horsf', salt, FAST);
    const d = await derivePasswordKeys('correct horse', newSalt(), FAST);
    expect(a.authKey).toHaveLength(43);
    expect(a.authKey).toBe(b.authKey);
    expect(c.authKey).not.toBe(a.authKey);
    expect(d.authKey).not.toBe(a.authKey);
    expect(a.wrapKey.extractable).toBe(false);
  });

  it('matches the contract derivation (PBKDF2 310k, HKDF with empty salt and the named info)', async () => {
    const salt = newSalt();
    const pw = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveBits']);
    const master = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations: 310_000 }, pw, 256);
    const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
    const auth = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('safespace auth') }, base, 256);
    expect((await derivePasswordKeys('pw', salt)).authKey).toBe(b64url(new Uint8Array(auth)));
  });

  it('wraps and unwraps the data key with the password and with the recovery key', async () => {
    const dataKey = await newDataKey();
    const { wrapKey } = await derivePasswordKeys('pw', newSalt(), FAST);
    const rk = newRecoveryKey();
    const { recoveryWrap, recoveryAuth } = await deriveRecoveryKeys(rk);
    expect(recoveryAuth).toHaveLength(43);
    const byPw = await wrapDataKey(dataKey, wrapKey), byRk = await wrapDataKey(dataKey, recoveryWrap);
    expect(fromB64url(byPw.iv)).toHaveLength(12);
    expect(fromB64url(byPw.ct)).toHaveLength(48);
    const k1 = await unwrapDataKey(byPw, wrapKey);
    const k2 = await unwrapDataKey(byRk, recoveryWrap);
    expect(k1.extractable).toBe(false);
    const sealed = await sealRecord(dataKey, 'id-1', 'checkin', { hello: 'world' });
    expect(await openRecord(k1, 'id-1', 'checkin', sealed)).toEqual({ hello: 'world' });
    expect(await openRecord(k2, 'id-1', 'checkin', sealed)).toEqual({ hello: 'world' });
    const other = await derivePasswordKeys('other', newSalt(), FAST);
    await expect(unwrapDataKey(byPw, other.wrapKey)).rejects.toThrow();
  });

  it('seals records bound to their id and kind', async () => {
    const key = await newDataKey();
    const value = { feeling: 3, tags: ['before exam'], note: 'ünïcødé' };
    const sealed = await sealRecord(key, 'a', 'checkin', value);
    expect(fromB64url(sealed.iv)).toHaveLength(12);
    expect(await openRecord(key, 'a', 'checkin', sealed)).toEqual(value);
    await expect(openRecord(key, 'b', 'checkin', sealed)).rejects.toThrow();
    await expect(openRecord(key, 'a', 'settings', sealed)).rejects.toThrow();
    await expect(openRecord(await newDataKey(), 'a', 'checkin', sealed)).rejects.toThrow();
    const again = await sealRecord(key, 'a', 'checkin', value);
    expect(again.iv).not.toBe(sealed.iv);
  });

  it('formats recovery keys as 8 groups of 4 Crockford base32 characters and parses them forgivingly', async () => {
    const rk = newRecoveryKey();
    expect(rk).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    const bytes = parseRecoveryKey(rk)!;
    expect(bytes).toHaveLength(20);
    expect(parseRecoveryKey(rk.toLowerCase().replace(/-/g, ' '))).toEqual(bytes);
    const withLookalikes = rk.replace(/1/g, 'l').replace(/0/g, 'O');
    expect(parseRecoveryKey(withLookalikes)).toEqual(bytes);
    expect(parseRecoveryKey(rk.slice(0, -1))).toBeNull();
    expect(parseRecoveryKey(rk.slice(0, -1) + 'U')).toBeNull();
    // Same key typed differently derives the same recoveryAuth.
    expect((await deriveRecoveryKeys(rk)).recoveryAuth).toBe((await deriveRecoveryKeys(rk.toLowerCase())).recoveryAuth);
    await expect(deriveRecoveryKeys('not a key')).rejects.toThrow(/recovery key/);
    // Known vector: 20 zero bytes → 32 zeros; 20 0xff bytes → 32 Z's.
    expect(parseRecoveryKey('0000-0000-0000-0000-0000-0000-0000-0000')).toEqual(new Uint8Array(20));
    expect(parseRecoveryKey('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ')).toEqual(new Uint8Array(20).fill(255));
  });
});
