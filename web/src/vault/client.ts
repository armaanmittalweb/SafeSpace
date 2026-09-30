/**
 * Typed client for the vault API. Every call sends the session cookie (credentials: 'include') and,
 * for anything that changes state, Content-Type: application/json (the server's CSRF rule).
 * Base URL: import.meta.env.VITE_VAULT_URL, default https://safespace-api.amittal.dev.
 *
 * Exported surface:
 *   class VaultError { status; code: ErrorCode | 'offline'; body }   thrown for every non-2xx or network failure
 *   createVaultClient({ baseUrl?, fetch? }): VaultClient
 *   vault: VaultClient                                              the default instance
 *   VAULT_URL: string
 */
import type { Sealed } from './crypto';
import type {
  ErrorCode, Me, MeWithKey, NarrationFacts, PasswordBody, RecordKind, RecordsPage, RecoverBody, RecoveryKeyBody,
  SessionInfo, SignupBody, VaultExport,
} from './types';

export class VaultError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'offline',
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultClient {
  params(email: string): Promise<{ salt: string; iterations: number }>;
  signup(body: SignupBody): Promise<Me>;
  login(email: string, authKey: string): Promise<MeWithKey>;
  logout(): Promise<void>;
  /** The signed-in user, or null when signed out (401). */
  me(): Promise<MeWithKey | null>;
  recoverStart(email: string): Promise<{ wrappedByRecovery: Sealed }>;
  recover(body: RecoverBody): Promise<Me>;
  changePassword(body: PasswordBody): Promise<void>;
  setRecoveryKey(body: RecoveryKeyBody): Promise<void>;
  sessions(): Promise<SessionInfo[]>;
  revokeSession(id: string): Promise<void>;
  pull(since?: string): Promise<RecordsPage>;
  /** 409 throws VaultError with code 'conflict' and body.current: SealedRecord | null. */
  put(id: string, body: { kind: RecordKind; iv: string; ct: string; baseVersion: number }): Promise<{ version: number }>;
  /** With baseVersion, 409 if the record changed since; without, deletes whatever is there. */
  remove(id: string, baseVersion?: number): Promise<void>;
  exportAll(): Promise<VaultExport>;
  deleteAccount(authKey: string): Promise<void>;
  /** 503 'unavailable' when no writer is configured or all failed: use the templates. */
  narrate(facts: NarrationFacts): Promise<{ text: string; model: string }>;
}

const env = (import.meta as { env?: Record<string, string | undefined> }).env;
export const VAULT_URL = (env?.VITE_VAULT_URL || 'https://safespace-api.amittal.dev').replace(/\/$/, '');

export function createVaultClient(opts: { baseUrl?: string; fetch?: typeof fetch } = {}): VaultClient {
  const base = (opts.baseUrl ?? VAULT_URL).replace(/\/$/, '');
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'include', headers: {} };
    if (method !== 'GET') {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body ?? {});
    }
    let res: Response;
    try {
      res = await doFetch(base + path, init);
    } catch {
      throw new VaultError(0, 'offline', 'You are offline, or the vault cannot be reached.');
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = (typeof json.code === 'string' ? json.code : 'server') as ErrorCode;
      throw new VaultError(res.status, code, typeof json.error === 'string' ? json.error : `The vault answered ${res.status}.`, json);
    }
    return json as T;
  }

  const id = (s: string) => encodeURIComponent(s);
  return {
    params: email => call('GET', `/api/auth/params?email=${encodeURIComponent(email)}`),
    signup: body => call('POST', '/api/auth/signup', body),
    login: (email, authKey) => call('POST', '/api/auth/login', { email, authKey }),
    logout: () => call('POST', '/api/auth/logout'),
    async me() {
      try {
        return await call<MeWithKey>('GET', '/api/auth/me');
      } catch (e) {
        if (e instanceof VaultError && e.status === 401) return null;
        throw e;
      }
    },
    recoverStart: email => call('POST', '/api/auth/recover/start', { email }),
    recover: body => call('POST', '/api/auth/recover', body),
    changePassword: body => call('POST', '/api/auth/password', body),
    setRecoveryKey: body => call('POST', '/api/auth/recovery-key', body),
    sessions: () => call('GET', '/api/auth/sessions'),
    revokeSession: sid => call('DELETE', `/api/auth/sessions/${id(sid)}`),
    pull: since => call('GET', `/api/records${since ? `?since=${id(since)}` : ''}`),
    put: (rid, body) => call('PUT', `/api/records/${id(rid)}`, body),
    remove: (rid, baseVersion) => call('DELETE', `/api/records/${id(rid)}${baseVersion === undefined ? '' : `?baseVersion=${baseVersion}`}`),
    exportAll: () => call('GET', '/api/export'),
    deleteAccount: authKey => call('DELETE', '/api/account', { authKey }),
    narrate: facts => call('POST', '/api/narrate', { facts }),
  };
}

export const vault: VaultClient = createVaultClient();
