/**
 * The vault client: end-to-end encryption, the API, the device session and offline sync.
 * Each module documents its exported surface at the top; this re-exports what screens need.
 */
export { signUp, signIn, resume, unlock, signOut, recoverAccount, changePassword, regenerateRecoveryKey, deleteAccount, WrongRecoveryKey, type Account } from './account';
export { vault, createVaultClient, VaultError, VAULT_URL, type VaultClient } from './client';
export { createVaultStore, SETTINGS_ID, type VaultStore, type VaultRecord, type SyncResult } from './sync';
export { parseRecoveryKey } from './crypto';
export type * from './types';
