import { useEffect, useState } from 'preact/hooks';
import type { SessionInfo } from '../../contract/records';
import { checkinsCsv, checkinsJson } from '../export';
import { ago } from '../format';
import { Link, navigate } from '../router';
import { saveSettings, signOut, toast, useApp } from '../store';
import { readTheme, setTheme, type ThemePref } from '../theme';
import { download, Field, SyncLine, Switch } from '../ui';
import { vault } from '../vault';
import { RecoveryKeyPanel } from './Auth';

function device(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

/** A password-confirmed action inline in a settings row. */
function Confirm({ label, action, danger, onDone, onCancel }: { label: string; action: (pw: string) => Promise<void>; danger?: boolean; onDone?: () => void; onCancel(): void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form class="inline-form" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { await action(pw); onDone?.(); } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      <Field label="Your password" error={err}>{(id, d) => <input id={id} type="password" autocomplete="current-password" required aria-describedby={d} value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />}</Field>
      <div class="actions">
        <button class={`btn ${danger ? 'danger-solid' : 'primary'}`} disabled={busy || !pw}>{busy ? 'Working…' : label}</button>
        <button type="button" class="btn secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function PasswordChange({ onClose }: { onClose(): void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form class="inline-form" onSubmit={async (e) => {
      e.preventDefault();
      if (next.length < 10) { setErr('Use at least 10 characters.'); return; }
      setBusy(true); setErr(null);
      try { await vault.changePassword(cur, next); toast('Password changed. Other devices were signed out.'); onClose(); } catch (x) { setErr((x as Error).message); setBusy(false); }
    }}>
      <Field label="Current password">{(id) => <input id={id} type="password" autocomplete="current-password" required value={cur} onInput={(e) => setCur((e.target as HTMLInputElement).value)} />}</Field>
      <Field label="New password" hint="At least 10 characters." error={err}>{(id, d) => <input id={id} type="password" autocomplete="new-password" required aria-describedby={d} value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} />}</Field>
      <div class="actions"><button class="btn primary" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button><button type="button" class="btn secondary" onClick={onClose}>Cancel</button></div>
    </form>
  );
}

export function Settings() {
  const s = useApp();
  const me = s.auth.state === 'in' ? s.auth.me : null;
  const [open, setOpen] = useState<null | 'password' | 'key' | 'delete'>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [sessErr, setSessErr] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemePref>(readTheme);
  useEffect(() => { vault.sessions().then(setSessions, (e) => setSessErr((e as Error).message)); }, []);
  const stampd = new Date().toISOString().slice(0, 10);

  return (
    <div class="page narrow settings">
      <header class="page-head"><h1>Settings</h1></header>

      <section aria-labelledby="acc-h">
        <h2 id="acc-h" class="section-title">Account</h2>
        <div class="card list-card">
          <div class="row"><div class="row-text"><span class="row-label">Email</span><p class="row-hint">{me?.user.email}</p></div></div>
          <div class="row"><div class="row-text"><span class="row-label">Sync</span><div class="row-hint"><SyncLine s={s.sync} signedIn /></div></div>
            <button type="button" class="btn secondary small" disabled={!s.sync.online || s.sync.syncing} onClick={() => void vault.sync()}>Sync now</button></div>
          <div class="row col">
            <div class="row-line"><span class="row-label">Password</span>{open !== 'password' && <button type="button" class="btn secondary small" onClick={() => setOpen('password')}>Change</button>}</div>
            {open === 'password' && <PasswordChange onClose={() => setOpen(null)} />}
          </div>
          <div class="row col">
            <div class="row-line">
              <div class="row-text"><span class="row-label">Recovery key</span><p class="row-hint">Unlocks your data if you forget your password. Making a new one stops the old one working.</p></div>
              {open !== 'key' && <button type="button" class="btn secondary small" onClick={() => { setNewKey(null); setOpen('key'); }}>New key</button>}
            </div>
            {open === 'key' && !newKey && <Confirm label="Make a new key" action={async (pw) => setNewKey(await vault.regenerateRecoveryKey(pw))} onCancel={() => setOpen(null)} />}
            {open === 'key' && newKey && <RecoveryKeyPanel keyText={newKey} cta="Done" onContinue={() => { setNewKey(null); setOpen(null); toast('New recovery key saved. The old one no longer works.'); }} />}
          </div>
          <div class="row"><span class="row-label">Sign out of this device</span><button type="button" class="btn secondary small" onClick={async () => { await signOut(); navigate('/', { replace: true }); }}>Sign out</button></div>
        </div>
      </section>

      <section aria-labelledby="ses-h">
        <h2 id="ses-h" class="section-title">Signed-in devices</h2>
        <ul class="card list-card">
          {sessErr && <li class="row"><p class="muted">{s.sync.online ? sessErr : 'Offline. The list of devices needs a connection.'}</p></li>}
          {!sessErr && !sessions && <li class="row"><p class="muted">Loading…</p></li>}
          {sessions?.map((x) => (
            <li class="row">
              <div class="row-text"><span class="row-label">{device(x.userAgent)}{x.current ? ' · this device' : ''}</span><p class="row-hint">Last active {ago(new Date(x.lastSeenAt).getTime())}</p></div>
              {!x.current && <button type="button" class="btn secondary small" onClick={async () => { await vault.revokeSession(x.id); setSessions(sessions.filter((y) => y.id !== x.id)); toast('Signed out that device.'); }}>Sign out</button>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="data-h">
        <h2 id="data-h" class="section-title">Your data</h2>
        <div class="card list-card">
          <Switch label="Keep raw beats" checked={s.settings.keepRawBeats} onChange={(v) => void saveSettings({ keepRawBeats: v })}
            hint="Store each beat-to-beat interval with a check-in (encrypted), not just the per-minute numbers. Off by default." />
          <Switch label="AI-written notes" checked={s.settings.aiNotes} onChange={(v) => void saveSettings({ aiNotes: v })}
            hint="Ask a free language model to write the note under a result. Only the numbers, labels and your tags are sent, never raw data or your note. Falls back to the written template." />
          <div class="row">
            <div class="row-text"><span class="row-label">Export</span><p class="row-hint">Everything you have saved, readable, or as the encrypted backup.</p></div>
            <div class="btn-group">
              <button type="button" class="btn secondary small" onClick={() => download(`safespace-checkins-${stampd}.csv`, new Blob([checkinsCsv(s.checkins)], { type: 'text/csv' }))}>CSV</button>
              <button type="button" class="btn secondary small" onClick={() => download(`safespace-${stampd}.json`, new Blob([checkinsJson(s.checkins, s.baseline)], { type: 'application/json' }))}>JSON</button>
              <button type="button" class="btn secondary small" onClick={async () => { try { download(`safespace-encrypted-backup-${stampd}.json`, await vault.exportSealed()); } catch (e) { toast((e as Error).message); } }}>Encrypted</button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="look-h">
        <h2 id="look-h" class="section-title">Appearance</h2>
        <div class="card list-card">
          <div class="row">
            <span class="row-label" id="theme-l">Theme</span>
            <div class="segmented" role="radiogroup" aria-labelledby="theme-l">
              {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
                <button type="button" role="radio" aria-checked={theme === t} class={theme === t ? 'on' : ''} onClick={() => { setTheme(t); setThemeState(t); }}>
                  {t === 'system' ? 'System' : t === 'light' ? 'Day' : 'Night'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="about-h">
        <h2 id="about-h" class="section-title">About</h2>
        <div class="card list-card">
          <Link href="/how-it-works" class="row row-link"><div class="row-text"><span class="row-label">How it works</span><p class="row-hint">The four models, their accuracy and limits, and the recorder you can play with.</p></div></Link>
          <div class="row"><div class="row-text"><span class="row-label">Not a medical device</span><p class="row-hint">SafeSpace shows patterns in your own readings. It does not diagnose anything. If you are worried about your heart or your mental health, talk to a doctor.</p></div></div>
        </div>
      </section>

      <section aria-labelledby="del-h">
        <h2 id="del-h" class="section-title">Delete account</h2>
        <div class="card list-card">
          <div class="row col">
            <div class="row-line">
              <div class="row-text"><p class="row-hint">Deletes your account and every check-in from the server and this device. Export first if you want a copy.</p></div>
              {open !== 'delete' && <button type="button" class="btn secondary small danger" onClick={() => setOpen('delete')}>Delete…</button>}
            </div>
            {open === 'delete' && <Confirm danger label="Delete everything" onCancel={() => setOpen(null)} action={async (pw) => {
              await vault.deleteAccount(pw);
              await signOut();
              toast('Your account and data were deleted.');
              navigate('/', { replace: true });
            }} />}
          </div>
        </div>
      </section>
    </div>
  );
}
