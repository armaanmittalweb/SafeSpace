import { useEffect, useRef, useState } from 'preact/hooks';
import type { Availability, FileInput, LiveInput } from '../../contract/inputs';
import type { Measurement, Signal } from '../../contract/records';
import { IconCamera, IconFile, IconStrap } from '../icons';
import { INPUTS } from '../ports';
import { Link } from '../router';
import { SIGNAL_LABEL } from '../scoring';
import { connectDevice, disconnectDevice, toast, useApp } from '../store';
import { vault } from '../vault';

const gives = (g: Signal[]) => g.map((s) => SIGNAL_LABEL[s].replace('Heart-rate variability', 'HRV')).join(' · ');
const WHERE: Record<string, string> = {
  'ble-hr': 'Chrome and Edge on Android, Windows, macOS and ChromeOS.',
  'polar-h10': 'Chrome and Edge. Beat-to-beat intervals from ECG, the most accurate HRV here.',
  camera: 'Every phone and laptop. Used during a check-in; nothing to connect.',
  'import-apple': 'Export from the Health app (Profile → Export All Health Data).',
  'import-fitbit': 'Your Fitbit data export (Account → Data export).',
  'import-e4': 'A session folder from E4 Connect. The device the models were trained on.',
};
const iconFor = (id: string) => (id === 'camera' ? <IconCamera /> : id.startsWith('import') ? <IconFile /> : <IconStrap />);

function reasonFor(e: unknown): string {
  const n = (e as DOMException)?.name;
  if (n === 'NotAllowedError') return 'Bluetooth access was turned down. Allow it in the browser\'s site settings and try again.';
  if (n === 'NotFoundError') return 'No device was chosen. Make sure it is on and worn, then pick it in the list.';
  if (n === 'NotSupportedError') return 'Not in this build yet.';
  if (n === 'NetworkError') return 'The device disconnected. Move closer and try again.';
  return (e as Error)?.message || 'Could not connect.';
}

function LiveRow({ input, av }: { input: LiveInput; av?: Availability }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isCam = input.id === 'camera';
  return (
    <li class="dev-row">
      <span class="dev-icon">{iconFor(input.id)}</span>
      <div class="dev-main">
        <b>{input.label}</b>
        <small>{gives(input.gives)}</small>
        <small class="muted">{av && !av.ok ? av.reason : WHERE[input.id]}</small>
        {err && <small class="error" role="alert">{err}</small>}
      </div>
      {isCam ? <Link href="/check-in" class="btn secondary small">Check in</Link>
        : <button type="button" class="btn secondary small" disabled={busy || !av || !av.ok} onClick={async () => {
          setBusy(true); setErr(null);
          try { const c = await connectDevice(input); toast(`${c.device} connected.`); } catch (e) { setErr(reasonFor(e)); }
          setBusy(false);
        }}>{busy ? 'Connecting…' : 'Connect'}</button>}
    </li>
  );
}

function FileRow({ input, av }: { input: FileInput; av?: Availability }) {
  const s = useApp();
  const ref = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const onFile = async (f: File) => {
    setProgress(0); setMsg(null);
    try {
      const r = await input.parse(f, setProgress);
      if (s.auth.state === 'in') {
        const id = crypto.randomUUID();
        await vault.put('import', id, { source: input.id, file: f.name, importedAt: Date.now(), measurements: r.measurements as Measurement[], summary: r.summary });
      }
      setMsg({ ok: true, text: s.auth.state === 'in' ? r.summary : `${r.summary} Sign in to keep it.` });
    } catch (e) { setMsg({ ok: false, text: reasonFor(e) }); }
    setProgress(null);
  };
  return (
    <li class="dev-row">
      <span class="dev-icon">{iconFor(input.id)}</span>
      <div class="dev-main">
        <b>{input.label}</b>
        <small>{gives(input.gives)}</small>
        <small class="muted">{av && !av.ok ? av.reason : WHERE[input.id]}</small>
        {progress != null && <progress max={1} value={progress} aria-label={`Reading ${input.label}`} />}
        {msg && <small class={msg.ok ? '' : 'error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</small>}
      </div>
      <input ref={ref} type="file" accept={input.accept} class="sr-only" tabIndex={-1} aria-hidden="true"
        onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void onFile(f); (e.target as HTMLInputElement).value = ''; }} />
      <button type="button" class="btn secondary small" disabled={progress != null || !av || !av.ok} onClick={() => ref.current?.click()}>Import</button>
    </li>
  );
}

export function Devices() {
  const s = useApp();
  const [av, setAv] = useState<Record<string, Availability>>({});
  useEffect(() => { for (const i of INPUTS) void i.available().then((a) => setAv((x) => ({ ...x, [i.id]: a }))); }, []);
  const live = INPUTS.filter((i): i is LiveInput => i.kind === 'live');
  const files = INPUTS.filter((i): i is FileInput => i.kind === 'file');
  return (
    <div class="page">
      <header class="page-head">
        <h1>Devices</h1>
        <p class="lead">Connect what you have. Each one says which signals it gives; the score only ever uses what was measured.</p>
      </header>
      <section class="card" aria-labelledby="con-h">
        <h2 id="con-h" class="kicker">Connected</h2>
        {s.device ? (
          <div class="connected">
            <div class="connected-main">
              <b>{s.device.conn.device}</b>
              <small>{gives(s.device.input.gives)}{s.device.battery != null ? ` · battery ${s.device.battery}%` : ''}</small>
            </div>
            <span class="num num-m">{s.device.hr ? Math.round(s.device.hr) : '--'}<span class="unit">bpm</span></span>
            <button type="button" class="btn secondary small" onClick={() => void disconnectDevice()}>Disconnect</button>
          </div>
        ) : (
          <p class="muted">Nothing connected. The phone camera works without connecting anything; a strap gives more accurate HRV.</p>
        )}
      </section>
      <section aria-labelledby="live-h">
        <h2 id="live-h" class="section-title">Measure live</h2>
        <ul class="card list-card">{live.filter((i) => i.id !== s.device?.input.id).map((i) => <LiveRow input={i} av={av[i.id]} />)}</ul>
      </section>
      <section aria-labelledby="imp-h">
        <h2 id="imp-h" class="section-title">Import a file</h2>
        <p class="muted small">Read on this device and never uploaded. Only per-minute numbers are kept.</p>
        <ul class="card list-card">{files.map((i) => <FileRow input={i} av={av[i.id]} />)}</ul>
      </section>
    </div>
  );
}
