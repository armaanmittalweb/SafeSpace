/**
 * SafeSpace end-to-end encryption, in the browser (and Node 20+), with WebCrypto only.
 * Implements "Keys" in docs/rebuild/contract.md. The server never receives the password, wrapKey,
 * dataKey, the recovery key or any plaintext.
 *
 *   master      = PBKDF2-SHA256(password, salt, 310 000, 256 bits)
 *   authKey     = HKDF-SHA256(master, salt = empty, info "safespace auth")   → sent (base64url)
 *   wrapKey     = HKDF-SHA256(master, salt = empty, info "safespace wrap")   → AES-GCM 256, stays here
 *   dataKey     = random AES-GCM 256, made at sign-up; wrapped by wrapKey and by recoveryWrap
 *   recoveryKey = 20 random bytes, shown once as 8 groups of 4 Crockford base32 characters
 *   record      = AES-GCM(dataKey, iv 12 random bytes, JSON, additionalData `${id}|${kind}`)
 *
 * Exported surface:
 *   b64url(bytes) / fromB64url(text)                     base64url without padding
 *   newSalt(): string                                    16 random bytes, base64url
 *   derivePasswordKeys(password, salt, iterations?)      → { authKey, wrapKey }
 *   newRecoveryKey(): string                             "7K2M-…" (8 groups of 4)
 *   parseRecoveryKey(text): Uint8Array | null            forgiving: case, spaces, I/L→1, O→0
 *   deriveRecoveryKeys(recoveryKey)                      → { recoveryAuth, recoveryWrap }
 *   newDataKey(): Promise<CryptoKey>                     extractable, only so it can be wrapped
 *   wrapDataKey(dataKey, wrapKey): Promise<Sealed>
 *   unwrapDataKey(sealed, wrapKey, extractable = false): Promise<CryptoKey>
 *   sealRecord(dataKey, id, kind, value): Promise<Sealed>
 *   openRecord<T>(dataKey, id, kind, sealed): Promise<T>  throws if the key, id or kind is wrong
 */

export const PBKDF2_ITERATIONS = 310_000;
export interface Sealed { iv: string; ct: string }

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const random = (n: number): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(n));

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const newSalt = (): string => b64url(random(16));

async function hkdfBase(material: Bytes) {
  return subtle().importKey('raw', material, 'HKDF', false, ['deriveBits', 'deriveKey']);
}
const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) });

async function authAndWrap(material: Bytes, authInfo: string, wrapInfo: string) {
  const base = await hkdfBase(material);
  const auth = new Uint8Array(await subtle().deriveBits(hkdf(authInfo), base, 256));
  const wrap = await subtle().deriveKey(hkdf(wrapInfo), base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  return { auth: b64url(auth), wrap };
}

/** The two keys a password gives. About a third of a second in a browser: call it once per sign-in. */
export async function derivePasswordKeys(password: string, salt: string, iterations = PBKDF2_ITERATIONS): Promise<{ authKey: string; wrapKey: CryptoKey }> {
  const pw = await subtle().importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const master = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations }, pw, 256));
  const { auth, wrap } = await authAndWrap(master, 'safespace auth', 'safespace wrap');
  master.fill(0);
  return { authKey: auth, wrapKey: wrap };
}

// Crockford base32: no I, L, O or U, so it reads aloud and copies by hand without mix-ups.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_BYTES = 20;

function toBase32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** A new recovery key, formatted for display: 8 groups of 4 characters joined by dashes. */
export function newRecoveryKey(): string {
  return toBase32(random(RECOVERY_BYTES)).match(/.{4}/g)!.join('-');
}

/** The 20 bytes of a typed or pasted recovery key, or null if it is not one. */
export function parseRecoveryKey(text: string): Bytes | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (clean.length !== 32) return null;
  const out = new Uint8Array(RECOVERY_BYTES);
  let bits = 0, value = 0, i = 0;
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

/** The two keys a recovery key gives. Throws if the text is not a recovery key. */
export async function deriveRecoveryKeys(recoveryKey: string): Promise<{ recoveryAuth: string; recoveryWrap: CryptoKey }> {
  const raw = parseRecoveryKey(recoveryKey);
  if (!raw) throw new Error('That is not a recovery key. It has 32 letters and digits in groups of four.');
  const { auth, wrap } = await authAndWrap(raw, 'safespace recovery auth', 'safespace recovery wrap');
  raw.fill(0);
  return { recoveryAuth: auth, recoveryWrap: wrap };
}

const AES = { name: 'AES-GCM', length: 256 } as const;

/** A new data key. Extractable only so it can be wrapped at sign-up; keep the unwrapped copy instead. */
export function newDataKey(): Promise<CryptoKey> {
  return subtle().generateKey(AES, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

export async function wrapDataKey(dataKey: CryptoKey, wrapKey: CryptoKey): Promise<Sealed> {
  const iv = random(12);
  const ct = new Uint8Array(await subtle().wrapKey('raw', dataKey, wrapKey, { name: 'AES-GCM', iv }));
  return { iv: b64url(iv), ct: b64url(ct) };
}

/** Unwraps a data key; non-extractable unless `extractable` (only needed to wrap it again). Throws on a wrong key. */
export function unwrapDataKey(sealed: Sealed, wrapKey: CryptoKey, extractable = false): Promise<CryptoKey> {
  return subtle().unwrapKey('raw', fromB64url(sealed.ct), wrapKey, { name: 'AES-GCM', iv: fromB64url(sealed.iv) }, AES, extractable, ['encrypt', 'decrypt']);
}

const aad = (id: string, kind: string) => enc.encode(`${id}|${kind}`);

export async function sealRecord(dataKey: CryptoKey, id: string, kind: string, value: unknown): Promise<Sealed> {
  const iv = random(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(id, kind) }, dataKey, enc.encode(JSON.stringify(value))));
  return { iv: b64url(iv), ct: b64url(ct) };
}

export async function openRecord<T = unknown>(dataKey: CryptoKey, id: string, kind: string, sealed: Sealed): Promise<T> {
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64url(sealed.iv), additionalData: aad(id, kind) }, dataKey, fromB64url(sealed.ct));
  return JSON.parse(dec.decode(pt)) as T;
}
