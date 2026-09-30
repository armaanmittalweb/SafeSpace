import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createApp, type Bindings } from '../src/app'
import type { Sql } from '../src/sql'

/** node:sqlite behind the same interface as D1, loaded with the real schema. */
export function sqliteSql(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON') // D1 enforces foreign keys
  db.exec(readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url).href), 'utf8'))
  const args = (p: unknown[]) => p.map(v => (v === undefined ? null : v)) as (string | number | null)[]
  return {
    db,
    async all<T>(query: string, ...params: unknown[]) {
      return db.prepare(query).all(...args(params)) as T[]
    },
    async run(query, ...params) {
      return Number(db.prepare(query).run(...args(params)).changes)
    },
    async batch(statements) {
      db.exec('BEGIN')
      try {
        const out = statements.map(([q, ...p]) => db.prepare(q).all(...args(p)) as Record<string, unknown>[])
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    async size() {
      return 4096
    },
  }
}

export const ORIGIN = 'https://safespace.amittal.dev'
export const T0 = Date.UTC(2026, 8, 30, 12, 0, 0)

export const rand = (n: number) => Buffer.from(randomBytes(n)).toString('base64url' as BufferEncoding)
export const wrapped = () => ({ iv: rand(12), ct: rand(48) })

type CallOpts = { body?: unknown; cookie?: string; origin?: string | null; type?: string | null; headers?: Record<string, string> }

/** A fresh vault on node:sqlite with a controllable clock and fetch. */
export function setup(extra: Partial<Bindings> = {}, fetcher?: typeof fetch) {
  const sql = sqliteSql(), clock = { t: T0 }
  const app = createApp({ sql: () => sql, now: () => clock.t, fetch: fetcher })
  const env = { DB: {} as D1Database, PARAMS_SECRET: 'params-secret', INTERNAL_KEY: 'internal-key', ...extra } as Bindings

  async function call(method: string, path: string, opts: CallOpts = {}) {
    const headers: Record<string, string> = { ...opts.headers }
    const origin = opts.origin === undefined ? ORIGIN : opts.origin
    if (origin) headers.origin = origin
    if (opts.cookie) headers.cookie = opts.cookie
    let body: string | undefined
    if (method !== 'GET' && method !== 'OPTIONS') {
      const type = opts.type === undefined ? 'application/json' : opts.type
      if (type) headers['content-type'] = type
      body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {})
    }
    const res = await app.request('https://safespace-api.amittal.dev' + path, { method, headers, body }, env)
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    const setCookie = res.headers.get('set-cookie') ?? ''
    const cookie = /ss_session=([^;]*)/.exec(setCookie)?.[1]
    return { status: res.status, json, text, headers: res.headers, setCookie, cookie: cookie ? `ss_session=${cookie}` : undefined }
  }

  /** Signs up with random keys; returns the keys and the session cookie. */
  async function signup(email = 'ana@example.com') {
    const keys = { email, salt: rand(16), authKey: rand(32), wrappedByPassword: wrapped(), recoveryAuth: rand(32), wrappedByRecovery: wrapped() }
    const res = await call('POST', '/api/auth/signup', { body: keys })
    if (res.status !== 201) throw new Error('signup failed ' + JSON.stringify(res.json))
    return { ...keys, cookie: res.cookie!, id: res.json.user.id as string }
  }

  return { sql, clock, app, env, call, signup }
}
