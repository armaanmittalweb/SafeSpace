// The Devices screen body: the connected device with live heart rate, then the ways to add
// one (Bluetooth strap or watch, the phone camera, a file import), each saying what it gives
// and where it works, with the reason when it does not work in this browser.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AnyInput, Beat, FileInput, InputSource, LiveConnection, LiveInput, Quality } from '../contract';
import '../activities/kit.css';
import type { ImportResult } from '../imports';
import { FILE_INPUTS, type FileInputInfo } from '../imports';
import type { LiveStatus, StatusConnection } from './live-base';
import { liveStore, useLive } from './live-store';
import { INPUTS } from './registry';
import './devices.css';

// ---------- live card ----------

const isStatus = (c: LiveConnection): c is StatusConnection => typeof (c as StatusConnection).onStatus === 'function';

export function useBeats(conn: LiveConnection | null, seconds = 30): Beat[] {
  const [beats, setBeats] = useState<Beat[]>(() => (conn && isStatus(conn) ? conn.recent(seconds) : []));
  useEffect(() => {
    if (!conn) { setBeats([]); return; }
    let buf = isStatus(conn) ? conn.recent(seconds) : [];
    setBeats(buf);
    return conn.onBeat((b) => {
      buf = [...buf.filter((x) => x.t > b.t - seconds * 1000), b];
      setBeats(buf);
    });
  }, [conn, seconds]);
  return beats;
}

/** Instantaneous heart rate over the last 30 s, drawn like a recorder pen. */
export function PulseTrace(p: { beats: Beat[]; seconds?: number; height?: number; label?: string }) {
  const S = p.seconds ?? 30, W = 300, H = p.height ?? 64;
  if (p.beats.length < 2) return <div class="dv-trace empty" style={{ height: `${H}px` }} aria-hidden="true" />;
  const now = p.beats[p.beats.length - 1].t;
  const v = p.beats.map((b) => ({ x: W - ((now - b.t) / 1000 / S) * W, y: b.rr ? 60000 / b.rr : b.hr })).filter((q) => q.x >= 0 && q.y > 30 && q.y < 220);
  const lo = Math.min(...v.map((q) => q.y)), hi = Math.max(...v.map((q) => q.y));
  const mid = (lo + hi) / 2, span = Math.max(hi - lo, 12) / 2;
  const y = (x: number) => H / 2 - ((x - mid) / span) * (H / 2 - 6);
  const pts = v.map((q) => `${q.x.toFixed(1)},${y(q.y).toFixed(1)}`).join(' ');
  return (
    <svg class="dv-trace" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label={p.label ?? `Heart rate over the last ${S} seconds, between ${Math.round(lo)} and ${Math.round(hi)} beats per minute`}>
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} class="dv-trace-mid" />
      <polyline points={pts} class="dv-trace-line" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

const STATE_WORD: Record<LiveStatus['state'], string> = {
  connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', disconnected: 'Disconnected',
};

export function LiveCard(p: { conn: LiveConnection; onDisconnect: () => void; onReconnect?: () => void }) {
  const beats = useBeats(p.conn);
  const [st, setSt] = useState<LiveStatus | null>(isStatus(p.conn) ? p.conn.status() : null);
  const [q, setQ] = useState<{ q: Quality; why: string | null } | null>(null);
  useEffect(() => (isStatus(p.conn) ? p.conn.onStatus(setSt) : undefined), [p.conn]);
  useEffect(() => p.conn.onQuality((qq, why) => setQ({ q: qq, why })), [p.conn]);
  const last = beats[beats.length - 1];
  const state = st?.state ?? 'connected';
  const stale = !last || Date.now() - last.t > 5000 || state !== 'connected';
  const src = isStatus(p.conn) ? p.conn.source : null;
  const hasRR = st?.hasRR;
  const extras = (p.conn as { extras?: unknown }).extras != null;
  return (
    <article class="ax-sheet dv-live" aria-labelledby="dv-live-name">
      <div class="dv-live-head">
        <div>
          <p class="ax-kicker">{STATE_WORD[state]}{src === 'camera' ? ' · Camera' : ' · Bluetooth'}{state === 'reconnecting' && st ? ` · try ${st.attempt} of 5` : ''}</p>
          <h3 class="dv-live-name" id="dv-live-name">{p.conn.device}</h3>
        </div>
        <div class={`dv-bpm${stale ? ' stale' : ''}`} aria-live="off">
          <span class="ax-mono">{last && state !== 'disconnected' ? last.hr : '–'}</span><small>bpm</small>
        </div>
      </div>
      {state === 'disconnected' ? (
        <p class="ax-note" role="status">{st?.message ?? 'The device disconnected.'}</p>
      ) : (
        <PulseTrace beats={beats} />
      )}
      {state === 'reconnecting' && <p class="ax-small" role="status">{st?.message}</p>}
      <dl class="dv-facts">
        <div><dt>Beat-to-beat</dt><dd>{hasRR == null ? 'Waiting for data' : hasRR ? 'Yes, so HRV is measured' : 'No, heart rate only'}</dd></div>
        {st?.battery != null && <div><dt>Battery</dt><dd class="ax-mono">{st.battery}%</dd></div>}
        {extras && <div><dt>Chest motion</dt><dd>Measured</dd></div>}
        {q && state === 'connected' && <div><dt>Signal</dt><dd><span class={`ax-q ${q.q}`}>{q.q[0].toUpperCase() + q.q.slice(1)}</span>{q.why && <span class="dv-why">{q.why}</span>}</dd></div>}
      </dl>
      <div class="ax-actions">
        {state === 'disconnected' && p.onReconnect && <button type="button" class="ax-btn primary" onClick={p.onReconnect}>Connect again</button>}
        <button type="button" class="ax-btn" onClick={p.onDisconnect}>{state === 'disconnected' ? 'Remove' : 'Disconnect'}</button>
      </div>
    </article>
  );
}

// ---------- add rows ----------

type Avail = { ok: true } | { ok: false; reason: string } | null;

export function useAvailability(p: AnyInput): Avail {
  const [a, setA] = useState<Avail>(null);
  useEffect(() => { let on = true; p.available().then((x) => on && setA(x)).catch(() => on && setA({ ok: false, reason: 'Could not check this browser.' })); return () => { on = false; }; }, [p]);
  return a;
}

const WORKS_ON: Partial<Record<InputSource, string>> = {
  'ble-hr': 'Chrome and Edge on Android, Windows, Mac and ChromeOS',
  camera: 'Any phone with a camera and flash; a laptop webcam works roughly',
};
const DETAIL: Partial<Record<InputSource, string>> = {
  'ble-hr': 'Any Bluetooth heart-rate strap (Polar, Garmin HRM, Wahoo TICKR, Coospo) and watches that broadcast heart rate. A chest strap is as accurate as an ECG for heart rate.',
  camera: 'Rest a fingertip over the back camera and flash for 60 seconds.',
};
const GIVES: Record<string, string> = { hr: 'Heart rate', hrv: 'HRV', eda: 'Skin conductance', temp: 'Skin temperature' };

function Meta(p: { gives: string; where?: string }) {
  return (
    <dl class="dv-row-meta">
      <div><dt>Gives</dt><dd>{p.gives}</dd></div>
      {p.where && <div><dt>Works on</dt><dd>{p.where}</dd></div>}
    </dl>
  );
}

export type ConnectState = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'error'; name: string; message: string };

export function BluetoothRow(p: { provider: LiveInput; avail: Avail; state: ConnectState; connected: boolean; onConnect: () => void }) {
  const blocked = p.avail && !p.avail.ok;
  return (
    <li class="dv-row">
      <div class="dv-row-main">
        <h3 class="dv-row-name">{p.provider.label}</h3>
        <p class="dv-row-detail">{DETAIL[p.provider.id]}</p>
        <Meta gives={p.provider.gives.map((g) => GIVES[g]).join(', ')} where={WORKS_ON[p.provider.id]} />
        {blocked && <p class="dv-reason" role="note">{(p.avail as { reason: string }).reason}</p>}
        {p.state.kind === 'connecting' && <p class="dv-status" role="status">Choose your device in the browser's list. Straps wake up when worn with damp electrodes.</p>}
        {p.state.kind === 'error' && p.state.name !== 'AbortError' && (
          <p class="dv-reason" role="alert">{p.state.message}</p>
        )}
      </div>
      <div class="dv-row-act">
        {!blocked && (
          <button type="button" class={`ax-btn${p.connected ? '' : ' primary'}`} onClick={p.onConnect} disabled={p.state.kind === 'connecting' || p.avail == null}>
            {p.state.kind === 'connecting' ? 'Connecting…' : p.connected ? 'Switch device' : p.state.kind === 'error' ? 'Try again' : 'Connect'}
          </button>
        )}
      </div>
    </li>
  );
}

export function CameraRow(p: { provider: LiveInput; avail: Avail }) {
  const blocked = p.avail && !p.avail.ok;
  return (
    <li class="dv-row">
      <div class="dv-row-main">
        <h3 class="dv-row-name">{p.provider.label}</h3>
        <p class="dv-row-detail">{DETAIL.camera}</p>
        <Meta gives="Heart rate, HRV (noisier than a strap)" where={WORKS_ON.camera} />
        {blocked && <p class="dv-reason" role="note">{(p.avail as { reason: string }).reason}</p>}
      </div>
      <div class="dv-row-act"><span class="dv-inline">{blocked ? '' : 'Used in a check-in'}</span></div>
    </li>
  );
}

export type ImportState =
  | { kind: 'idle' } | { kind: 'reading'; fraction: number; fileName: string }
  | { kind: 'done'; summary: string; fileName: string } | { kind: 'error'; message: string };

export function ImportRow(p: { provider: FileInputInfo; state: ImportState; onFile: (f: File) => void }) {
  const id = `dv-file-${p.provider.id}`;
  const busy = p.state.kind === 'reading';
  return (
    <li class="dv-row">
      <div class="dv-row-main">
        <h3 class="dv-row-name">{p.provider.label}</h3>
        <p class="dv-row-detail">{p.provider.how}</p>
        <Meta gives={p.provider.brings} where="Any browser" />
        {p.state.kind === 'reading' && (
          <div class="dv-progress" role="progressbar" aria-label={`Reading ${p.state.fileName}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.state.fraction * 100)}>
            <i style={{ transform: `scaleX(${p.state.fraction})` }} />
            <span class="ax-small">Reading {p.state.fileName} on this device · {Math.round(p.state.fraction * 100)}%</span>
          </div>
        )}
        {p.state.kind === 'done' && <p class="dv-done" role="status">{p.state.summary}</p>}
        {p.state.kind === 'error' && <p class="dv-reason" role="alert">{p.state.message}</p>}
      </div>
      <div class="dv-row-act">
        <input id={id} type="file" accept={p.provider.accept} class="dv-file" disabled={busy}
          onChange={(e) => { const f = (e.currentTarget as HTMLInputElement).files?.[0]; if (f) p.onFile(f); (e.currentTarget as HTMLInputElement).value = ''; }} />
        <label for={id} class={`ax-btn${busy ? ' disabled' : ''}`} aria-disabled={busy}>{p.state.kind === 'done' ? 'Import another' : 'Choose file'}</label>
      </div>
    </li>
  );
}

// ---------- the panel ----------

export interface DevicesPanelProps {
  /** Called with each finished import; the app saves the measurements (kind 'import'). */
  onImport?(r: ImportResult & { source: InputSource; fileName: string }): void | Promise<void>;
  /** Replace the providers (tests, playground). Defaults to INPUTS. */
  inputs?: AnyInput[];
}

export function DevicesPanel(p: DevicesPanelProps) {
  const inputs = p.inputs ?? INPUTS;
  const live = useLive();
  const bt = inputs.find((x): x is LiveInput => x.kind === 'live' && x.id === 'ble-hr');
  const cam = inputs.find((x): x is LiveInput => x.kind === 'live' && x.id === 'camera');
  const files = inputs.filter((x): x is FileInputInfo => x.kind === 'file').map((f) => FILE_INPUTS.find((x) => x.id === f.id) ?? (f as FileInputInfo));
  const btAvail = useAvailability(bt ?? cameraless);
  const camAvail = useAvailability(cam ?? cameraless);
  const [cs, setCs] = useState<ConnectState>({ kind: 'idle' });
  const [imp, setImp] = useState<Record<string, ImportState>>({});
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const connect = async () => {
    if (!bt) return;
    setCs({ kind: 'connecting' });
    try {
      const c = await bt.connect();
      const old = liveStore.get();
      liveStore.set(c);
      if (old && old !== c) void old.disconnect();
      if (mounted.current) setCs({ kind: 'idle' });
    } catch (e) {
      const ex = e as DOMException;
      if (mounted.current) setCs({ kind: 'error', name: ex.name, message: ex.message });
    }
  };
  const onFile = async (fi: FileInput, f: File) => {
    const set = (s: ImportState) => mounted.current && setImp((m) => ({ ...m, [fi.id]: s }));
    set({ kind: 'reading', fraction: 0, fileName: f.name });
    try {
      const r = await fi.parse(f, (fraction) => set({ kind: 'reading', fraction, fileName: f.name }));
      await p.onImport?.({ ...r, source: fi.id, fileName: f.name });
      set({ kind: 'done', summary: r.summary, fileName: f.name });
    } catch (e) {
      set({ kind: 'error', message: (e as Error).message || 'The file could not be read.' });
    }
  };

  return (
    <div class="ax dv">
      <section aria-labelledby="dv-connected">
        <h2 id="dv-connected" class="ax-kicker dv-h">Connected</h2>
        {live ? (
          <LiveCard conn={live} onDisconnect={() => void liveStore.disconnect()} onReconnect={bt ? connect : undefined} />
        ) : (
          <div class="dv-empty">
            <p>No device connected.</p>
            <p class="ax-small">Check-ins can still use your phone's camera, or just how you feel. A strap gives the most accurate heart rate and HRV.</p>
          </div>
        )}
      </section>

      <section aria-labelledby="dv-add">
        <h2 id="dv-add" class="ax-kicker dv-h">Add a device</h2>
        <ul class="dv-list">
          {bt && <BluetoothRow provider={bt} avail={btAvail} state={cs} connected={!!live} onConnect={connect} />}
          {cam && <CameraRow provider={cam} avail={camAvail} />}
        </ul>
      </section>

      {files.length > 0 && (
        <section aria-labelledby="dv-import">
          <h2 id="dv-import" class="ax-kicker dv-h">Import a file</h2>
          <p class="ax-small dv-sub">Files are read on this device and never uploaded. Only one-minute summaries are kept.</p>
          <ul class="dv-list">
            {files.map((f) => <ImportRow key={f.id} provider={f} state={imp[f.id] ?? { kind: 'idle' }} onFile={(file) => onFile(f, file)} />)}
          </ul>
        </section>
      )}
      <p class="ax-small dv-foot">Skin conductance and skin temperature need a wearable that measures them, such as the Empatica E4. Phones and heart-rate straps cannot.</p>
    </div>
  );
}

const cameraless: AnyInput = { kind: 'live', id: 'camera', label: '', gives: [], available: async () => ({ ok: false, reason: '' }), connect: async () => { throw new Error(); } };
