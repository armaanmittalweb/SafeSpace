/**
 * /api/auth/*: accounts and sessions. The server never sees the password: it gets authKey (and, at
 * sign-up and recovery, recoveryAuth), both HKDF outputs, and keeps only PBKDF2 hashes of them.
 * Unknown emails get answers shaped exactly like real ones from /params and /recover/start.
 */
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import {
  CLIENT_ITERATIONS, COOKIE, clearCookie, clientIp, countHour, fail, hitLimiter, iso, isKey, isSalt, normEmail, readJson,
  SIGNUPS_PER_HOUR, startSession, wrappedOf, type App, type AppEnv, type Ctx, type Deps,
} from './http'
import { DUMMY_HASH, fakeSalt, fakeWrapped, hashKey, sha256hex, verifyKey } from './keys'

interface UserRow {
  id: string; email: string; salt: string; auth_hash: string; recovery_hash: string
  wrapped_password: string; wrapped_recovery: string; created_at: number
}

const meOf = (u: UserRow) => ({ user: { id: u.id, email: u.email, createdAt: iso(u.created_at) } })
const tooMany = (c: Ctx) => fail(c, 429, 'rate_limited', 'Too many tries. Wait a minute and try again.')

export function authRoutes(app: App, deps: Deps, requireUser: MiddlewareHandler<AppEnv>) {
  const now = deps.now ?? Date.now
  const userByEmail = async (c: Ctx, email: string) =>
    (await deps.sql(c.env).all<UserRow>('SELECT * FROM users WHERE email = ?', email))[0] ?? null
  const userById = async (c: Ctx, id: string) =>
    (await deps.sql(c.env).all<UserRow>('SELECT * FROM users WHERE id = ?', id))[0] ?? null
  const secret = (c: Ctx) => c.env.PARAMS_SECRET

  app.get('/api/auth/params', async c => {
    const email = normEmail(c.req.query('email'))
    if (!email) return fail(c, 400, 'bad_request', 'Enter a valid email address.')
    if (!secret(c)) return fail(c, 503, 'unavailable', 'Accounts are not set up on this server yet.')
    // Computed for every email, so known and unknown ones take the same work.
    const fake = await fakeSalt(secret(c)!, email)
    const user = await userByEmail(c, email)
    return c.json({ salt: user?.salt ?? fake, iterations: CLIENT_ITERATIONS })
  })

  app.post('/api/auth/signup', async c => {
    const b = await readJson(c)
    const email = normEmail(b?.email)
    const wp = wrappedOf(b?.wrappedByPassword), wr = wrappedOf(b?.wrappedByRecovery)
    if (!b || !email || !isSalt(b.salt) || !isKey(b.authKey) || !isKey(b.recoveryAuth) || !wp || !wr) {
      return fail(c, 400, 'bad_request', 'Expected {email, salt, authKey, wrappedByPassword, recoveryAuth, wrappedByRecovery}.')
    }
    const sql = deps.sql(c.env), t = now()
    if (!(await countHour(sql, 'signup:' + (await sha256hex(clientIp(c))), t, SIGNUPS_PER_HOUR))) return tooMany(c)
    if (await userByEmail(c, email)) return fail(c, 409, 'conflict', 'An account with this email already exists. Sign in instead.')
    const id = crypto.randomUUID()
    try {
      await sql.run(
        `INSERT INTO users (id, email, salt, auth_hash, recovery_hash, wrapped_password, wrapped_recovery, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, email, b.salt, await hashKey(b.authKey), await hashKey(b.recoveryAuth), JSON.stringify(wp), JSON.stringify(wr), t)
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return fail(c, 409, 'conflict', 'An account with this email already exists. Sign in instead.')
      throw e
    }
    await startSession(c, sql, id, t)
    return c.json({ user: { id, email, createdAt: iso(t) } }, 201)
  })

  app.post('/api/auth/login', async c => {
    if (!(await hitLimiter(c.env.LOGIN_LIMITER, clientIp(c)))) return tooMany(c)
    const b = await readJson(c)
    const email = normEmail(b?.email)
    if (!email || !isKey(b?.authKey)) return fail(c, 400, 'bad_request', 'Expected {email, authKey}.')
    const user = await userByEmail(c, email)
    // Unknown emails still pay for one hash, so timing does not tell them apart.
    const ok = await verifyKey(b.authKey, user?.auth_hash ?? DUMMY_HASH)
    if (!user || !ok) return fail(c, 401, 'unauthenticated', 'That email and password do not match.')
    await startSession(c, deps.sql(c.env), user.id, now())
    return c.json({ ...meOf(user), wrappedByPassword: JSON.parse(user.wrapped_password) })
  })

  app.post('/api/auth/logout', async c => {
    const token = getCookie(c, COOKIE)
    if (token) await deps.sql(c.env).run('DELETE FROM sessions WHERE id = ?', await sha256hex(token))
    clearCookie(c)
    return c.body(null, 204)
  })

  app.get('/api/auth/me', requireUser, async c => {
    const user = await userById(c, c.get('user').id)
    if (!user) return fail(c, 401, 'unauthenticated', 'Sign in again.')
    return c.json({ ...meOf(user), wrappedByPassword: JSON.parse(user.wrapped_password) })
  })

  app.post('/api/auth/recover/start', async c => {
    if (!(await hitLimiter(c.env.LOGIN_LIMITER, clientIp(c)))) return tooMany(c)
    const b = await readJson(c)
    const email = normEmail(b?.email)
    if (!email) return fail(c, 400, 'bad_request', 'Enter a valid email address.')
    if (!secret(c)) return fail(c, 503, 'unavailable', 'Accounts are not set up on this server yet.')
    const fake = await fakeWrapped(secret(c)!, email)
    const user = await userByEmail(c, email)
    return c.json({ wrappedByRecovery: user ? JSON.parse(user.wrapped_recovery) : fake })
  })

  app.post('/api/auth/recover', async c => {
    if (!(await hitLimiter(c.env.LOGIN_LIMITER, clientIp(c)))) return tooMany(c)
    const b = await readJson(c)
    const email = normEmail(b?.email), wp = wrappedOf(b?.wrappedByPassword)
    if (!b || !email || !isKey(b.recoveryAuth) || !isSalt(b.salt) || !isKey(b.authKey) || !wp) {
      return fail(c, 400, 'bad_request', 'Expected {email, recoveryAuth, salt, authKey, wrappedByPassword}.')
    }
    const user = await userByEmail(c, email)
    const ok = await verifyKey(b.recoveryAuth, user?.recovery_hash ?? DUMMY_HASH)
    if (!user || !ok) return fail(c, 401, 'unauthenticated', 'That email and recovery key do not match.')
    const sql = deps.sql(c.env), t = now()
    await sql.batch([
      ['UPDATE users SET salt = ?, auth_hash = ?, wrapped_password = ? WHERE id = ?', b.salt, await hashKey(b.authKey), JSON.stringify(wp), user.id],
      ['DELETE FROM sessions WHERE user_id = ?', user.id],
    ])
    await startSession(c, sql, user.id, t)
    return c.json(meOf(user))
  })

  app.post('/api/auth/password', requireUser, async c => {
    if (!(await hitLimiter(c.env.LOGIN_LIMITER, clientIp(c)))) return tooMany(c)
    const b = await readJson(c)
    const wp = wrappedOf(b?.wrappedByPassword)
    if (!b || !isKey(b.authKey) || !isSalt(b.salt) || !isKey(b.newAuthKey) || !wp) {
      return fail(c, 400, 'bad_request', 'Expected {authKey, salt, newAuthKey, wrappedByPassword}.')
    }
    const user = await userById(c, c.get('user').id)
    if (!user || !(await verifyKey(b.authKey, user.auth_hash))) return fail(c, 403, 'forbidden', 'Your current password is not right.')
    await deps.sql(c.env).batch([
      ['UPDATE users SET salt = ?, auth_hash = ?, wrapped_password = ? WHERE id = ?', b.salt, await hashKey(b.newAuthKey), JSON.stringify(wp), user.id],
      ['DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, c.get('sessionId')],
    ])
    return c.body(null, 204)
  })

  // Not in the first draft of the contract: Settings → "Recovery key (regenerate)" needs it.
  app.post('/api/auth/recovery-key', requireUser, async c => {
    if (!(await hitLimiter(c.env.LOGIN_LIMITER, clientIp(c)))) return tooMany(c)
    const b = await readJson(c)
    const wr = wrappedOf(b?.wrappedByRecovery)
    if (!b || !isKey(b.authKey) || !isKey(b.recoveryAuth) || !wr) return fail(c, 400, 'bad_request', 'Expected {authKey, recoveryAuth, wrappedByRecovery}.')
    const user = await userById(c, c.get('user').id)
    if (!user || !(await verifyKey(b.authKey, user.auth_hash))) return fail(c, 403, 'forbidden', 'Your password is not right.')
    await deps.sql(c.env).run('UPDATE users SET recovery_hash = ?, wrapped_recovery = ? WHERE id = ?', await hashKey(b.recoveryAuth), JSON.stringify(wr), user.id)
    return c.body(null, 204)
  })

  app.get('/api/auth/sessions', requireUser, async c => {
    const rows = await deps.sql(c.env).all<{ id: string; user_agent: string | null; created_at: number; last_seen_at: number }>(
      'SELECT id, user_agent, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', c.get('user').id, now())
    return c.json(rows.map(r => ({ id: r.id, current: r.id === c.get('sessionId'), userAgent: r.user_agent, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at) })))
  })

  app.delete('/api/auth/sessions/:id', requireUser, async c => {
    const id = c.req.param('id')
    const changed = await deps.sql(c.env).run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, c.get('user').id)
    if (!changed) return fail(c, 404, 'not_found', 'That session has already ended.')
    if (id === c.get('sessionId')) clearCookie(c)
    return c.body(null, 204)
  })
}
