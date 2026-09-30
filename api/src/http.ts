/**
 * Shared pieces of the vault's HTTP layer: bindings, the error shape, body parsing, validation and
 * cookie sessions.
 */
import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { isB64url, newToken, sha256hex } from './keys'
import type { NarrateKeys } from './narrate'
import type { Sql } from './sql'

/** The Workers rate limiting binding (declared in wrangler.jsonc). */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Bindings extends NarrateKeys {
  DB: D1Database
  /** HMAC key for the salts and recovery blobs given for unknown emails. Required. */
  PARAMS_SECRET?: string
  /** Shared with the Switchboard; unlocks /internal/*. Unset = those routes 404. */
  INTERNAL_KEY?: string
  /** Comma-separated exact origins allowed to call /api with credentials. */
  ALLOWED_ORIGINS?: string
  LOGIN_LIMITER?: Limiter
  API_LIMITER?: Limiter
}

export interface Deps {
  sql(env: Bindings): Sql
  now?: () => number
  fetch?: typeof fetch
}

export interface User { id: string; email: string; createdAt: string }
export type AppEnv = { Bindings: Bindings; Variables: { user: User; sessionId: string } }
export type Ctx = Context<AppEnv>
export type App = Hono<AppEnv>

export const DEFAULT_ORIGINS = 'https://safespace.amittal.dev,http://localhost:5175'
export const COOKIE = 'ss_session'
export const SESSION_MS = 30 * 86_400_000
/** last_seen_at (and the cookie's Max-Age) move forward at most this often, to save D1 writes. */
export const SLIDE_MS = 3_600_000
export const CLIENT_ITERATIONS = 310_000
export const MAX_BODY_BYTES = 72 * 1024
export const MAX_RECORD_BYTES = 64 * 1024
export const MAX_RECORDS = 5000
export const MAX_USER_BYTES = 5 * 1024 * 1024
export const TOMBSTONE_DAYS = 90
export const SIGNUPS_PER_HOUR = 20
export const NARRATIONS_PER_HOUR = 10

export type ErrorCode = 'bad_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'too_large' | 'unavailable' | 'server'

export const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503 | 507, code: ErrorCode, error: string, extra: object = {}) =>
  c.json({ error, code, ...extra }, status)

export const allowedOrigins = (env: Bindings) => (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map(o => o.trim()).filter(Boolean)
export const clientIp = (c: Ctx) => c.req.header('cf-connecting-ip') ?? 'unknown'

/** The JSON body as an object, or null when it is missing, too large or not an object. */
export async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  const text = await c.req.text()
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function normEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const e = v.trim().toLowerCase()
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

export interface Wrapped { iv: string; ct: string }
/** A wrapped data key: a 12-byte iv and 48 bytes of ct (32 key bytes + 16 tag bytes). */
export function wrappedOf(v: unknown): Wrapped | null {
  const w = v as { iv?: unknown; ct?: unknown } | null
  return w && typeof w === 'object' && isB64url(w.iv, 12) && isB64url(w.ct, 48) ? { iv: w.iv, ct: w.ct } : null
}
export const isKey = (v: unknown): v is string => isB64url(v, 32)
export const isSalt = (v: unknown): v is string => isB64url(v, 16)

export const iso = (ms: number) => new Date(Number(ms)).toISOString()

export async function hitLimiter(limiter: Limiter | undefined, key: string) {
  return !limiter || (await limiter.limit({ key })).success
}

/** Counts one event in the current hour for `key`; false once the count passes `limit`. */
export async function countHour(sql: Sql, key: string, now: number, limit: number) {
  const hour = Math.floor(now / 3_600_000) * 3_600_000
  const [row] = await sql.all<{ n: number }>(
    'INSERT INTO counters (key, hour, n) VALUES (?, ?, 1) ON CONFLICT (key, hour) DO UPDATE SET n = n + 1 RETURNING n', key, hour)
  return Number(row?.n ?? 0) <= limit
}

const cookieOpts = (c: Ctx) => ({
  httpOnly: true,
  // Production is HTTPS only. `wrangler dev` on http://localhost drops Secure, as EduSched does.
  secure: new URL(c.req.url).protocol === 'https:',
  sameSite: 'Lax' as const,
  path: '/',
})

function sendCookie(c: Ctx, token: string) {
  setCookie(c, COOKIE, token, { ...cookieOpts(c), maxAge: SESSION_MS / 1000 })
}

export function clearCookie(c: Ctx) {
  deleteCookie(c, COOKIE, cookieOpts(c))
}

/** Starts a session for the user: a new token in the cookie, its SHA-256 in D1. Returns the session id. */
export async function startSession(c: Ctx, sql: Sql, userId: string, now: number) {
  const token = newToken(), id = await sha256hex(token)
  const ua = (c.req.header('user-agent') ?? '').slice(0, 300) || null
  await sql.run('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)', id, userId, now, now, now + SESSION_MS, ua)
  sendCookie(c, token)
  return id
}

/** The signed-in user for this request, sliding the session forward; null when there is none. */
export async function currentSession(c: Ctx, sql: Sql, now: number): Promise<{ user: User; sessionId: string } | null> {
  const token = getCookie(c, COOKIE)
  if (!token || token.length > 100) return null
  const id = await sha256hex(token)
  const [row] = await sql.all<{ user_id: string; last_seen_at: number; email: string; created_at: number }>(
    `SELECT s.user_id, s.last_seen_at, u.email, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`, id, now)
  if (!row) return null
  if (now - Number(row.last_seen_at) > SLIDE_MS) {
    await sql.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, now + SESSION_MS, id)
    sendCookie(c, token)
  }
  return { user: { id: row.user_id, email: row.email, createdAt: iso(row.created_at) }, sessionId: id }
}
