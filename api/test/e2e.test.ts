/**
 * The whole point of the vault: run the real browser-side crypto (web/src/vault/crypto.ts) under
 * Node's WebCrypto against the real API on SQLite, then look at every value the server stored.
 */
import { describe, expect, it } from 'vitest'
import {
  b64url, derivePasswordKeys, deriveRecoveryKeys, newDataKey, newRecoveryKey, newSalt, openRecord, sealRecord, unwrapDataKey, wrapDataKey,
} from '../../web/src/vault/crypto'
import { setup } from './helpers'

const PASSWORD = 'plum-tractor-velvet-42'
const SECRET_NOTE = 'argument with my sister about the flat'

describe('end to end: the server stores nothing it can read', () => {
  it('signs up, stores a check-in, signs in on another device, recovers, and never holds a readable byte', async () => {
    const s = setup()
    const email = 'mira@example.com'

    // Sign-up, as the browser does it.
    const salt = newSalt()
    const { authKey, wrapKey } = await derivePasswordKeys(PASSWORD, salt)
    const recoveryKey = newRecoveryKey()
    const { recoveryAuth, recoveryWrap } = await deriveRecoveryKeys(recoveryKey)
    const dataKey = await newDataKey()
    const rawDataKey = b64url(new Uint8Array((await crypto.subtle.exportKey('raw', dataKey)) as ArrayBuffer))
    const signup = await s.call('POST', '/api/auth/signup', {
      body: { email, salt, authKey, recoveryAuth, wrappedByPassword: await wrapDataKey(dataKey, wrapKey), wrappedByRecovery: await wrapDataKey(dataKey, recoveryWrap) },
    })
    expect(signup.status).toBe(201)

    // A check-in, sealed with the data key.
    const id = crypto.randomUUID()
    const checkin = { updatedAt: Date.now(), data: { id, createdAt: Date.now(), feeling: 4, tags: ['before exam'], note: SECRET_NOTE, measurement: { features: { hr_mean: 91.25 } } } }
    const sealed = await sealRecord(dataKey, id, 'checkin', checkin)
    expect((await s.call('PUT', `/api/records/${id}`, { cookie: signup.cookie, body: { kind: 'checkin', ...sealed, baseVersion: 0 } })).status).toBe(200)

    // Another device: only the email and password.
    const params = (await s.call('GET', `/api/auth/params?email=${email}`)).json
    const other = await derivePasswordKeys(PASSWORD, params.salt, params.iterations)
    const login = await s.call('POST', '/api/auth/login', { body: { email, authKey: other.authKey } })
    expect(login.status).toBe(200)
    const key2 = await unwrapDataKey(login.json.wrappedByPassword, other.wrapKey)
    const pulled = (await s.call('GET', '/api/records', { cookie: login.cookie })).json.records[0]
    expect(await openRecord(key2, pulled.id, pulled.kind, pulled)).toEqual(checkin)

    // Forgot the password: the recovery key gets the same data key back under a new password.
    const start = (await s.call('POST', '/api/auth/recover/start', { body: { email } })).json
    const rk = await deriveRecoveryKeys(recoveryKey.toLowerCase())
    const recovered = await unwrapDataKey(start.wrappedByRecovery, rk.recoveryWrap, true)
    const newSaltValue = newSalt()
    const next = await derivePasswordKeys('a-brand-new-password', newSaltValue)
    const rec = await s.call('POST', '/api/auth/recover', {
      body: { email, recoveryAuth: rk.recoveryAuth, salt: newSaltValue, authKey: next.authKey, wrappedByPassword: await wrapDataKey(recovered, next.wrapKey) },
    })
    expect(rec.status).toBe(200)
    const after = (await s.call('GET', '/api/records', { cookie: rec.cookie })).json.records[0]
    expect(await openRecord(recovered, after.id, after.kind, after)).toEqual(checkin)

    // The fake recovery blob for an unknown email does not unwrap with any key.
    const fake = (await s.call('POST', '/api/auth/recover/start', { body: { email: 'nobody@example.com' } })).json.wrappedByRecovery
    await expect(unwrapDataKey(fake, rk.recoveryWrap)).rejects.toThrow()

    // Now look at everything the server kept.
    const tables = (s.sql.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(t => t.name)
    const stored: string[] = []
    for (const t of tables) for (const row of s.sql.db.prepare(`SELECT * FROM ${t}`).all()) for (const v of Object.values(row as object)) stored.push(String(v))
    const everything = stored.join('\n')
    expect(everything).toContain(email) // sanity: the scan does see the data
    const secrets = {
      password: PASSWORD, newPassword: 'a-brand-new-password', note: SECRET_NOTE, tag: 'before exam', feature: '91.25',
      authKey, newAuthKey: next.authKey, recoveryAuth, recoveryKey, recoveryKeyCompact: recoveryKey.replace(/-/g, ''), rawDataKey,
    }
    for (const [name, value] of Object.entries(secrets)) {
      expect(everything.includes(value), `${name} must not be stored`).toBe(false)
      expect(everything.toLowerCase().includes(value.toLowerCase()), `${name} must not be stored in any case`).toBe(false)
    }
    // And no stored base64url value decodes to text containing the note.
    for (const v of stored) {
      if (!/^[A-Za-z0-9_-]{16,}$/.test(v)) continue
      expect(Buffer.from(v, 'base64url').toString('utf8')).not.toContain('sister')
    }
  })
})
