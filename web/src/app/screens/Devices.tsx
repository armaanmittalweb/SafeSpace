// Devices: the inputs agent's panel (Bluetooth straps and watches, the camera, file imports), hosted in
// the app shell. Imports are saved to the vault (kind 'import') when signed in.
import { DevicesPanel } from '../../inputs/Devices';
import { INPUTS } from '../ports';
import { getState, toast, useApp } from '../store';
import { vault } from '../vault';

export function Devices() {
  const s = useApp();
  return (
    <div class="page narrow">
      <header class="page-head">
        <h1>Devices</h1>
        <p class="lead">Connect what you have. Each one says which signals it gives; a score only ever uses what was measured.</p>
      </header>
      {s.auth.state !== 'in' && <p class="notice">You can connect and try a device without an account. Imports are kept only when you are signed in.</p>}
      <DevicesPanel inputs={INPUTS} onImport={async (r) => {
        if (getState().auth.state !== 'in') { toast('Read on this device. Sign in to keep it.'); return; }
        await vault.put('import', crypto.randomUUID(), { source: r.source, file: r.fileName, importedAt: Date.now(), measurements: r.measurements, daily: r.daily ?? [], summary: r.summary });
        toast(getState().sync.online ? 'Import saved.' : "Saved on this phone. It will sync when you're back online.");
      }} />
    </div>
  );
}
