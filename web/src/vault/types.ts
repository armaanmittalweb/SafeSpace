/**
 * Wire types of the vault API (docs/rebuild/contract.md, "Vault API"). web/src/contract may re-export
 * these; they are structurally the same as the contract's.
 */
import type { Sealed } from './crypto';

export type RecordKind = 'checkin' | 'session' | 'baseline' | 'personal-model' | 'import' | 'settings';
export type ErrorCode = 'bad_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'too_large' | 'unavailable' | 'server';

export interface Me { user: { id: string; email: string; createdAt: string } }
export type MeWithKey = Me & { wrappedByPassword: Sealed };

export interface SealedRecord { id: string; kind: RecordKind; iv: string; ct: string; version: number; updatedAt: string; deleted: boolean }
/** A pull page. `more`: call again with `cursor`. `reset`: the cursor was too old; this is a full listing. */
export interface RecordsPage { records: SealedRecord[]; cursor: string; more: boolean; reset?: boolean }

export interface SessionInfo { id: string; current: boolean; userAgent: string | null; createdAt: string; lastSeenAt: string }

export interface SignupBody { email: string; salt: string; authKey: string; wrappedByPassword: Sealed; recoveryAuth: string; wrappedByRecovery: Sealed }
export interface RecoverBody { email: string; recoveryAuth: string; salt: string; authKey: string; wrappedByPassword: Sealed }
export interface PasswordBody { authKey: string; salt: string; newAuthKey: string; wrappedByPassword: Sealed }
export interface RecoveryKeyBody { authKey: string; recoveryAuth: string; wrappedByRecovery: Sealed }

export interface VaultExport {
  format: 'safespace-vault-export'; version: 1; exportedAt: string; user: Me['user']
  salt: string; iterations: number; wrappedByPassword: Sealed; wrappedByRecovery: Sealed; records: SealedRecord[]
}

export interface NarrationFacts {
  fused: number | null
  bySignal: Partial<Record<'hr' | 'hrv' | 'eda' | 'temp', number>>
  hr: number | null
  restingHr: number | null
  rmssd: number | null
  feeling: number | null
  tags: string[]
  activities: { id: string; change: string }[]
}

/**
 * What sync.ts puts inside every record's ciphertext: the record's own data plus the device time
 * of its last edit, which settles conflicts (last writer wins).
 */
export interface Envelope<T = unknown> { updatedAt: number; data: T }
