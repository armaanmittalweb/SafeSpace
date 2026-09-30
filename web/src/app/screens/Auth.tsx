import { useState } from 'preact/hooks';
import type { VaultError } from '../../contract/vault';
import { IconCheck, IconCopy, IconDownload, IconLock } from '../icons';
import { Link, navigate } from '../router';
import { getState, setState, signedIn, signOut } from '../store';
import { download, Field } from '../ui';
import { vault } from '../vault';

const MIN_PW = 10;
const nextPath = () => {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/';
};
function message(e: unknown): string {
  const v = e as VaultError;
  if (v?.code === 'offline') return 'You are offline. Signing in needs a connection.';
  if (v?.code === 'rate_limited') return 'Too many tries. Wait a minute and try again.';
  return v?.message || 'Something went wrong. Try again.';
}

function PasswordInput({ id, value, onInput, autocomplete, describedBy }: { id: string; value: string; onInput(v: string): void; autocomplete: string; describedBy?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div class="pw">
      <input id={id} type={show ? 'text' : 'password'} value={value} autocomplete={autocomplete} required aria-describedby={describedBy}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
      <button type="button" class="pw-toggle" aria-pressed={show} onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</button>
    </div>
  );
}

export function SignIn() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const me = await vault.signIn(email, pw);
      await signedIn(me);
      navigate(nextPath(), { replace: true });
    } catch (x) { setErr(message(x)); setBusy(false); }
  };
  return (
    <div class="form-page">
      <h1>Sign in</h1>
      <p class="lead">Your check-ins are unlocked on this device with your password.</p>
      <form onSubmit={submit} class="form" noValidate={false}>
        <Field label="Email">{(id) => <input id={id} type="email" autocomplete="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />}</Field>
        <Field label="Password" error={err}>{(id, d) => <PasswordInput id={id} value={pw} onInput={setPw} autocomplete="current-password" describedBy={d} />}</Field>
        <button class="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p class="form-alt">Forgot your password? <Link href="/recover">Use your recovery key</Link></p>
      <p class="form-alt">New here? <Link href="/signup">Create an account</Link></p>
    </div>
  );
}

export function SignUp() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const short = pw.length > 0 && pw.length < MIN_PW;
  const submit = async (e: Event) => {
    e.preventDefault();
    if (pw.length < MIN_PW) { setErr(`Use at least ${MIN_PW} characters.`); return; }
    setBusy(true); setErr(null);
    try {
      const { me, recoveryKey } = await vault.signUp(email, pw);
      setState({ recoveryKey });
      await signedIn(me);
      navigate('/welcome', { replace: true });
    } catch (x) { setErr(message(x)); setBusy(false); }
  };
  return (
    <div class="form-page">
      <h1>Create an account</h1>
      <p class="lead">Your check-ins are encrypted on this device before they are sent. The password never leaves it.</p>
      <form onSubmit={submit} class="form">
        <Field label="Email">{(id) => <input id={id} type="email" autocomplete="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />}</Field>
        <Field label="Password" hint={short ? `${MIN_PW - pw.length} more characters` : `At least ${MIN_PW} characters. A short sentence is easy to remember.`} error={err}>
          {(id, d) => <PasswordInput id={id} value={pw} onInput={setPw} autocomplete="new-password" describedBy={d} />}
        </Field>
        <button class="btn primary block" disabled={busy}>{busy ? 'Creating your account…' : 'Create account'}</button>
      </form>
      <p class="form-alt">Already have one? <Link href="/signin">Sign in</Link></p>
    </div>
  );
}

export function Recover() {
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (pw.length < MIN_PW) { setErr(`Use at least ${MIN_PW} characters for the new password.`); return; }
    setBusy(true); setErr(null);
    try {
      const me = await vault.recover(email, key, pw);
      await signedIn(me);
      navigate('/', { replace: true });
    } catch (x) { setErr(message(x)); setBusy(false); }
  };
  return (
    <div class="form-page">
      <h1>Recover your account</h1>
      <p class="lead">Your recovery key unlocks your check-ins and lets you set a new password. Other devices will be signed out.</p>
      <form onSubmit={submit} class="form">
        <Field label="Email">{(id) => <input id={id} type="email" autocomplete="email" required value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />}</Field>
        <Field label="Recovery key" hint="32 characters in 8 groups, as you saved it. Dashes and spaces are optional.">
          {(id, d) => <input id={id} class="mono key-input" autocomplete="off" autocapitalize="characters" spellcheck={false} required value={key} aria-describedby={d}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" onInput={(e) => setKey((e.target as HTMLInputElement).value)} />}
        </Field>
        <Field label="New password" error={err}>{(id, d) => <PasswordInput id={id} value={pw} onInput={setPw} autocomplete="new-password" describedBy={d} />}</Field>
        <button class="btn primary block" disabled={busy}>{busy ? 'Checking the key…' : 'Recover and sign in'}</button>
      </form>
      <p class="form-alt">Lost both your password and your key? Your data cannot be recovered, by anyone. You can <Link href="/signup">start a new account</Link>.</p>
    </div>
  );
}

export function Unlock() {
  const s = getState();
  const email = s.auth.state === 'locked' ? s.auth.me.user.email : '';
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await signedIn(await vault.unlock(pw)); } catch (x) { setErr(message(x)); setBusy(false); }
  };
  return (
    <div class="form-page">
      <span class="icon-badge"><IconLock /></span>
      <h1>Unlock SafeSpace</h1>
      <p class="lead">You are signed in as {email}, but this device does not have your key yet. Enter your password once to unlock your check-ins here.</p>
      <form onSubmit={submit} class="form">
        <Field label="Password" error={err}>{(id, d) => <PasswordInput id={id} value={pw} onInput={setPw} autocomplete="current-password" describedBy={d} />}</Field>
        <button class="btn primary block" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
      <p class="form-alt"><button type="button" class="link" onClick={() => void signOut()}>Sign out instead</button></p>
    </div>
  );
}

/** Shows a recovery key once; `onSaved` fires after it was copied, downloaded or confirmed written down. */
export function RecoveryKeyPanel({ keyText, onContinue, cta = 'Continue' }: { keyText: string; onContinue(): void; cta?: string }) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [wrote, setWrote] = useState(false);
  const saved = copied || downloaded || wrote;
  const email = (() => { const a = getState().auth; return a.state === 'in' ? a.me.user.email : ''; })();
  return (
    <div class="recovery">
      <p class="key-box mono">
        <span class="sr-only">Recovery key: </span>
        {keyText.split('-').map((g, i) => <span class="key-group">{g}{i < 7 && <span class="sr-only"> </span>}</span>)}
      </p>
      <div class="key-actions">
        <button type="button" class="btn secondary" onClick={async () => { try { await navigator.clipboard.writeText(keyText); setCopied(true); } catch { setCopied(false); } }}>
          {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}{copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" class="btn secondary" onClick={() => {
          download('safespace-recovery-key.txt', new Blob([`SafeSpace recovery key\n\nAccount: ${email}\nKey: ${keyText}\n\nKeep this somewhere safe and private. With your email it unlocks your check-ins and resets your password.\nhttps://safespace.amittal.dev/recover\n`], { type: 'text/plain' }));
          setDownloaded(true);
        }}>
          {downloaded ? <IconCheck size={18} /> : <IconDownload size={18} />}{downloaded ? 'Downloaded' : 'Download'}
        </button>
      </div>
      <label class="check">
        <input type="checkbox" checked={wrote} onChange={(e) => setWrote((e.target as HTMLInputElement).checked)} />
        <span>I have written it down somewhere safe</span>
      </label>
      <button type="button" class="btn primary block" disabled={!saved} onClick={onContinue}>{cta}</button>
      {!saved && <p class="fine center">Copy it, download it or write it down to continue.</p>}
    </div>
  );
}
