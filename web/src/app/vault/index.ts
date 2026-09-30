// The app's Vault. Until the vault agent's web/src/vault lands in this branch, this is the local stub
// (src/stubs/vault.ts); swap in an adapter over web/src/vault here. `?offline=1` (dev and shots builds)
// pretends the network is down, to show the offline states.
import type { Vault } from '../../contract/vault';
import { createStubVault } from '../../stubs/vault';

const devFlag = (k: string) => {
  if (!(import.meta.env.DEV || import.meta.env.VITE_FAKE)) return false;
  try { return new URLSearchParams(location.search).get(k) === '1'; } catch { return false; }
};

export const vault: Vault = createStubVault({ forceOffline: devFlag('offline'), latencyMs: import.meta.env.VITE_FAKE ? 60 : 250 });
