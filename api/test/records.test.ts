import { describe, expect, it } from 'vitest'
import { prune } from '../src/app'
import { MAX_RECORDS, MAX_USER_BYTES } from '../src/http'
import { PAGE_SIZE } from '../src/records'
import { rand, setup } from './helpers'

const DAY = 86_400_000
const uuid = () => crypto.randomUUID()
const sealed = (ctBytes = 64) => ({ iv: rand(12), ct: rand(ctBytes) })

async function user() {
  const s = setup()
  const u = await s.signup()
  const put = (id: string, baseVersion: number, extra: object = {}) =>
    s.call('PUT', `/api/records/${id}`, { cookie: u.cookie, body: { kind: 'checkin', ...sealed(), baseVersion, ...extra } })
  const pull = (since?: string) => s.call('GET', `/api/records${since ? `?since=${since}` : ''}`, { cookie: u.cookie })
  const del = (id: string, baseVersion?: number) => s.call('DELETE', `/api/records/${id}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`, { cookie: u.cookie })
  return { s, u, put, pull, del }
}

describe('records', () => {
  it('needs a session', async () => {
    const { s } = await user()
    expect((await s.call('GET', '/api/records')).status).toBe(401)
    expect((await s.call('PUT', `/api/records/${uuid()}`, { body: { kind: 'checkin', ...sealed(), baseVersion: 0 } })).status).toBe(401)
  })

  it('creates, updates with the right baseVersion, and returns 409 with the current record when stale', async () => {
    const { put, pull } = await user()
    const id = uuid()
    const created = await put(id, 0)
    expect(created.status).toBe(200)
    expect(created.json).toEqual({ version: 1 })
    expect((await put(id, 1)).json).toEqual({ version: 2 })

    const stale = await put(id, 1)
    expect(stale.status).toBe(409)
    expect(stale.json.code).toBe('conflict')
    expect(stale.json.current).toMatchObject({ id, kind: 'checkin', version: 2, deleted: false, updatedAt: expect.any(String) })
    const again = await put(id, 0)
    expect(again.status).toBe(409)

    const all = await pull()
    expect(all.json.records).toHaveLength(1)
    expect(all.json.records[0]).toEqual(stale.json.current)
    expect(Object.keys(all.json.records[0]).sort()).toEqual(['ct', 'deleted', 'id', 'iv', 'kind', 'updatedAt', 'version'])
  })

  it('409 with current null when the record is not on the server', async () => {
    const { put } = await user()
    const res = await put(uuid(), 3)
    expect(res.status).toBe(409)
    expect(res.json.current).toBeNull()
  })

  it('validates ids, kinds and base64url', async () => {
    const { put, s, u } = await user()
    expect((await put('not-a-uuid', 0)).status).toBe(400)
    expect((await put(uuid().toUpperCase(), 0)).status).toBe(400)
    expect((await put(uuid(), 0, { kind: 'diary' })).status).toBe(400)
    expect((await put(uuid(), 0, { iv: 'short' })).status).toBe(400)
    expect((await put(uuid(), 0, { ct: 'has spaces!' })).status).toBe(400)
    expect((await put(uuid(), -1)).status).toBe(400)
    for (const kind of ['checkin', 'session', 'baseline', 'personal-model', 'import', 'settings']) expect((await put(uuid(), 0, { kind })).status).toBe(200)
    expect((await s.call('PUT', `/api/records/${uuid()}`, { cookie: u.cookie, body: 'not json' })).status).toBe(413)
  })

  it('pulls changes after a cursor, including tombstones, and a fresh pull leaves tombstones out', async () => {
    const { put, pull, del } = await user()
    const a = uuid(), b = uuid(), c = uuid()
    await put(a, 0)
    await put(b, 0)
    const first = await pull()
    expect(first.json.records.map((r: { id: string }) => r.id)).toEqual([a, b])
    expect(first.json.more).toBe(false)
    const cursor = first.json.cursor
    expect(typeof cursor).toBe('string')

    expect((await pull(cursor)).json.records).toEqual([])
    await put(c, 0)
    await put(a, 1)
    expect((await del(b)).status).toBe(204)
    const next = await pull(cursor)
    expect(next.json.records.map((r: { id: string; deleted: boolean }) => [r.id, r.deleted])).toEqual([[c, false], [a, false], [b, true]])
    const tomb = next.json.records[2]
    expect(tomb).toMatchObject({ iv: '', ct: '', version: 2 })
    expect((await pull()).json.records.map((r: { id: string }) => r.id).sort()).toEqual([a, c].sort())
    expect((await pull(next.json.cursor)).json.records).toEqual([])
    expect((await pull('abc')).status).toBe(400)
  })

  it('pages large pulls', async () => {
    const { s, u, pull } = await user()
    const rows: [string, ...unknown[]][] = []
    for (let i = 1; i <= PAGE_SIZE + 3; i++) {
      rows.push(['INSERT INTO records (user_id, id, kind, iv, ct, bytes, version, seq, deleted, updated_at) VALUES (?, ?, ?, ?, ?, 10, 1, ?, 0, ?)', u.id, uuid(), 'checkin', rand(12), rand(20), i, s.clock.t])
    }
    rows.push(['UPDATE users SET seq = ? WHERE id = ?', PAGE_SIZE + 3, u.id])
    await s.sql.batch(rows)
    const p1 = await pull()
    expect(p1.json.records).toHaveLength(PAGE_SIZE)
    expect(p1.json.more).toBe(true)
    const p2 = await pull(p1.json.cursor)
    expect(p2.json.records).toHaveLength(3)
    expect(p2.json.more).toBe(false)
  })

  it('deletes idempotently, and refuses a stale baseVersion', async () => {
    const { put, del } = await user()
    const id = uuid()
    await put(id, 0)
    await put(id, 1)
    const stale = await del(id, 1)
    expect(stale.status).toBe(409)
    expect(stale.json.current.version).toBe(2)
    expect((await del(id, 2)).status).toBe(204)
    expect((await del(id, 2)).status).toBe(204)
    expect((await del(id)).status).toBe(204)
    expect((await del(uuid())).status).toBe(204)
    // A tombstone can be written over at its version (an edit that wins over the deletion).
    const back = await put(id, 3)
    expect(back.json).toEqual({ version: 4 })
  })

  it('keeps each user to their own records', async () => {
    const { s, put } = await user()
    const id = uuid()
    await put(id, 0)
    const v = await s.signup('vic@example.com')
    expect((await s.call('GET', '/api/records', { cookie: v.cookie })).json.records).toEqual([])
    const theirs = await s.call('PUT', `/api/records/${id}`, { cookie: v.cookie, body: { kind: 'checkin', ...sealed(), baseVersion: 0 } })
    expect(theirs.json).toEqual({ version: 1 }) // a separate record with the same id
    expect((await s.call('DELETE', `/api/records/${id}?baseVersion=1`, { cookie: v.cookie })).status).toBe(204)
    expect((await put(id, 1)).json).toEqual({ version: 2 })
  })
})

describe('limits', () => {
  it('64 KB per record → 413 too_large', async () => {
    const { put, s, u } = await user()
    const ok = await put(uuid(), 0, { ct: rand(48_000) }) // 64 000 base64url characters
    expect(ok.status).toBe(200)
    const big = await put(uuid(), 0, { ct: rand(49_200) })
    expect(big.status).toBe(413)
    expect(big.json.code).toBe('too_large')
    const huge = await s.call('PUT', `/api/records/${uuid()}`, { cookie: u.cookie, body: { kind: 'checkin', iv: rand(12), ct: rand(100_000), baseVersion: 0 } })
    expect(huge.status).toBe(413)
  })

  it('5,000 records per user → 507 too_large (limit: records); updates still work', async () => {
    const { s, u, put } = await user()
    const rows: [string, ...unknown[]][] = []
    const first = uuid()
    for (let i = 0; i < MAX_RECORDS; i++) {
      rows.push(['INSERT INTO records (user_id, id, kind, iv, ct, bytes, version, seq, deleted, updated_at) VALUES (?, ?, ?, ?, ?, 10, 1, 0, 0, 0)', u.id, i === 0 ? first : uuid(), 'checkin', rand(12), rand(20)])
    }
    await s.sql.batch(rows)
    const res = await put(uuid(), 0)
    expect(res.status).toBe(507)
    expect(res.json).toMatchObject({ code: 'too_large', limit: 'records' })
    expect((await put(first, 1)).status).toBe(200)
  })

  it('5 MB per user → 507 too_large (limit: bytes)', async () => {
    const { s, u, put } = await user()
    await s.sql.run('INSERT INTO records (user_id, id, kind, iv, ct, bytes, version, seq, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, 0)', u.id, uuid(), 'import', 'x', 'y', MAX_USER_BYTES - 50)
    const res = await put(uuid(), 0)
    expect(res.status).toBe(507)
    expect(res.json).toMatchObject({ code: 'too_large', limit: 'bytes' })
  })
})

describe('export and account deletion', () => {
  it('exports every live record with the wrapped keys as a download', async () => {
    const { s, u, put, del } = await user()
    const a = uuid(), b = uuid()
    await put(a, 0)
    await put(b, 0)
    await del(b)
    const res = await s.call('GET', '/api/export', { cookie: u.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.json).toMatchObject({ format: 'safespace-vault-export', salt: u.salt, iterations: 310_000, wrappedByPassword: u.wrappedByPassword, wrappedByRecovery: u.wrappedByRecovery })
    expect(res.json.records.map((r: { id: string }) => r.id)).toEqual([a])
  })

  it('deletes the account and everything in it after checking authKey', async () => {
    const { s, u, put } = await user()
    await put(uuid(), 0)
    const v = await s.signup('vic@example.com')
    expect((await s.call('DELETE', '/api/account', { cookie: u.cookie, body: { authKey: rand(32) } })).status).toBe(403)
    const res = await s.call('DELETE', '/api/account', { cookie: u.cookie, body: { authKey: u.authKey } })
    expect(res.status).toBe(204)
    for (const table of ['records', 'sessions']) {
      expect(s.sql.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(u.id)).toEqual({ n: 0 })
    }
    expect(s.sql.db.prepare('SELECT email FROM users').all()).toEqual([{ email: v.email }])
    expect((await s.call('GET', '/api/auth/me', { cookie: u.cookie })).status).toBe(401)
  })
})

describe('internal routes and pruning', () => {
  it('404 without the right x-internal-key', async () => {
    const { s } = await user()
    expect((await s.call('GET', '/internal/stats')).status).toBe(404)
    expect((await s.call('GET', '/internal/stats', { headers: { 'x-internal-key': 'nope' } })).status).toBe(404)
    expect((await s.call('POST', '/internal/prune', { headers: { 'x-internal-key': 'nope' } })).status).toBe(404)
    const none = setup({ INTERNAL_KEY: undefined })
    expect((await none.call('GET', '/internal/stats', { headers: { 'x-internal-key': '' } })).status).toBe(404)
  })

  it('reports stats', async () => {
    const { s, put } = await user()
    await put(uuid(), 0)
    const res = await s.call('GET', '/internal/stats', { headers: { 'x-internal-key': 'internal-key' } })
    expect(res.json).toEqual({ users: 1, records: 1, dbBytes: 4096, sessions: 1 })
  })

  it('prunes expired sessions and 90-day tombstones; an older cursor then gets a full reset', async () => {
    const { s, u, put, del, pull } = await user()
    const keep = uuid(), gone = uuid()
    await put(keep, 0)
    await put(gone, 0)
    const cursor = (await pull()).json.cursor
    await del(gone)
    s.clock.t += 91 * DAY // the first session has expired too
    const login = await s.call('POST', '/api/auth/login', { body: { email: u.email, authKey: u.authKey } })
    const res = await s.call('POST', '/internal/prune', { headers: { 'x-internal-key': 'internal-key' } })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ sessions: 1, tombstones: 1 })
    expect(s.sql.db.prepare('SELECT COUNT(*) AS n FROM records WHERE deleted = 1').get()).toEqual({ n: 0 })
    expect(s.sql.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 })

    const pullAs = (since: string) => s.call('GET', `/api/records?since=${since}`, { cookie: login.cookie })
    const stale = await pullAs(cursor)
    expect(stale.json.reset).toBe(true)
    expect(stale.json.records.map((r: { id: string }) => r.id)).toEqual([keep])
    const fresh = await pullAs(stale.json.cursor)
    expect(fresh.json.reset).toBeUndefined()
    expect(fresh.json.records).toEqual([])
  })

  it('the prune function drops expired sessions and old counters', async () => {
    const { s } = await user()
    s.clock.t += 31 * DAY
    const r = await prune(s.sql, s.clock.t)
    expect(r.sessions).toBe(1)
    expect(r.counters).toBe(1)
  })
})
