// The app's Vault: the real end-to-end encrypted vault (web/src/vault via ./real), or, in dev with
// `?fake=…` and in the screenshot build, a local stand-in that needs no server (src/stubs/vault.ts).
// `?offline=1` (fake mode only) pretends the network is down, to show the offline states.
import type { Vault } from '../../contract/vault';
import { SETTINGS_ID } from '../../vault';
import { createStubVault } from '../../stubs/vault';
import { FAKE } from '../ports';
import { createRealVault } from './real';
import { applySeed } from '../../dev/seed';

const flag = (k: string) => { try { return new URLSearchParams(location.search).get(k) === '1'; } catch { return false; } };

export const USING_STUB = !!FAKE;
if (USING_STUB) applySeed(SETTINGS_ID);
export const vault: Vault = USING_STUB
  ? createStubVault({ forceOffline: flag('offline'), latencyMs: import.meta.env.VITE_FAKE ? 60 : 250 })
  : createRealVault();

/** The fixed id of the one settings record. */
export const SETTINGS_RECORD_ID = SETTINGS_ID;
