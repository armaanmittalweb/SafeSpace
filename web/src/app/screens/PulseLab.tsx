// /lab/pulse (noindex): the camera's accuracy check against a reference (a watch, a strap or a pulse
// oximeter). Log readings side by side; the page keeps them in this browser and reports the mean
// absolute error, overall and on 'good' signal only. The camera ships if that is within about 5 bpm.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LiveConnection, LiveInput } from '../../contract/inputs';
import type { Measurement, Quality } from '../../contract/records';
import { PublicShell } from '../App';
import { fmt, stamp } from '../format';
import { INPUTS } from '../ports';
import { download, Field, QualityMeter, Trace } from '../ui';

interface Pair { t: number; ref: number; cam: number | null; quality: Quality; kind: 'instant' | '60 s'; note: string; device: string }
const KEY = 'ss-pulse-lab';
const load = (): Pair[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; } };
const store = (p: Pair[]) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private mode */ } };
const mae = (ps: Pair[]) => { const v = ps.filter((p) => p.cam != null); return v.length ? v.reduce((a, p) => a + Math.abs(p.cam! - p.ref), 0) / v.length : null; };
const bias = (ps: Pair[]) => { const v = ps.filter((p) => p.cam != null); return v.length ? v.reduce((a, p) => a + (p.cam! - p.ref), 0) / v.length : null; };

export function PulseLab() {
  const camera = INPUTS.find((i): i is LiveInput => i.id === 'camera' && i.kind === 'live')!;
  const [conn, setConn] = useState<LiveConnection | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState<{ q: Quality; why: string | null }>({ q: 'poor', why: null });
  const [beats, setBeats] = useState<{ t: number; rr: number | null }[]>([]);
  const [pairs, setPairs] = useState<Pair[]>(load);
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('sitting');
  const [run, setRun] = useState<{ left: number } | null>(null);
  const [last60, setLast60] = useState<Measurement | null>(null);
  const ac = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!conn) return;
    const a = conn.onQuality((qq, why) => setQ({ q: qq, why }));
    const b = conn.onBeat((x) => setBeats((bs) => [...bs.filter((y) => y.t > x.t - 15000), { t: x.t, rr: x.rr }]));
    return () => { a(); b(); };
  }, [conn]);
  useEffect(() => () => { void conn?.disconnect(); }, [conn]);

  const now = beats.length ? beats[beats.length - 1].t : 0;
  const rr10 = beats.filter((b) => b.t > now - 10000 && b.rr != null).map((b) => b.rr!);
  const bpm10 = rr10.length >= 5 ? 60000 / (rr10.reduce((a, x) => a + x, 0) / rr10.length) : null;
  const sub = useMemo(() => conn?.onSample ?? (() => () => {}), [conn]);

  const add = (p: Pair) => { const next = [p, ...pairs]; setPairs(next); store(next); setRef(''); };
  const refN = Number(ref);
  const refOk = ref !== '' && refN >= 30 && refN <= 220;
  const good = pairs.filter((p) => p.quality === 'good');
  const mAll = mae(pairs), mGood = mae(good), bAll = bias(pairs);

  const start = async () => {
    setErr(null);
    try { setConn(await camera.connect()); }
    catch (e) { setErr((e as DOMException).name === 'NotAllowedError' ? 'Camera access was turned down. Allow it in the site settings and reload.' : (e as Error).message); }
  };
  const measure60 = async () => {
    if (!conn) return;
    ac.current = new AbortController();
    const t0 = Date.now();
    setRun({ left: 60 });
    const iv = setInterval(() => setRun({ left: Math.max(0, 60 - Math.round((Date.now() - t0) / 1000)) }), 500);
    try { setLast60(await conn.measure(60, ac.current.signal)); } catch { /* cancelled */ }
    clearInterval(iv);
    setRun(null);
  };

  return (
    <PublicShell>
      <div class="page lab">
        <header class="page-head">
          <p class="kicker">Lab · not linked from the app</p>
          <h1>Camera pulse accuracy check</h1>
          <p class="lead">Wear a watch, a strap or a pulse oximeter. Put your fingertip over the camera and flash, and log what both say. Do ten: five sitting, five straight after climbing stairs. The camera ships if it is within about 5 bpm when the signal says good.</p>
        </header>

        {!conn ? (
          <div class="card">
            <p class="muted">Uses the rear camera and flash. Nothing is recorded except the numbers you log, kept in this browser.</p>
            {err && <p class="error" role="alert">{err}</p>}
            <button type="button" class="btn primary" onClick={() => void start()}>Start the camera</button>
          </div>
        ) : (
          <div class="card lab-live">
            <div class="live-top">
              <div class="live-hr">
                <span class={`num num-hero ${bpm10 ? '' : 'placeholder'}`}>{bpm10 ? Math.round(bpm10) : '—'}</span>
                <span class="live-unit">bpm<span class="muted"> · mean of the last 10 s</span></span>
              </div>
              <QualityMeter q={q.q} why={q.why} />
            </div>
            <div class="paper-frame"><Trace subscribe={sub} beats={beats.map((b) => b.t)} /></div>
            <p class="live-tip">{q.why && q.why !== 'Starting up' ? q.why : q.q === 'poor' ? 'Finding your pulse.' : 'Good. Keep still.'}</p>
            <p class="fine">{conn.device}</p>
          </div>
        )}

        <section class="card" aria-labelledby="log-h">
          <h2 id="log-h" class="card-title">Log a reading</h2>
          <form class="lab-form" onSubmit={(e) => { e.preventDefault(); if (refOk && bpm10) add({ t: Date.now(), ref: refN, cam: Math.round(bpm10 * 10) / 10, quality: q.q, kind: 'instant', note, device: conn?.device ?? '' }); }}>
            <Field label="Reference bpm" hint="What the watch or oximeter shows right now.">{(id, d) => <input id={id} inputMode="numeric" class="mono" aria-describedby={d} value={ref} onInput={(e) => setRef((e.target as HTMLInputElement).value.replace(/[^0-9.]/g, ''))} />}</Field>
            <Field label="Condition">{(id) => (
              <select id={id} value={note} onChange={(e) => setNote((e.target as HTMLSelectElement).value)}>
                <option value="sitting">Sitting</option><option value="after stairs">After stairs</option><option value="standing">Standing</option><option value="other">Other</option>
              </select>
            )}</Field>
            <div class="actions">
              <button class="btn primary" disabled={!refOk || !bpm10}>Log with the live reading</button>
              <button type="button" class="btn secondary" disabled={!conn || !!run} onClick={() => void measure60()}>{run ? `Measuring… ${run.left} s` : 'Measure 60 s'}</button>
            </div>
          </form>
          {last60 && (
            <div class="lab-60">
              <p>60-s reading: <b class="mono">{last60.features.hr_mean ? fmt(last60.features.hr_mean, 1) : '--'} bpm</b>, signal {last60.quality}. Enter the reference you saw during that minute:</p>
              <button type="button" class="btn secondary small" disabled={!refOk} onClick={() => { add({ t: last60.startedAt, ref: refN, cam: last60.features.hr_mean ?? null, quality: last60.quality, kind: '60 s', note, device: last60.device ?? '' }); setLast60(null); }}>Log the 60-s reading</button>
            </div>
          )}
        </section>

        <section class="card" aria-labelledby="res-h">
          <div class="card-head"><h2 id="res-h" class="card-title">Results</h2><span class="kicker">{pairs.length} logged</span></div>
          <dl class="stats">
            <div><dt>Mean abs. error, all</dt><dd class="mono">{mAll == null ? '--' : `${fmt(mAll, 1)} bpm`}</dd></div>
            <div><dt>On good signal</dt><dd class="mono">{mGood == null ? '--' : `${fmt(mGood, 1)} bpm`}</dd></div>
            <div><dt>Bias (camera − ref)</dt><dd class="mono">{bAll == null ? '--' : `${fmt(bAll, 1)} bpm`}</dd></div>
            <div><dt>Verdict</dt><dd>{good.length < 5 ? `${5 - good.length} more good readings` : mGood! <= 5 ? 'Within 5 bpm: ships' : 'Over 5 bpm: does not ship'}</dd></div>
          </dl>
          {pairs.length > 0 && (
            <>
              <div class="table-wrap">
                <table class="lab-table">
                  <thead><tr><th>When</th><th>Condition</th><th>Kind</th><th class="num-c">Ref</th><th class="num-c">Camera</th><th class="num-c">Error</th><th>Signal</th></tr></thead>
                  <tbody>{pairs.map((p) => (
                    <tr><td>{stamp(p.t)}</td><td>{p.note}</td><td>{p.kind}</td><td class="num-c mono">{p.ref}</td><td class="num-c mono">{p.cam == null ? '--' : fmt(p.cam, 1)}</td>
                      <td class="num-c mono">{p.cam == null ? '--' : fmt(p.cam - p.ref, 1)}</td><td>{p.quality}</td></tr>
                  ))}</tbody>
                </table>
              </div>
              <div class="actions">
                <button type="button" class="btn secondary small" onClick={() => download('safespace-pulse-check.csv', new Blob([
                  'time,condition,kind,reference_bpm,camera_bpm,error_bpm,quality,device\n' + pairs.map((p) => [new Date(p.t).toISOString(), p.note, p.kind, p.ref, p.cam ?? '', p.cam == null ? '' : (p.cam - p.ref).toFixed(1), p.quality, `"${p.device}"`].join(',')).join('\n') + '\n',
                ], { type: 'text/csv' }))}>Export CSV</button>
                <button type="button" class="btn secondary small" onClick={() => download('safespace-pulse-check.json', new Blob([JSON.stringify({ pairs, maeAll: mAll, maeGood: mGood, bias: bAll }, null, 2)], { type: 'application/json' }))}>Export JSON</button>
                <button type="button" class="btn ghost small" onClick={() => { if (confirm('Clear every logged reading?')) { setPairs([]); store([]); } }}>Clear</button>
              </div>
            </>
          )}
        </section>
      </div>
    </PublicShell>
  );
}
