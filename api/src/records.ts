/**
 * Sealed records, export, account deletion and narration. Records are opaque to the server: it
 * checks shapes and sizes, versions every write and orders changes with a per-user `seq`, which is
 * the pull cursor.
 *
 * Writes are optimistic: PUT names the version the device last saw (0 = new) and only matches a row
 * at that version, so two devices cannot both win; the loser gets 409 with the current record.
 */
import type { MiddlewareHandler } from 'hono'
import {
  clearCookie, clientIp, countHour, fail, hitLimiter, iso, isKey, MAX_BODY_BYTES, MAX_RECORD_BYTES, MAX_RECORDS,
  MAX_USER_BYTES, NARRATIONS_PER_HOUR, readJson, type App, type AppEnv, type Ctx, type Deps,
} from './http'
import { isB64url, verifyKey } from './keys'
import { cleanFacts, narrate, providers } from './narrate'

export const RECORD_KINDS = ['checkin', 'session', 'baseline', 'personal-model', 'import', 'settings'] as const
export const PAGE_SIZE = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface RecordRow { id: string; kind: string; iv: string; ct: string; version: number; seq: number; deleted: number; updated_at: number }

export const sealedOf = (r: RecordRow) => ({
  id: r.id, kind: r.kind, iv: r.iv, ct: r.ct, version: Number(r.version), updatedAt: iso(r.updated_at), deleted: Boolean(Number(r.deleted)),
})

const COLS = 'id, kind, iv, ct, version, seq, deleted, updated_at'

export function recordRoutes(app: App, deps: Deps, requireUser: MiddlewareHandler<AppEnv>) {
  const now = deps.now ?? Date.now

  async function current(c: Ctx, id: string) {
    const [row] = await deps.sql(c.env).all<RecordRow>(`SELECT ${COLS} FROM records WHERE user_id = ? AND id = ?`, c.get('user').id, id)
    return row ? sealedOf(row) : null
  }
  const conflict = async (c: Ctx, id: string) =>
    fail(c, 409, 'conflict', 'Another device changed this record first.', { current: await current(c, id) })

  app.use('/api/records/*', requireUser)
  app.use('/api/records', requireUser)

  app.get('/api/records', async c => {
    const raw = c.req.query('since') ?? '0'
    if (!/^\d{1,15}$/.test(raw)) return fail(c, 400, 'bad_request', 'since must be a cursor from an earlier pull.')
    const sql = deps.sql(c.env), userId = c.get('user').id
    const [u] = await sql.all<{ seq: number; pruned_seq: number }>('SELECT seq, pruned_seq FROM users WHERE id = ?', userId)
    if (!u) return fail(c, 401, 'unauthenticated', 'Sign in again.')
    let since = Number(raw)
    // Tombstones this device never saw have been pruned: start over from a full listing.
    const reset = since > 0 && since < Number(u.pruned_seq)
    if (reset) since = 0
    const rows = await sql.all<RecordRow>(
      `SELECT ${COLS} FROM records WHERE user_id = ? AND seq > ? AND seq <= ? ${since === 0 ? 'AND deleted = 0' : ''} ORDER BY seq LIMIT ?`,
      userId, since, Number(u.seq), PAGE_SIZE + 1)
    const more = rows.length > PAGE_SIZE
    const page = rows.slice(0, PAGE_SIZE)
    const cursor = more ? Number(page[page.length - 1].seq) : Number(u.seq)
    return c.json({ records: page.map(sealedOf), cursor: String(cursor), more, ...(reset ? { reset: true } : {}) })
  })

  app.put('/api/records/:id', async c => {
    const id = c.req.param('id')
    if (!UUID.test(id)) return fail(c, 400, 'bad_request', 'A record id is a lowercase UUID.')
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return fail(c, 413, 'too_large', 'A record can be at most 64 KB.')
    const b = await readJson(c)
    if (!b) return fail(c, 413, 'too_large', 'A record can be at most 64 KB, sent as a JSON object.')
    const { kind, iv, ct, baseVersion } = b
    if (typeof kind !== 'string' || !(RECORD_KINDS as readonly string[]).includes(kind) || !isB64url(iv, 12) || !isB64url(ct) || ct.length < 22 ||
      typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0) {
      return fail(c, 400, 'bad_request', 'Expected {kind, iv, ct, baseVersion} with base64url iv (12 bytes) and ct.')
    }
    const bytes = iv.length + ct.length
    if (bytes > MAX_RECORD_BYTES) return fail(c, 413, 'too_large', 'A record can be at most 64 KB.')

    const sql = deps.sql(c.env), userId = c.get('user').id, t = now()
    const [use] = await sql.all<{ n: number; b: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM records WHERE user_id = ? AND deleted = 0 AND id != ?', userId, id)
    if (Number(use?.n ?? 0) >= MAX_RECORDS) return fail(c, 507, 'too_large', 'You have reached 5,000 records. Delete some to save more.', { limit: 'records' })
    if (Number(use?.b ?? 0) + bytes > MAX_USER_BYTES) return fail(c, 507, 'too_large', 'You have reached 5 MB of saved data. Delete some to save more.', { limit: 'bytes' })

    const bump: [string, ...unknown[]] = ['UPDATE users SET seq = seq + 1 WHERE id = ?', userId]
    const write: [string, ...unknown[]] = baseVersion === 0
      ? [`INSERT INTO records (user_id, id, kind, iv, ct, bytes, version, seq, deleted, updated_at)
           SELECT id, ?, ?, ?, ?, ?, 1, seq, 0, ? FROM users WHERE id = ?
           ON CONFLICT (user_id, id) DO NOTHING RETURNING version`, id, kind, iv, ct, bytes, t, userId]
      : [`UPDATE records SET kind = ?, iv = ?, ct = ?, bytes = ?, version = version + 1, deleted = 0, updated_at = ?,
             seq = (SELECT seq FROM users WHERE id = ?)
           WHERE user_id = ? AND id = ? AND version = ? RETURNING version`, kind, iv, ct, bytes, t, userId, userId, id, baseVersion]
    const [, rows] = await sql.batch([bump, write])
    if (!rows?.[0]) return conflict(c, id)
    return c.json({ version: Number(rows[0].version) })
  })

  app.delete('/api/records/:id', async c => {
    const id = c.req.param('id')
    if (!UUID.test(id)) return fail(c, 400, 'bad_request', 'A record id is a lowercase UUID.')
    const rawBase = c.req.query('baseVersion')
    if (rawBase !== undefined && !/^\d{1,9}$/.test(rawBase)) return fail(c, 400, 'bad_request', 'baseVersion must be a whole number.')
    const sql = deps.sql(c.env), userId = c.get('user').id
    const [, rows] = await sql.batch([
      ['UPDATE users SET seq = seq + 1 WHERE id = ?', userId],
      [`UPDATE records SET iv = '', ct = '', bytes = 0, deleted = 1, version = version + 1, updated_at = ?,
            seq = (SELECT seq FROM users WHERE id = ?)
          WHERE user_id = ? AND id = ? AND deleted = 0 ${rawBase !== undefined ? 'AND version = ?' : ''} RETURNING version`,
        now(), userId, userId, id, ...(rawBase !== undefined ? [Number(rawBase)] : [])],
    ])
    if (!rows?.[0] && rawBase !== undefined) {
      const cur = await current(c, id)
      // Already gone (or never here): deleting is idempotent. Changed since the device saw it: 409.
      if (cur && !cur.deleted) return conflict(c, id)
    }
    return c.body(null, 204)
  })

  app.get('/api/export', requireUser, async c => {
    const sql = deps.sql(c.env), user = c.get('user')
    const [u] = await sql.all<{ salt: string; wrapped_password: string; wrapped_recovery: string }>(
      'SELECT salt, wrapped_password, wrapped_recovery FROM users WHERE id = ?', user.id)
    if (!u) return fail(c, 401, 'unauthenticated', 'Sign in again.')
    const rows = await sql.all<RecordRow>(`SELECT ${COLS} FROM records WHERE user_id = ? AND deleted = 0 ORDER BY seq`, user.id)
    c.header('Content-Disposition', 'attachment; filename="safespace-export.json"')
    return c.json({
      format: 'safespace-vault-export', version: 1, exportedAt: iso(now()), user,
      salt: u.salt, iterations: 310_000,
      wrappedByPassword: JSON.parse(u.wrapped_password), wrappedByRecovery: JSON.parse(u.wrapped_recovery),
      records: rows.map(sealedOf),
    })
  })

  app.delete('/api/account', requireUser, async c => {
    if (!(await hitLimiter(c.env.LOGIN_LIMITER, clientIp(c)))) return fail(c, 429, 'rate_limited', 'Too many tries. Wait a minute and try again.')
    const b = await readJson(c)
    if (!isKey(b?.authKey)) return fail(c, 400, 'bad_request', 'Expected {authKey}.')
    const sql = deps.sql(c.env), userId = c.get('user').id
    const [u] = await sql.all<{ auth_hash: string }>('SELECT auth_hash FROM users WHERE id = ?', userId)
    if (!u || !(await verifyKey(b.authKey, u.auth_hash))) return fail(c, 403, 'forbidden', 'That password is not right.')
    await sql.batch([
      ['DELETE FROM records WHERE user_id = ?', userId],
      ['DELETE FROM sessions WHERE user_id = ?', userId],
      ['DELETE FROM users WHERE id = ?', userId],
    ])
    clearCookie(c)
    return c.body(null, 204)
  })

  app.post('/api/narrate', requireUser, async c => {
    const b = await readJson(c)
    const facts = cleanFacts(b?.facts)
    if (!facts) return fail(c, 400, 'bad_request', 'Expected {facts: NarrationFacts}.')
    if (!providers(c.env).length) return fail(c, 503, 'unavailable', 'Written notes are not available right now.')
    if (!(await countHour(deps.sql(c.env), 'narrate:' + c.get('user').id, now(), NARRATIONS_PER_HOUR))) {
      return fail(c, 429, 'rate_limited', 'That is 10 written notes this hour. The next check-in will use the built-in note.')
    }
    const out = await narrate(facts, c.env, deps.fetch ?? ((input, init) => fetch(input, init)))
    if (!out) return fail(c, 503, 'unavailable', 'Written notes are not available right now.')
    return c.json(out)
  })
}
