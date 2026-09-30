// The browser-side vault client (vault agent, web/src/vault/index.ts exports `vault: Vault`).
// Amendment (app agent): the contract described only the HTTP API; this is the surface the app calls.
// Every method does its crypto locally; the server only ever sees what the HTTP API table lists.
import type { ApiErrorCode, Me, NarrationFacts, RecordKind, SessionInfo } from './records';

export interface SyncStatus {
  online: boolean;
  /** local writes not yet accepted by the server */
  pending: number;
  syncing: boolean;
  /** epoch ms */
  lastSyncedAt: number | null;
  /** last sync error in plain words, cleared by the next successful sync */
  error: string | null;
}

export interface VaultRecord<T = unknown> {
  id: string;
  kind: RecordKind;
  value: T;
  /** epoch ms, local time of the last write */
  updatedAt: number;
  /** written on this device and not yet synced */
  pending: boolean;
}

/** Thrown by every method on failure. `code` is the API's code, or 'offline' / 'crypto' for local failures. */
export interface VaultError extends Error {
  code: ApiErrorCode | 'offline' | 'crypto';
  status: number;
}

export interface Vault {
  /** Restores the session from the cookie and the stored key; null when signed out. Never prompts. */
  restore(): Promise<Me | null>;
  /** Creates the account; resolves with the recovery key (8 groups of 4 Crockford base32 chars) to show once. */
  signUp(email: string, password: string): Promise<{ me: Me; recoveryKey: string }>;
  signIn(email: string, password: string): Promise<Me>;
  /** Deletes the local key and the local decrypted cache. */
  signOut(): Promise<void>;
  recover(email: string, recoveryKey: string, newPassword: string): Promise<Me>;
  changePassword(current: string, next: string): Promise<void>;
  /** New recovery key; the old one stops working. Uses POST /api/auth/recovery (amendment). */
  regenerateRecoveryKey(password: string): Promise<string>;
  sessions(): Promise<SessionInfo[]>;
  revokeSession(id: string): Promise<void>;

  /** Encrypts and stores locally at once (works offline), then syncs in the background. */
  put<T>(kind: RecordKind, id: string, value: T): Promise<void>;
  /** Local delete at once, tombstone synced in the background. */
  remove(id: string): Promise<void>;
  /** Decrypted records of one kind from the local cache, newest first by updatedAt. */
  list<T>(kind: RecordKind): Promise<VaultRecord<T>[]>;
  /** Fires after any local or synced change. */
  onChange(cb: () => void): () => void;

  sync(): Promise<void>;
  status(): SyncStatus;
  onStatus(cb: (s: SyncStatus) => void): () => void;

  /** GET /api/export as a Blob (sealed records and wrapped keys). */
  exportSealed(): Promise<Blob>;
  deleteAccount(password: string): Promise<void>;
  /** POST /api/narrate; null when the service answers 503 or the user is offline. */
  narrate(facts: NarrationFacts): Promise<{ text: string; model: string } | null>;
}
