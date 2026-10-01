import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AnyInput, LiveConnection, LiveInput } from '../../contract/inputs';
import type { CheckIn, Measurement, Quality } from '../../contract/records';
import { IconBack, IconCamera, IconChevron, IconClose, IconFeel, IconStrap } from '../icons';
import { factsOf, templateNote } from '../notes';
import { FAKE, INPUTS } from '../ports';
import { Link, navigate } from '../router';
import { baselineFrom, baselineHasToday, baselineReady, BASELINE_NEEDED, FEELINGS, scoreMeasurement } from '../scoring';
import { connectDevice, getState, setGuest, toast, useApp } from '../store';
import { QualityMeter, Trace } from '../ui';
import { vault } from '../vault';
import { ResultView } from './Result';

/** 60 s; fake-mode builds accept `&dur=` so screenshots do not wait a minute. */
const DURATION = (() => {
  if (!FAKE) return 60;
  const d = Number(new URLSearchParams(location.search).get('dur'));
  return d >= 5 && d <= 60 ? d : 60;
})();
type Mode = 'checkin' | 'baseline';
type Step =
  | { k: 'choose' }
  | { k: 'prepare'; input: LiveInput }
  | { k: 'measure'; conn: LiveConnection; own: boolean; input: LiveInput }
  | { k: 'failed'; input: LiveInput; title: string; body: string; retry: boolean }
  | { k: 'poor'; m: Measurement; input: LiveInput; why: string | null }
  | { k: 'feeling' }
  | { k: 'tags' }
  | { k: 'result' }
  | { k: 'baseline-done'; n: number };

const DEFAULT_TAGS = ['before exam', 'after exam', 'work', 'deadline', 'after gym', 'after coffee', 'poor sleep', 'commute', 'at home', 'morning', 'evening'];

function failure(e: unknown, input: AnyInput): { title: string; body: string; retry: boolean } {
  const name = (e as DOMException)?.name;
  const cam = input.id === 'camera';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return cam
      ? { title: 'SafeSpace cannot use the camera', body: 'Camera access was turned down. Allow it for this site in your browser\'s settings (the icon next to the address), then try again.', retry: true }
      : { title: 'Bluetooth access was turned down', body: 'Allow Bluetooth for this site in your browser\'s settings, then try again.', retry: true };
  }
  if (name === 'NotFoundError') return cam ? { title: 'No camera found', body: 'This device does not seem to have a camera SafeSpace can use.', retry: false } : { title: 'No device chosen', body: 'Pick your strap or watch in the list the browser shows. Make sure it is on and worn.', retry: true };
  if (name === 'NotReadableError') return { title: 'The camera is busy', body: 'Another app or tab is using the camera. Close it and try again.', retry: true };
  if (name === 'NotSupportedError') return { title: `${input.label} is not in this build yet`, body: 'Use the phone camera for now, or just tell us how you feel.', retry: false };
  return { title: 'Something went wrong', body: (e as Error)?.message || 'The measurement could not start.', retry: true };
}

function Bar({ title, onBack, onClose, h1 }: { title: string; onBack?: () => void; onClose?: () => void; h1?: boolean }) {
  return (
    <header class="flow-bar">
      {onBack ? <button type="button" class="icon-btn" aria-label="Back" onClick={onBack}><IconBack /></button> : <span class="icon-btn-space" />}
      {h1 ? <h1 class="flow-title">{title}</h1> : <span class="flow-title">{title}</span>}
      {onClose ? <button type="button" class="icon-btn" aria-label="Cancel" onClick={onClose}><IconClose /></button> : <span class="icon-btn-space" />}
    </header>
  );
}

function useAvailability(inputs: AnyInput[]) {
  const [av, setAv] = useState<Record<string, { ok: true } | { ok: false; reason: string }>>({});
  useEffect(() => { for (const i of inputs) void i.available().then((a) => setAv((x) => ({ ...x, [i.id]: a }))); }, []);
  return av;
}

/** A phone from behind: the fingertip covers the lens and the flash. */
function FingerDiagram() {
  return (
    <svg class="finger" viewBox="0 0 160 150" aria-hidden="true">
      <rect x="30" y="8" width="100" height="160" rx="16" fill="var(--card)" stroke="var(--ink)" stroke-width="1.5" />
      <rect x="42" y="20" width="40" height="46" rx="10" fill="none" stroke="var(--line)" stroke-width="1.2" />
      <circle cx="56" cy="34" r="7" fill="none" stroke="var(--ink)" stroke-width="1.5" />
      <circle cx="56" cy="34" r="2.5" fill="var(--ink)" />
      <circle cx="56" cy="54" r="4" fill="none" stroke="var(--ink)" stroke-width="1.2" />
      <text x="70" y="57" font-size="7" fill="var(--muted)" font-family="var(--mono)">FLASH</text>
      <text x="67" y="30" font-size="7" fill="var(--muted)" font-family="var(--mono)">LENS</text>
      <path d="M36 150 C36 110 40 64 50 34 C54 22 66 22 68 34 C72 60 70 110 74 150" fill="var(--stress)" fill-opacity=".14" stroke="var(--ink)" stroke-width="1.3" stroke-dasharray="3 2.5" />
    </svg>
  );
}

function Prepare({ mode, input, onStart, onBack }: { mode: Mode; input: LiveInput; onStart(): void; onBack(): void }) {
  const cam = input.id === 'camera';
  return (
    <div class="flow-body">
      <Bar title={mode === 'baseline' ? 'Baseline reading' : 'Check-in'} onBack={onBack} />
      <div class="flow-content prepare">
        {cam && <FingerDiagram />}
        <h1>{cam ? 'Cover the lens and the flash with one fingertip' : `Measuring with ${input.label}`}</h1>
        <ol class="howto">
          {mode === 'baseline' && <li>Sit down and rest for two minutes first. This reading tells SafeSpace what calm looks like for you.</li>}
          {cam && <li>Rest your fingertip lightly. Pressing hard squeezes the blood out and hides the pulse.</li>}
          {cam && <li>Keep your hand and the phone still, resting on a table or your knee.</li>}
          <li>Breathe normally for the full minute. The flash will get warm; that is fine.</li>
        </ol>
        <p class="fine">The camera image stays on this phone and is never saved. Only the pulse numbers are kept.</p>
      </div>
      <div class="flow-foot"><button type="button" class="btn primary block" onClick={onStart}>Start the 60-second reading</button></div>
    </div>
  );
}

/** Waits until the pulse is found (signal fair or better for 2 s), then records DURATION seconds. */
function Measuring({ conn, onDone, onCancel, onFail }: { conn: LiveConnection; onDone(m: Measurement): void; onCancel(): void; onFail(e: unknown): void }) {
  const [q, setQ] = useState<{ q: Quality; why: string | null }>({ q: 'poor', why: 'Starting up' });
  const [hr, setHr] = useState<number | null>(null);
  const [beats, setBeats] = useState<number[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const opened = useRef(Date.now());
  const okSince = useRef<number | null>(null);
  const ac = useRef(new AbortController());
  useEffect(() => {
    const u1 = conn.onQuality((qq, why) => { setQ({ q: qq, why }); okSince.current = qq === 'poor' ? null : okSince.current ?? Date.now(); });
    const u2 = conn.onBeat((b) => { setHr(b.hr); setBeats((bs) => [...bs.slice(-30), b.t]); });
    const iv = setInterval(() => {
      setNow(Date.now());
      // A strap has no warm-up; the camera waits for a finger and a steady pulse.
      const ready = !conn.onSample || (okSince.current != null && Date.now() - okSince.current >= 2000);
      setStartedAt((s) => {
        if (s != null || !ready) return s;
        conn.measure(DURATION, ac.current.signal).then(onDone, (e) => { if ((e as DOMException).name !== 'AbortError') onFail(e); });
        return Date.now();
      });
    }, 250);
    return () => { u1(); u2(); clearInterval(iv); ac.current.abort(); };
  }, [conn]);
  const sub = useMemo(() => conn.onSample ?? (() => () => {}), [conn]);
  const left = startedAt == null ? DURATION : Math.max(0, DURATION - Math.floor((now - startedAt) / 1000));
  const finding = startedAt == null;
  const tip = finding
    ? (q.why && q.why !== 'Starting up' && q.q === 'poor' ? q.why : 'Finding your pulse. The minute starts once it is steady.')
    : q.why ?? (q.q === 'good' ? 'Good. Keep still and breathe normally.' : 'Keep your fingertip still over the lens and flash.');
  const slow = finding && now - opened.current > 20000;
  return (
    <div class="flow-body measuring">
      <Bar h1 title={finding ? 'Getting ready' : 'Measuring'} onClose={() => { ac.current.abort(); onCancel(); }} />
      <div class="flow-content">
        <div class="live-top">
          <div class="live-hr">
            <span class={`num num-hero ${hr ? '' : 'placeholder'}`} aria-hidden="true">{hr ? Math.round(hr) : '--'}</span>
            <span class="live-unit">bpm<span class="muted"> · heart rate, live</span></span>
            <span class="sr-only">{hr ? `${Math.round(hr)} beats per minute` : 'Finding your pulse'}</span>
          </div>
          <QualityMeter q={q.q} why={q.why} />
        </div>
        <div class="paper-frame">
          {conn.onSample ? <Trace subscribe={sub} beats={beats} height={180} /> : <div class="trace no-wave"><p class="muted">{conn.device} sends beats, not a waveform.</p></div>}
          <div class="timeline" role="progressbar" aria-label="Time left" aria-valuemin={0} aria-valuemax={DURATION} aria-valuenow={DURATION - left} aria-valuetext={finding ? 'Not started' : `${left} seconds left`}>
            {Array.from({ length: 30 }, (_, i) => <i class={i < Math.floor(((DURATION - left) / DURATION) * 30) ? 'on' : ''} />)}
          </div>
          <div class="timeline-label"><span class="mono">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</span><span class="muted">{finding ? 'starts when your pulse is steady' : 'left'}</span></div>
        </div>
        <p class={`live-tip ${q.q}`} aria-live="polite">{tip}</p>
        {slow && <p class="muted small">Still nothing? Warm your hand, rest the phone on a table, and cover both the lens and the flash with the pad of one finger.</p>}
        <p class="fine device-note">{conn.device}</p>
      </div>
    </div>
  );
}

function Feeling({ value, onPick, onBack }: { value: CheckIn['feeling']; onPick(f: CheckIn['feeling']): void; onBack(): void }) {
  return (
    <div class="flow-body">
      <Bar title="Check-in" onBack={onBack} />
      <div class="flow-content">
        <h1 id="feel-h">How do you feel right now?</h1>
        <p class="lead">Your own word next to the numbers is what makes a history useful.</p>
        <div class="feel-list" role="radiogroup" aria-labelledby="feel-h">
          {FEELINGS.map((w, i) => {
            const v = (i + 1) as 1 | 2 | 3 | 4 | 5;
            return (
              <button type="button" role="radio" aria-checked={value === v} class={`feel ${value === v ? 'on' : ''}`} onClick={() => onPick(v)}>
                <span class="feel-scale" aria-hidden="true">{[1, 2, 3, 4, 5].map((k) => <i class={k === v ? 'on' : ''} />)}</span>
                <span>{w}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div class="flow-foot"><button type="button" class="btn ghost block" onClick={() => onPick(null)}>Skip</button></div>
    </div>
  );
}

function Tags({ tags, note, recent, onChange, onNote, onNext, onBack }: { tags: string[]; note: string; recent: string[]; onChange(t: string[]): void; onNote(n: string): void; onNext(): void; onBack(): void }) {
  const [text, setText] = useState('');
  const suggestions = [...new Set([...recent, ...DEFAULT_TAGS])].filter((t) => !tags.includes(t)).slice(0, 10);
  const add = (t: string) => { const v = t.trim().toLowerCase().slice(0, 32); if (v && !tags.includes(v) && tags.length < 5) onChange([...tags, v]); setText(''); };
  return (
    <div class="flow-body">
      <Bar title="Check-in" onBack={onBack} />
      <div class="flow-content">
        <h1>What's going on?</h1>
        <p class="lead">A tag or two lets History show what tends to raise your readings.</p>
        {tags.length > 0 && (
          <ul class="chips" aria-label="Your tags">
            {tags.map((t) => <li><button type="button" class="chip on" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>{t} <IconClose size={14} /></button></li>)}
          </ul>
        )}
        <form class="tag-add" onSubmit={(e) => { e.preventDefault(); add(text); }}>
          <label class="sr-only" for="tag-in">Add a tag</label>
          <input id="tag-in" value={text} placeholder="Add your own tag" maxLength={32} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
          <button class="btn secondary" disabled={!text.trim() || tags.length >= 5}>Add</button>
        </form>
        <h2 class="kicker">Suggestions</h2>
        <ul class="chips">{suggestions.map((t) => <li><button type="button" class="chip" onClick={() => add(t)}>{t}</button></li>)}</ul>
        <label class="field">
          <span>Note <span class="muted">(optional, stays encrypted)</span></span>
          <textarea rows={3} maxLength={280} value={note} onInput={(e) => onNote((e.target as HTMLTextAreaElement).value)} />
        </label>
      </div>
      <div class="flow-foot"><button type="button" class="btn primary block" onClick={onNext}>See the result</button></div>
    </div>
  );
}

export function CheckInFlow({ mode }: { mode: Mode }) {
  const s = useApp();
  const signedIn = s.auth.state === 'in';
  const [step, setStep] = useState<Step>({ k: 'choose' });
  const [m, setM] = useState<Measurement | null>(null);
  const [feeling, setFeeling] = useState<CheckIn['feeling']>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [llm, setLlm] = useState<CheckIn['narration']>(null);
  const id = useMemo(() => crypto.randomUUID(), []);
  const createdAt = useMemo(() => Date.now(), []);
  const av = useAvailability(INPUTS);
  const camera = INPUTS.find((i) => i.id === 'camera') as LiveInput;
  const ownConn = useRef<LiveConnection | null>(null);

  useEffect(() => () => { void ownConn.current?.disconnect(); }, []);
  // Baseline readings go straight to the camera (or the connected device).
  useEffect(() => { if (mode === 'baseline' && step.k === 'choose') setStep(s.device ? { k: 'measure', conn: s.device.conn, own: false, input: s.device.input } : { k: 'prepare', input: camera }); }, []);

  const leave = () => navigate(signedIn ? '/' : '/');
  const start = async (input: LiveInput) => {
    try {
      let conn: LiveConnection;
      if (input.id === 'camera') { conn = await input.connect(); ownConn.current = conn; setStep({ k: 'measure', conn, own: true, input }); }
      else { conn = await connectDevice(input); setStep({ k: 'measure', conn, own: false, input }); }
    } catch (e) { setStep({ k: 'failed', input, ...failure(e, input) }); }
  };
  const stopOwn = () => { void ownConn.current?.disconnect(); ownConn.current = null; };
  const measured = (mm: Measurement, input: LiveInput) => {
    stopOwn();
    const keep = signedIn && s.settings.keepRawBeats;
    const clean: Measurement = { ...mm };
    if (!keep) delete clean.beats;
    if (mm.quality === 'poor' || mm.features.hr_mean == null) { setM(clean); setStep({ k: 'poor', m: clean, input, why: null }); return; }
    setM(clean);
    if (mode === 'baseline') void saveBaseline(clean); else setStep({ k: 'feeling' });
  };

  const saveBaseline = async (mm: Measurement) => {
    const st = getState();
    const prev = st.baseline;
    const readings = [...(prev && !baselineReady(prev) ? prev.readings : []), mm];
    const b = baselineFrom(readings, prev && !baselineReady(prev) ? prev.id : crypto.randomUUID(), prev && !baselineReady(prev) ? prev.createdAt : Date.now());
    await vault.put('baseline', b.id, b);
    setStep({ k: 'baseline-done', n: b.calibration.n });
  };

  const checkin: CheckIn = useMemo(() => {
    const c: CheckIn = {
      id, createdAt, measurement: m, activities: [], score: scoreMeasurement(m, s.baseline),
      feeling, tags, note: note.trim() || null, narration: null,
    };
    c.narration = llm ?? { text: templateNote(c, s.baseline, s.baseline?.calibration.n ?? 0), source: 'template' };
    return c;
  }, [m, feeling, tags, note, s.baseline, llm]);

  useEffect(() => {
    if (step.k !== 'result' || !signedIn || !s.settings.aiNotes || llm) return;
    void vault.narrate(factsOf(checkin, s.baseline)).then((r) => { if (r) setLlm({ text: r.text, source: 'llm', model: r.model }); });
  }, [step.k]);

  const save = async () => {
    setSaving(true);
    try {
      await vault.put('checkin', checkin.id, checkin);
      toast(getState().sync.online ? 'Check-in saved.' : "Saved on this phone. It will sync when you're back online.");
      navigate('/', { replace: true });
    } catch (e) {
      setSaving(false);
      toast(`Could not save: ${(e as Error).message}`);
    }
  };

  if (mode === 'baseline' && step.k !== 'baseline-done' && baselineHasToday(s.baseline) && !baselineReady(s.baseline)) {
    return (
      <div class="flow-body">
        <Bar title="Baseline reading" onClose={leave} />
        <div class="flow-content state">
          <h1>Today's baseline reading is done</h1>
          <p class="lead">Readings on different days give a truer picture of your rest. Come back tomorrow for reading {(s.baseline?.calibration.n ?? 0) + 1}. You can still do a check-in now.</p>
        </div>
        <div class="flow-foot stack">
          <Link href="/check-in" class="btn primary block">Start a check-in</Link>
          <Link href="/" class="btn ghost block">Back to Today</Link>
        </div>
      </div>
    );
  }

  // ---- guests get one check-in ----
  if (!signedIn && s.guest && step.k === 'choose') {
    return (
      <div class="flow-body">
        <Bar title="Check-in" onClose={leave} />
        <div class="flow-content">
          <h1>Your check-in from earlier is waiting</h1>
          <p class="lead">Without an account you can try one check-in. Create one to keep it, build your baseline and check in again.</p>
          <ResultView c={s.guest} baseline={null} baselineCount={0} />
        </div>
        <div class="flow-foot stack">
          <Link href="/signup" class="btn primary block">Create an account to keep it</Link>
          <button type="button" class="btn ghost block" onClick={() => { setGuest(null); }}>Discard it and try again</button>
        </div>
      </div>
    );
  }

  switch (step.k) {
    case 'choose': {
      const others = INPUTS.filter((i): i is LiveInput => i.kind === 'live' && i.id !== 'camera' && i.id !== s.device?.input.id);
      const camAv = av.camera;
      return (
        <div class="flow-body">
          <Bar title="Check-in" onClose={leave} />
          <div class="flow-content">
            <h1>How do you want to check in?</h1>
            {!signedIn && <p class="lead">Nothing is saved without an account. You can create one after, and keep this check-in.</p>}
            <ul class="option-list">
              {s.device && (
                <li><button type="button" class="option" onClick={() => setStep({ k: 'measure', conn: s.device!.conn, own: false, input: s.device!.input })}>
                  <IconStrap /><span><b>{s.device.conn.device}</b><small>Connected{s.device.hr ? ` · ${Math.round(s.device.hr)} bpm now` : ''}. Heart rate and HRV.</small></span><IconChevron class="chev" />
                </button></li>
              )}
              <li><button type="button" class="option" disabled={camAv ? !camAv.ok : false} onClick={() => setStep({ k: 'prepare', input: camera })}>
                <IconCamera /><span><b>Phone camera</b><small>{camAv && !camAv.ok ? camAv.reason : 'Fingertip over the lens and flash, 60 seconds. Heart rate, and HRV on a good signal.'}</small></span><IconChevron class="chev" />
              </button></li>
              {others.slice(0, 1).map((i) => {
                const a = av[i.id];
                return (
                  <li><button type="button" class="option" disabled={!a || !a.ok} onClick={() => void start(i)}>
                    <IconStrap /><span><b>{i.label}</b><small>{a && !a.ok ? a.reason : 'Connect over Bluetooth. Exact heart rate and HRV.'}</small></span><IconChevron class="chev" />
                  </button></li>
                );
              })}
              <li><button type="button" class="option" onClick={() => { setM(null); setStep({ k: 'feeling' }); }}>
                <IconFeel /><span><b>Just tell us how you feel</b><small>No measurement, no score. A word and a tag still build your history.</small></span><IconChevron class="chev" />
              </button></li>
            </ul>
          </div>
        </div>
      );
    }
    case 'prepare':
      return <Prepare mode={mode} input={step.input} onStart={() => void start(step.input)} onBack={mode === 'baseline' ? leave : () => setStep({ k: 'choose' })} />;
    case 'measure':
      return <Measuring conn={step.conn} onDone={(mm) => measured(mm, step.input)} onFail={(e) => { stopOwn(); setStep({ k: 'failed', input: step.input, ...failure(e, step.input) }); }}
        onCancel={() => { stopOwn(); if (mode === 'baseline') leave(); else setStep({ k: 'choose' }); }} />;
    case 'failed':
      return (
        <div class="flow-body">
          <Bar title="Check-in" onClose={leave} />
          <div class="flow-content state">
            <h1>{step.title}</h1>
            <p class="lead">{step.body}</p>
          </div>
          <div class="flow-foot stack">
            {step.retry && <button type="button" class="btn primary block" onClick={() => void start(step.input)}>Try again</button>}
            {mode === 'checkin' && <button type="button" class="btn secondary block" onClick={() => { setM(null); setStep({ k: 'feeling' }); }}>Just tell us how you feel instead</button>}
            <button type="button" class="btn ghost block" onClick={() => setStep(mode === 'baseline' ? { k: 'prepare', input: camera } : { k: 'choose' })}>Back</button>
          </div>
        </div>
      );
    case 'poor':
      return (
        <div class="flow-body">
          <Bar title={mode === 'baseline' ? 'Baseline reading' : 'Check-in'} onClose={leave} />
          <div class="flow-content state">
            <h1>The signal was too weak to trust</h1>
            <p class="lead">{step.m.features.hr_mean == null ? 'SafeSpace could not find a steady pulse in that minute.' : `It read about ${Math.round(step.m.features.hr_mean)} bpm, but too many beats were missed or moved.`} Rest your fingertip lightly over both the lens and the flash, keep still, and try once more.</p>
            {mode === 'baseline' && <p class="muted">Weak readings are not used for your baseline, because every later score is measured against it.</p>}
          </div>
          <div class="flow-foot stack">
            <button type="button" class="btn primary block" onClick={() => setStep(step.input.id === 'camera' ? { k: 'prepare', input: step.input } : { k: 'measure', conn: getState().device!.conn, own: false, input: step.input })}>Try again</button>
            {mode === 'checkin' && <button type="button" class="btn ghost block" onClick={() => setStep({ k: 'feeling' })}>Continue without a good reading</button>}
          </div>
        </div>
      );
    case 'feeling':
      return <Feeling value={feeling} onPick={(f) => { setFeeling(f); setStep({ k: 'tags' }); }} onBack={() => setStep({ k: 'choose' })} />;
    case 'tags': {
      const recent = [...new Set(s.checkins.flatMap((c) => c.tags))];
      return <Tags tags={tags} note={note} recent={recent} onChange={setTags} onNote={setNote} onNext={() => setStep({ k: 'result' })} onBack={() => setStep({ k: 'feeling' })} />;
    }
    case 'result':
      return (
        <div class="flow-body">
          <Bar h1 title="Result" onBack={() => setStep({ k: 'tags' })} />
          <div class="flow-content wide">
            <ResultView c={checkin} baseline={s.baseline} baselineCount={s.baseline?.calibration.n ?? 0} />
          </div>
          <div class="flow-foot stack">
            {signedIn ? (
              <button type="button" class="btn primary block" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save check-in'}</button>
            ) : (
              <>
                <button type="button" class="btn primary block" onClick={() => { setGuest(checkin); navigate('/signup'); }}>Create an account to keep it</button>
                <button type="button" class="btn ghost block" onClick={() => { setGuest(checkin); navigate('/'); }}>Done, don't save</button>
              </>
            )}
          </div>
        </div>
      );
    case 'baseline-done': {
      const n = step.n;
      const ready = n >= BASELINE_NEEDED;
      return (
        <div class="flow-body">
          <Bar title="Baseline reading" />
          <div class="flow-content state">
            <p class="kicker">Baseline {Math.min(n, BASELINE_NEEDED)} of {BASELINE_NEEDED}</p>
            <ol class="steps-dots big" aria-hidden="true">{Array.from({ length: BASELINE_NEEDED }, (_, i) => <li class={i < n ? 'done' : ''} />)}</ol>
            <h1>{ready ? 'Your baseline is set' : `Reading ${n} saved`}</h1>
            <div class="baseline-figs">
              <div><span class="num num-l">{Math.round(m!.features.hr_mean!)}</span><span class="unit">bpm</span><span class="kicker">Resting heart rate</span></div>
              {m!.features.rmssd != null && m!.quality === 'good' && <div><span class="num num-l">{Math.round(m!.features.rmssd)}</span><span class="unit">ms</span><span class="kicker">HRV (RMSSD)</span></div>}
            </div>
            <p class="lead">{ready ? 'From now on, every check-in is scored against these three resting readings.' : baselineHasToday(getState().baseline) ? `Come back tomorrow for reading ${n + 1}. Readings on different days give a truer picture of your rest.` : ''}</p>
          </div>
          <div class="flow-foot"><button type="button" class="btn primary block" onClick={() => navigate('/', { replace: true })}>Done</button></div>
        </div>
      );
    }
  }
}
