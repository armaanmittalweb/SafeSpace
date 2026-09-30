import { describe, expect, it } from 'vitest'
import { sha256hex } from '../src/keys'
import { ORIGIN, rand, setup, wrapped } from './helpers'

const DAY = 86_400_000

describe('health', () => {
  it('answers /api/test without D1', async () => {
    const s = setup()
    const res = await s.call('GET', '/api/test')
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true, service: 'safespace-api' })
  })
})

describe('sign-up, sign-in, sign-out', () => {
  it('signs up, sets the session cookie and stores only its SHA-256', async () => {
    const s = setup()
    const res = await s.call('POST', '/api/auth/signup', {
      body: { email: ' Ana@Example.com ', salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped(), recoveryAuth: rand(32), wrappedByRecovery: wrapped() },
    })
    expect(res.status).toBe(201)
    expect(res.json.user).toMatchObject({ email: 'ana@example.com', createdAt: new Date(s.clock.t).toISOString() })
    expect(res.setCookie).toMatch(/ss_session=[A-Za-z0-9_-]{43}/)
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=2592000']) expect(res.setCookie).toContain(attr)
    const token = res.cookie!.split('=')[1]
    const rows = s.sql.db.prepare('SELECT id FROM sessions').all() as { id: string }[]
    expect(rows).toEqual([{ id: await sha256hex(token) }])
    expect(JSON.stringify(s.sql.db.prepare('SELECT * FROM sessions').all())).not.toContain(token)

    const me = await s.call('GET', '/api/auth/me', { cookie: res.cookie })
    expect(me.status).toBe(200)
    expect(me.json.user.id).toBe(res.json.user.id)
    expect(me.json.wrappedByPassword).toBeDefined()
  })

  it('refuses a taken email with 409 and bad shapes with 400', async () => {
    const s = setup()
    await s.signup('ana@example.com')
    const again = await s.call('POST', '/api/auth/signup', {
      body: { email: 'ANA@example.com', salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped(), recoveryAuth: rand(32), wrappedByRecovery: wrapped() },
    })
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('conflict')
    const bad = await s.call('POST', '/api/auth/signup', { body: { email: 'b@example.com', salt: 'short', authKey: rand(32) } })
    expect(bad.status).toBe(400)
    expect(bad.json).toMatchObject({ code: 'bad_request', error: expect.any(String) })
  })

  it('stores hashes of authKey and recoveryAuth, never the keys', async () => {
    const s = setup()
    const u = await s.signup()
    const dump = JSON.stringify(s.sql.db.prepare('SELECT * FROM users').all())
    expect(dump).not.toContain(u.authKey)
    expect(dump).not.toContain(u.recoveryAuth)
    expect(dump).toMatch(/pbkdf2_sha256\$20000\$/)
  })

  it('logs in with the right authKey and returns wrappedByPassword', async () => {
    const s = setup()
    const u = await s.signup()
    const res = await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: u.authKey } })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ user: { id: u.id, email: u.email, createdAt: expect.any(String) }, wrappedByPassword: u.wrappedByPassword })
    expect(res.cookie).toBeDefined()
  })

  it('answers a wrong authKey and an unknown email with the same generic 401', async () => {
    const s = setup()
    const u = await s.signup()
    const wrong = await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: rand(32) } })
    const unknown = await s.call('POST', '/api/auth/login', { body: { email: 'nobody@example.com', authKey: rand(32) } })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.json).toEqual(unknown.json)
    expect(wrong.json.code).toBe('unauthenticated')
    expect(wrong.cookie).toBeUndefined()
  })

  it('rate-limits logins with the LOGIN_LIMITER binding', async () => {
    let n = 0
    const s = setup({ LOGIN_LIMITER: { limit: async () => ({ success: ++n <= 5 }) } })
    const u = await s.signup()
    for (let i = 0; i < 5; i++) await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: rand(32) } })
    const res = await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: u.authKey } })
    expect(res.status).toBe(429)
    expect(res.json.code).toBe('rate_limited')
  })

  it('allows 20 sign-ups per hour per IP', async () => {
    const s = setup()
    const ip = { 'cf-connecting-ip': '203.0.113.9' }
    const body = (i: number) => ({ email: `u${i}@example.com`, salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped(), recoveryAuth: rand(32), wrappedByRecovery: wrapped() })
    for (let i = 0; i < 20; i++) expect((await s.call('POST', '/api/auth/signup', { body: body(i), headers: ip })).status).toBe(201)
    expect((await s.call('POST', '/api/auth/signup', { body: body(20), headers: ip })).status).toBe(429)
    expect((await s.call('POST', '/api/auth/signup', { body: body(21), headers: { 'cf-connecting-ip': '203.0.113.10' } })).status).toBe(201)
    s.clock.t += 3_600_000
    expect((await s.call('POST', '/api/auth/signup', { body: body(22), headers: ip })).status).toBe(201)
    expect(JSON.stringify(s.sql.db.prepare('SELECT * FROM counters').all())).not.toContain('203.0.113')
  })

  it('logs out: 204, the session row is gone and the cookie is cleared', async () => {
    const s = setup()
    const u = await s.signup()
    const res = await s.call('POST', '/api/auth/logout', { cookie: u.cookie })
    expect(res.status).toBe(204)
    expect(res.setCookie).toMatch(/ss_session=;.*Max-Age=0/)
    expect(s.sql.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect((await s.call('GET', '/api/auth/me', { cookie: u.cookie })).status).toBe(401)
  })

  it('me is 401 without a cookie or with a made-up one', async () => {
    const s = setup()
    expect((await s.call('GET', '/api/auth/me')).json.code).toBe('unauthenticated')
    expect((await s.call('GET', '/api/auth/me', { cookie: 'ss_session=' + rand(32) })).status).toBe(401)
  })

  it('slides the session: last_seen_at and Max-Age move forward on use; 30 idle days end it', async () => {
    const s = setup()
    const u = await s.signup()
    s.clock.t += 20 * DAY
    const me = await s.call('GET', '/api/auth/me', { cookie: u.cookie })
    expect(me.status).toBe(200)
    expect(me.setCookie).toContain('Max-Age=2592000')
    expect(s.sql.db.prepare('SELECT last_seen_at, expires_at FROM sessions').get()).toEqual({ last_seen_at: s.clock.t, expires_at: s.clock.t + 30 * DAY })
    s.clock.t += 20 * DAY // 40 days after sign-up, 20 after last use
    expect((await s.call('GET', '/api/auth/me', { cookie: u.cookie })).status).toBe(200)
    s.clock.t += 31 * DAY
    expect((await s.call('GET', '/api/auth/me', { cookie: u.cookie })).status).toBe(401)
  })

  it('does not write on every request: last_seen_at moves at most hourly', async () => {
    const s = setup()
    const u = await s.signup()
    s.clock.t += 60_000
    const me = await s.call('GET', '/api/auth/me', { cookie: u.cookie })
    expect(me.setCookie).toBe('')
    expect(s.sql.db.prepare('SELECT last_seen_at FROM sessions').get()).toEqual({ last_seen_at: s.clock.t - 60_000 })
  })
})

describe('email enumeration', () => {
  it('params: an unknown email gets a stable salt shaped like a real one', async () => {
    const s = setup()
    const u = await s.signup()
    const known = await s.call('GET', `/api/auth/params?email=${encodeURIComponent(u.email)}`)
    expect(known.json).toEqual({ salt: u.salt, iterations: 310_000 })
    const a = await s.call('GET', '/api/auth/params?email=nobody@example.com')
    const b = await s.call('GET', '/api/auth/params?email=NOBODY@example.com')
    const c = await s.call('GET', '/api/auth/params?email=other@example.com')
    expect(a.status).toBe(200)
    expect(a.json).toEqual(b.json)
    expect(a.json.salt).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.json.iterations).toBe(310_000)
    expect(c.json.salt).not.toBe(a.json.salt)
    expect(Object.keys(a.json)).toEqual(Object.keys(known.json))
    // A different PARAMS_SECRET gives a different fake salt (it is not derivable without the secret).
    const other = setup({ PARAMS_SECRET: 'another' })
    expect((await other.call('GET', '/api/auth/params?email=nobody@example.com')).json.salt).not.toBe(a.json.salt)
  })

  it('recover/start: always 200, a stable blob of the real size for unknown emails', async () => {
    const s = setup()
    const u = await s.signup()
    const known = await s.call('POST', '/api/auth/recover/start', { body: { email: u.email } })
    expect(known.status).toBe(200)
    expect(known.json).toEqual({ wrappedByRecovery: u.wrappedByRecovery })
    const a = await s.call('POST', '/api/auth/recover/start', { body: { email: 'nobody@example.com' } })
    const b = await s.call('POST', '/api/auth/recover/start', { body: { email: 'nobody@example.com' } })
    expect(a.status).toBe(200)
    expect(a.json).toEqual(b.json)
    expect(a.json.wrappedByRecovery.iv.length).toBe(u.wrappedByRecovery.iv.length)
    expect(a.json.wrappedByRecovery.ct.length).toBe(u.wrappedByRecovery.ct.length)
  })

  it('refuses to invent answers without PARAMS_SECRET', async () => {
    const s = setup({ PARAMS_SECRET: undefined })
    expect((await s.call('GET', '/api/auth/params?email=a@example.com')).status).toBe(503)
  })
})

describe('recovery, password change and sessions', () => {
  it('recovers with the recovery key: rotates the password keys and revokes every other session', async () => {
    const s = setup()
    const u = await s.signup()
    const other = await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: u.authKey } })
    const bad = await s.call('POST', '/api/auth/recover', { body: { email: u.email, recoveryAuth: rand(32), salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped() } })
    expect(bad.status).toBe(401)
    const unknown = await s.call('POST', '/api/auth/recover', { body: { email: 'x@example.com', recoveryAuth: rand(32), salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped() } })
    expect(unknown.json).toEqual(bad.json)

    const next = { salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped() }
    const res = await s.call('POST', '/api/auth/recover', { body: { email: u.email, recoveryAuth: u.recoveryAuth, ...next } })
    expect(res.status).toBe(200)
    expect(res.json.user.id).toBe(u.id)
    expect(res.cookie).toBeDefined()
    expect((await s.call('GET', '/api/auth/me', { cookie: u.cookie })).status).toBe(401)
    expect((await s.call('GET', '/api/auth/me', { cookie: other.cookie })).status).toBe(401)
    const me = await s.call('GET', '/api/auth/me', { cookie: res.cookie })
    expect(me.json.wrappedByPassword).toEqual(next.wrappedByPassword)
    expect((await s.call('GET', `/api/auth/params?email=${u.email}`)).json.salt).toBe(next.salt)
    expect((await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: u.authKey } })).status).toBe(401)
    expect((await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: next.authKey } })).status).toBe(200)
    // The recovery key itself still works (the data key did not change).
    expect((await s.call('POST', '/api/auth/recover/start', { body: { email: u.email } })).json.wrappedByRecovery).toEqual(u.wrappedByRecovery)
  })

  it('changes the password: checks the current authKey, keeps this session, revokes the others', async () => {
    const s = setup()
    const u = await s.signup()
    const other = await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: u.authKey } })
    const next = { salt: rand(16), newAuthKey: rand(32), wrappedByPassword: wrapped() }
    const wrong = await s.call('POST', '/api/auth/password', { cookie: u.cookie, body: { authKey: rand(32), ...next } })
    expect(wrong.status).toBe(403)
    expect(wrong.json.code).toBe('forbidden')
    const ok = await s.call('POST', '/api/auth/password', { cookie: u.cookie, body: { authKey: u.authKey, ...next } })
    expect(ok.status).toBe(204)
    expect((await s.call('GET', '/api/auth/me', { cookie: u.cookie })).json.wrappedByPassword).toEqual(next.wrappedByPassword)
    expect((await s.call('GET', '/api/auth/me', { cookie: other.cookie })).status).toBe(401)
    expect((await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: next.newAuthKey } })).status).toBe(200)
    expect((await s.call('POST', '/api/auth/password', { body: { authKey: u.authKey, ...next } })).status).toBe(401)
  })

  it('replaces the recovery key after checking the password', async () => {
    const s = setup()
    const u = await s.signup()
    const next = { recoveryAuth: rand(32), wrappedByRecovery: wrapped() }
    expect((await s.call('POST', '/api/auth/recovery-key', { cookie: u.cookie, body: { authKey: rand(32), ...next } })).status).toBe(403)
    expect((await s.call('POST', '/api/auth/recovery-key', { cookie: u.cookie, body: { authKey: u.authKey, ...next } })).status).toBe(204)
    expect((await s.call('POST', '/api/auth/recover/start', { body: { email: u.email } })).json.wrappedByRecovery).toEqual(next.wrappedByRecovery)
    const old = await s.call('POST', '/api/auth/recover', { body: { email: u.email, recoveryAuth: u.recoveryAuth, salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped() } })
    expect(old.status).toBe(401)
  })

  it('lists sessions with the current one flagged, and signs out another device', async () => {
    const s = setup()
    const u = await s.signup()
    const phone = await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: u.authKey }, headers: { 'user-agent': 'Phone' } })
    const list = await s.call('GET', '/api/auth/sessions', { cookie: u.cookie })
    expect(list.status).toBe(200)
    expect(list.json).toHaveLength(2)
    expect(list.json.filter((x: { current: boolean }) => x.current)).toHaveLength(1)
    const phoneRow = list.json.find((x: { userAgent: string | null }) => x.userAgent === 'Phone')
    expect(phoneRow).toMatchObject({ current: false, createdAt: expect.any(String), lastSeenAt: expect.any(String) })
    expect((await s.call('DELETE', `/api/auth/sessions/${phoneRow.id}`, { cookie: u.cookie })).status).toBe(204)
    expect((await s.call('GET', '/api/auth/me', { cookie: phone.cookie })).status).toBe(401)
    expect((await s.call('DELETE', `/api/auth/sessions/${phoneRow.id}`, { cookie: u.cookie })).status).toBe(404)
    // Another user's session id cannot be ended.
    const v = await s.signup('vic@example.com')
    const vid = (await s.call('GET', '/api/auth/sessions', { cookie: v.cookie })).json[0].id
    expect((await s.call('DELETE', `/api/auth/sessions/${vid}`, { cookie: u.cookie })).status).toBe(404)
  })
})

describe('CSRF and CORS', () => {
  it('refuses state changes without the app origin or a JSON content type', async () => {
    const s = setup()
    const u = await s.signup()
    const body = { email: u.email, authKey: u.authKey }
    expect((await s.call('POST', '/api/auth/login', { body, origin: null })).status).toBe(403)
    expect((await s.call('POST', '/api/auth/login', { body, origin: 'https://evil.example' })).status).toBe(403)
    expect((await s.call('POST', '/api/auth/login', { body, type: 'text/plain' })).status).toBe(403)
    expect((await s.call('POST', '/api/auth/login', { body, type: 'application/x-www-form-urlencoded' })).status).toBe(403)
    const del = await s.call('DELETE', '/api/records/11111111-1111-4111-8111-111111111111', { cookie: u.cookie, origin: 'https://safespace.amittal.dev.evil.example' })
    expect(del.status).toBe(403)
    expect(del.json.code).toBe('forbidden')
    expect((await s.call('POST', '/api/auth/login', { body, origin: 'http://localhost:5175' })).status).toBe(200)
  })

  it('answers preflights for the app origins only, with credentials', async () => {
    const s = setup()
    const ok = await s.call('OPTIONS', '/api/records', { headers: { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true')
    const evil = await s.call('OPTIONS', '/api/records', { origin: 'https://evil.example', headers: { 'access-control-request-method': 'PUT' } })
    expect(evil.headers.get('access-control-allow-origin')).toBeNull()
    const get = await s.call('GET', '/api/test', { origin: 'https://evil.example' })
    expect(get.headers.get('access-control-allow-origin')).toBeNull()
  })
})
