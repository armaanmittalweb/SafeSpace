/**
 * The SafeSpace vault API (safespace-api.amittal.dev). It stores accounts, sealed records and the
 * two wrapped copies of each user's data key, and can decrypt none of it. See README.md and
 * docs/rebuild/contract.md for the routes and the key design.
 *
 * CSRF: every state-changing /api request needs Content-Type: application/json (which forces a
 * CORS preflight) and an Origin from ALLOWED_ORIGINS; otherwise 403. The session cookie is
 * SameSite=Lax as well.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { authRoutes } from './auth'
import { allowedOrigins, clientIp, currentSession, fail, hitLimiter, TOMBSTONE_DAYS, type AppEnv, type Deps } from './http'
import { sameString } from './keys'
import { recordRoutes } from './records'
import type { Sql } from './sql'

export type { Bindings, Deps } from './http'

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

export function createApp(deps: Deps) {
  const now = deps.now ?? Date.now
  const app = new Hono<AppEnv>()

  app.use('/api/*', async (c, next) => {
    const allowed = allowedOrigins(c.env)
    return cors({
      origin: origin => (allowed.includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 86400,
    })(c, next)
  })

  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
  })

  // CSRF: a JSON content type and an allowed Origin on anything that changes state.
  app.use('/api/*', async (c, next) => {
    if (SAFE.has(c.req.method)) return next()
    const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (type !== 'application/json' || !allowedOrigins(c.env).includes(c.req.header('origin') ?? '')) {
      return fail(c, 403, 'forbidden', 'This request must come from the SafeSpace app.')
    }
    return next()
  })

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || c.req.path === '/api/test') return next()
    if (!(await hitLimiter(c.env.API_LIMITER, clientIp(c)))) return fail(c, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.')
    return next()
  })

  const requireUser = createMiddleware<AppEnv>(async (c, next) => {
    const s = await currentSession(c, deps.sql(c.env), now())
    if (!s) return fail(c, 401, 'unauthenticated', 'Sign in to continue.')
    c.set('user', s.user)
    c.set('sessionId', s.sessionId)
    await next()
  })

  app.get('/api/test', c => c.json({ ok: true, service: 'safespace-api' }))

  authRoutes(app, deps, requireUser)
  recordRoutes(app, deps, requireUser)

  // Private routes for the Switchboard's admin dashboard, reached through a service binding.
  app.use('/internal/*', async (c, next) => {
    const key = c.env.INTERNAL_KEY
    if (!key || !sameString(c.req.header('x-internal-key') ?? '', key)) return fail(c, 404, 'not_found', 'Not found.')
    return next()
  })

  app.get('/internal/stats', async c => {
    const sql = deps.sql(c.env)
    const [row] = await sql.all<{ users: number; records: number; sessions: number }>(
      `SELECT (SELECT COUNT(*) FROM users) AS users,
              (SELECT COUNT(*) FROM records WHERE deleted = 0) AS records,
              (SELECT COUNT(*) FROM sessions WHERE expires_at > ?) AS sessions`, now())
    return c.json({ users: Number(row?.users ?? 0), records: Number(row?.records ?? 0), dbBytes: await sql.size(), sessions: Number(row?.sessions ?? 0) })
  })

  app.post('/internal/prune', async c => c.json(await prune(deps.sql(c.env), now())))

  app.notFound(c => fail(c, 404, 'not_found', 'Not found.'))
  app.onError((err, c) => {
    console.error(err)
    return fail(c, 500, 'server', 'The vault hit an error. Try again in a moment.')
  })

  return app
}

/**
 * The daily upkeep: expired sessions, tombstones older than 90 days (remembering the highest pruned
 * seq per user, so a device whose cursor is older than that starts over) and old rate counters.
 */
export async function prune(sql: Sql, now: number) {
  const cutoff = now - TOMBSTONE_DAYS * 86_400_000
  const sessions = await sql.run('DELETE FROM sessions WHERE expires_at <= ?', now)
  await sql.run(
    `UPDATE users SET pruned_seq = MAX(pruned_seq, (SELECT MAX(seq) FROM records r WHERE r.user_id = users.id AND r.deleted = 1 AND r.updated_at < ?))
      WHERE id IN (SELECT user_id FROM records WHERE deleted = 1 AND updated_at < ?)`, cutoff, cutoff)
  const tombstones = await sql.run('DELETE FROM records WHERE deleted = 1 AND updated_at < ?', cutoff)
  const counters = await sql.run('DELETE FROM counters WHERE hour < ?', now - 2 * 3_600_000)
  return { sessions, tombstones, counters }
}
