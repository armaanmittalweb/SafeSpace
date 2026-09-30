/**
 * The web vault client's account flows and sync (web/src/vault) against the real API, with a fetch
 * that keeps a cookie jar per device. IndexedDB does not exist in Node, so the device key store is
 * skipped (the flows tolerate that) and sync uses memory storage.
 */
import { describe, expect, it } from 'vitest'
import { changePassword, deleteAccount, recoverAccount, regenerateRecoveryKey, signIn, signOut, signUp, WrongRecoveryKey } from '../../web/src/vault/account'
import { createVaultClient, VaultError } from '../../web/src/vault/client'
import { createVaultStore, memoryStorage } from '../../web/src/vault/sync'
import { ORIGIN, setup } from './helpers'

/** A client for one device: its own cookie jar, the app's Origin, requests into the Hono app. */
function device(s: ReturnType<typeof setup>) {
  let cookie = ''
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('origin', ORIGIN)
    if (cookie) headers.set('cookie', cookie)
    const res = await s.app.request(String(input), { ...init, headers }, s.env)
    const set = res.headers.get('set-cookie')
    if (set) cookie = /ss_session=([^;]*)/.test(set) && !/Max-Age=0/.test(set) ? set.split(';')[0] : ''
    return res
  }) as typeof fetch
  return createVaultClient({ baseUrl: 'https://safespace-api.amittal.dev', fetch: fetcher })
}

describe('web vault client against the API', () => {
  it('signs up, syncs between two devices, changes the password, recovers and deletes', async () => {
    const s = setup()
    const phone = device(s), laptop = device(s)

    const { account, recoveryKey } = await signUp('lee@example.com', 'first password', phone)
    expect(account.dataKey.extractable).toBe(false)
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/)

    const phoneStore = createVaultStore({ api: phone, dataKey: account.dataKey, storage: memoryStorage() })
    const saved = await phoneStore.save('checkin', { feeling: 2, note: 'calm morning' })
    expect((await phoneStore.sync()).pushed).toBe(1)

    await expect(signIn('lee@example.com', 'wrong password', laptop)).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
    const onLaptop = await signIn('lee@example.com', 'first password', laptop)
    const laptopStore = createVaultStore({ api: laptop, dataKey: onLaptop.dataKey, storage: memoryStorage() })
    await laptopStore.sync()
    expect((await laptopStore.get(saved.id))!.data).toEqual({ feeling: 2, note: 'calm morning' })

    // New password on the laptop: the phone is signed out, the laptop keeps going.
    await changePassword('first password', 'second password', laptop)
    await expect(phoneStore.sync()).rejects.toMatchObject({ code: 'unauthenticated' })
    await laptopStore.save('checkin', { feeling: 3 }, saved.id)
    expect((await laptopStore.sync()).pushed).toBe(1)

    // A new recovery key replaces the old one.
    const rk2 = await regenerateRecoveryKey('second password', laptop)
    await expect(recoverAccount('lee@example.com', recoveryKey, 'third password', phone)).rejects.toBeInstanceOf(WrongRecoveryKey)
    await expect(recoverAccount('nobody@example.com', rk2, 'third password', phone)).rejects.toBeInstanceOf(WrongRecoveryKey)
    const back = await recoverAccount('lee@example.com', rk2.toLowerCase(), 'third password', phone)
    const phone2 = createVaultStore({ api: phone, dataKey: back.dataKey, storage: memoryStorage() })
    await phone2.sync()
    expect((await phone2.get(saved.id))!.data).toEqual({ feeling: 3 })
    await expect(laptopStore.sync()).rejects.toBeInstanceOf(VaultError) // recovery signed everyone else out

    await signOut(phone)
    expect(await phone.me()).toBeNull()
    await signIn('lee@example.com', 'third password', phone)
    await expect(deleteAccount('not it', phone)).rejects.toThrow(/password/)
    await deleteAccount('third password', phone)
    await expect(signIn('lee@example.com', 'third password', phone)).rejects.toMatchObject({ status: 401 })
  }, 30_000)
})
