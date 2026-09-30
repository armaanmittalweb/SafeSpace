/**
 * The server's own small crypto: base64url, hashes of the keys the browser sends, session tokens and
 * the stand-in answers that keep unknown emails indistinguishable from real ones.
 *
 * authKey and recoveryAuth are 256-bit HKDF outputs (the browser already spent 310k PBKDF2 rounds
 * on the password), so the server-side PBKDF2 only has to make a stolen table useless for replay,
 * not slow down guessing. 20k rounds keeps two hashes inside the Workers free plan's ~10 ms CPU
 * budget (the same choice as EduSched and the Switchboard). The count is stored in each hash.
 *
 * Hash format: pbkdf2_sha256$<iterations>$<salt b64url>$<hash b64url>
 */
const enc = new TextEncoder()
export const SERVER_HASH_ITERATIONS = 20_000
const MAX_ITERATIONS = 100_000 // Workers rejects more than this

export const b64url = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))

/** base64url of exactly `bytes` bytes (no padding). */
export function isB64url(s: unknown, bytes?: number): s is string {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return false
  return bytes === undefined || s.length === Math.ceil((bytes * 4) / 3)
}

/** Compares without an early exit, so response time says nothing about how much matched. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export const sameString = (a: string, b: string) => sameBytes(enc.encode(a), enc.encode(b))

async function pbkdf2(secret: string, salt: Uint8Array, iterations: number, bytes: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, bytes * 8))
}

export async function hashKey(key: string, iterations = SERVER_HASH_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2_sha256$${iterations}$${b64url(salt)}$${b64url(await pbkdf2(key, salt, iterations, 32))}`
}

/** A hash no key matches, for spending the same time on unknown emails as on known ones. */
export const DUMMY_HASH = `pbkdf2_sha256$${SERVER_HASH_ITERATIONS}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`

export async function verifyKey(key: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$')
  const iterations = Number(iter)
  if (scheme !== 'pbkdf2_sha256' || !salt || !hash || !Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return false
  const expected = unb64url(hash)
  return sameBytes(await pbkdf2(key, unb64url(salt), iterations, expected.length), expected)
}

export async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
}

export async function sha256hex(data: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(data)))
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('')
}

/** A new session token (32 random bytes) for the cookie. */
export const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)))

/** The salt /api/auth/params gives for an email with no account: stable, and shaped like a real one. */
export async function fakeSalt(secret: string, email: string) {
  return b64url((await hmac(secret, 'params|' + email)).slice(0, 16))
}

/**
 * The wrappedByRecovery /recover/start gives for an email with no account: stable across calls
 * (a fresh random blob each time would give the game away) and the same size as a real one
 * (a 12-byte iv; 32 key bytes + 16 tag bytes of ct).
 */
export async function fakeWrapped(secret: string, email: string) {
  const a = await hmac(secret, 'recover-iv|' + email), b = await hmac(secret, 'recover-ct|' + email)
  const ct = new Uint8Array(48)
  ct.set(b, 0)
  ct.set(a.slice(12, 28), 32)
  return { iv: b64url(a.slice(0, 12)), ct: b64url(ct) }
}
