import { useMemo, useState } from 'preact/hooks';
import type { CheckIn } from '../../contract/records';
import { checkinsCsv, checkinsJson } from '../export';
import { addDays, dayMonth, DAYS_LONG, fmtSigned, longDate, MONTHS, plural, relDay, sameDay, startOfDay, startOfWeek, time } from '../format';
import { IconBack, IconChevron, IconDownload } from '../icons';
import { Link, navigate } from '../router';
import { feelingWord, levelOf, LEVEL_TEXT, tone } from '../scoring';
import { toast, useApp } from '../store';
import { avg, dayScore, dayStyle, download, Legend } from '../ui';
import { vault } from '../vault';
import { ResultView } from './Result';

function MonthCalendar({ checkins, month, onMonth, selected, onSelect, now }: {
  checkins: CheckIn[]; month: Date; onMonth(d: Date): void; selected: number | null; onSelect(d: number | null): void; now: number;
}) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
  const lead = (new Date(first).getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDays(first, i))];
  const canNext = new Date(month.getFullYear(), month.getMonth() + 1, 1).getTime() <= now;
  return (
    <section class="card" aria-labelledby="cal-h">
      <div class="card-head">
        <h2 id="cal-h" class="card-title">{MONTHS[month.getMonth()]} {month.getFullYear()}</h2>
        <div class="cal-nav">
          <button type="button" class="icon-btn" aria-label="Previous month" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><IconBack /></button>
          <button type="button" class="icon-btn" aria-label="Next month" disabled={!canNext} onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><IconChevron /></button>
        </div>
      </div>
      <div class="cal" role="grid" aria-labelledby="cal-h">
        <div class="cal-row cal-names" role="row">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span role="columnheader" aria-label={DAYS_LONG[(i + 1) % 7]}>{d}</span>)}</div>
        {Array.from({ length: Math.ceil(cells.length / 7) }, (_, r) => (
          <div class="cal-row" role="row">
            {cells.slice(r * 7, r * 7 + 7).map((d) => {
              if (d == null) return <span role="gridcell" class="cal-cell blank" />;
              const { n, score } = dayScore(checkins, d);
              const future = d > now;
              const sel = selected != null && sameDay(selected, d);
              const label = `${longDate(d)}: ${n === 0 ? 'no check-ins' : `${plural(n, 'check-in')}${score == null ? '' : `, average ${fmtSigned(score)}`}`}`;
              return (
                <span role="gridcell" class="cal-gc">
                  <button type="button" class={`cal-cell ${n ? 'has' : ''} ${sameDay(d, now) ? 'today' : ''} ${sel ? 'sel' : ''}`} style={dayStyle(score)}
                    disabled={future || n === 0} aria-pressed={sel} aria-label={label} onClick={() => onSelect(sel ? null : d)}>
                    <span class="cal-num" aria-hidden="true">{new Date(d).getDate()}</span>
                    {n > 1 && <span class="cal-n" aria-hidden="true">{n}</span>}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <Legend />
    </section>
  );
}

function WeekSummary({ checkins, now }: { checkins: CheckIn[]; now: number }) {
  const ws = startOfWeek(now);
  const week = checkins.filter((c) => c.createdAt >= ws);
  const last = checkins.filter((c) => c.createdAt >= addDays(ws, -7) && c.createdAt < ws);
  const sc = (cs: CheckIn[]) => avg(cs.map((c) => c.score?.fused).filter((v): v is number => v != null));
  const a = sc(week), b = sc(last);
  const scored = week.filter((c) => c.score?.fused != null).sort((x, y) => x.score!.fused! - y.score!.fused!);
  return (
    <section class="card" aria-labelledby="ws-h">
      <div class="card-head"><h2 id="ws-h" class="card-title">This week</h2><span class="kicker">{plural(week.length, 'check-in')}</span></div>
      {week.length === 0 ? <p class="muted">No check-ins yet this week.</p> : (
        <dl class="stats">
          <div><dt>Average</dt><dd class={`mono ${tone(a)}`}>{a == null ? '--' : fmtSigned(a)}</dd></div>
          <div><dt>Last week</dt><dd class="mono">{b == null ? '--' : fmtSigned(b)}</dd></div>
          {scored.length > 1 && <div><dt>Calmest</dt><dd>{relDay(scored[0].createdAt, now)}</dd></div>}
          {scored.length > 1 && <div><dt>Highest</dt><dd>{relDay(scored[scored.length - 1].createdAt, now)}{scored[scored.length - 1].tags[0] ? `, ${scored[scored.length - 1].tags[0]}` : ''}</dd></div>}
        </dl>
      )}
      {a != null && b != null && (
        <p class="muted">{Math.abs(a - b) < 0.05 ? 'About the same as last week.' : a > b ? `A little higher than last week, by ${(a - b).toFixed(2)}.` : `Calmer than last week, by ${(b - a).toFixed(2)}.`}</p>
      )}
    </section>
  );
}

function TagTrends({ checkins, onTag }: { checkins: CheckIn[]; onTag(t: string): void }) {
  const overall = avg(checkins.map((c) => c.score?.fused).filter((v): v is number => v != null));
  const rows = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const c of checkins) if (c.score?.fused != null) for (const t of c.tags) m.set(t, [...(m.get(t) ?? []), c.score.fused]);
    return [...m.entries()].filter(([, v]) => v.length >= 2).map(([t, v]) => ({ t, n: v.length, a: avg(v)! })).sort((x, y) => y.a - x.a);
  }, [checkins]);
  if (!rows.length) return (
    <section class="card quiet" aria-labelledby="tt-h"><h2 id="tt-h" class="card-title">Tags</h2><p class="muted">Tag your check-ins ("before exam", "after gym") and, after two of a kind, this shows how each one tends to read.</p></section>
  );
  return (
    <section class="card" aria-labelledby="tt-h">
      <div class="card-head"><h2 id="tt-h" class="card-title">Tags</h2>{overall != null && <span class="kicker">all check-ins <span class="mono">{fmtSigned(overall)}</span></span>}</div>
      <ul class="trend-list">
        {rows.map((r) => (
          <li><button type="button" class="trend" onClick={() => onTag(r.t)}>
            <span class="trend-name">{r.t}<small>{plural(r.n, 'check-in')}</small></span>
            <span class="trend-bar" aria-hidden="true"><i class="sig-zero" /><i class={`sig-fill ${r.a >= 0 ? 'stress' : 'calm'}`} style={{ left: r.a >= 0 ? '50%' : `${50 - Math.min(1, -r.a) * 50}%`, width: `${Math.min(1, Math.abs(r.a)) * 50}%` }} /></span>
            <span class={`mono trend-val ${tone(r.a)}`}>{fmtSigned(r.a)}</span>
          </button></li>
        ))}
      </ul>
    </section>
  );
}

function Row({ c }: { c: CheckIn }) {
  const f = c.score?.fused;
  const hr = c.measurement?.features.hr_mean;
  return (
    <li>
      <Link href={`/history/${c.id}`} class="hrow">
        <span class="hrow-time mono">{time(c.createdAt)}</span>
        <span class="hrow-swatch" style={dayStyle(f)} aria-hidden="true" />
        <span class="hrow-main">
          <span class="hrow-title">{f != null ? LEVEL_TEXT[levelOf(f)] : c.measurement ? (hr != null ? `${Math.round(hr)} bpm, no score` : 'No clear reading') : feelingWord(c.feeling) ?? 'Check-in'}</span>
          <span class="hrow-sub">{[c.feeling ? `felt ${feelingWord(c.feeling)!.toLowerCase()}` : null, ...c.tags].filter(Boolean).join(' · ')}</span>
        </span>
        <span class={`mono hrow-val ${tone(f)}`}>{f != null ? fmtSigned(f) : ''}</span>
        <IconChevron class="chev" size={18} />
      </Link>
    </li>
  );
}

export function History() {
  const s = useApp();
  const now = Date.now();
  const [month, setMonth] = useState(() => new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1));
  const [day, setDay] = useState<number | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const all = s.checkins;
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of all) for (const t of c.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [all]);
  const filtered = tag ? all.filter((c) => c.tags.includes(tag)) : all;
  // Until someone moves the calendar, the list is simply the most recent check-ins (the 1st of a month is not empty).
  const recentCut = addDays(startOfDay(now), -30);
  const shown = day != null ? filtered.filter((c) => sameDay(c.createdAt, day))
    : browsing ? filtered.filter((c) => { const d = new Date(c.createdAt); return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth(); })
    : filtered.filter((c) => c.createdAt >= recentCut);
  const groups = useMemo(() => {
    const g = new Map<number, CheckIn[]>();
    for (const c of shown) { const k = startOfDay(c.createdAt); g.set(k, [...(g.get(k) ?? []), c]); }
    return [...g.entries()];
  }, [shown]);

  const exp = async (kind: 'csv' | 'json' | 'sealed') => {
    setMenu(false);
    const stampd = new Date().toISOString().slice(0, 10);
    try {
      if (kind === 'csv') download(`safespace-checkins-${stampd}.csv`, new Blob([checkinsCsv(all)], { type: 'text/csv' }));
      else if (kind === 'json') download(`safespace-${stampd}.json`, new Blob([checkinsJson(all, s.baseline)], { type: 'application/json' }));
      else download(`safespace-encrypted-backup-${stampd}.json`, await vault.exportSealed());
    } catch (e) { toast(`Export failed: ${(e as Error).message}`); }
  };

  if (!all.length) {
    return (
      <div class="page">
        <header class="page-head"><h1>History</h1></header>
        <div class="empty">
          <div class="empty-cal" aria-hidden="true">{Array.from({ length: 28 }, (_, i) => <i style={i === 17 ? dayStyle(-0.5) : i === 19 ? dayStyle(0.4) : undefined} />)}</div>
          <h2 class="card-title">Nothing here yet</h2>
          <p class="muted">Each check-in you save lands on this calendar, coloured from calm to stressed. After a week or two, tags show what tends to raise your readings.</p>
          <Link href="/check-in" class="btn primary">Start a check-in</Link>
        </div>
      </div>
    );
  }

  return (
    <div class="page">
      <header class="page-head">
        <h1>History</h1>
        <div class="head-aside menu-wrap">
          <button type="button" class="btn secondary small" aria-expanded={menu} aria-controls="exp-menu" onClick={() => setMenu(!menu)}><IconDownload size={18} />Export</button>
          {menu && (
            <div class="menu" id="exp-menu">
              <button type="button" onClick={() => void exp('csv')}>Spreadsheet (CSV)<small>One row per check-in</small></button>
              <button type="button" onClick={() => void exp('json')}>Everything (JSON)<small>Check-ins and baseline, readable</small></button>
              <button type="button" onClick={() => void exp('sealed')}>Encrypted backup<small>As stored on the server</small></button>
            </div>
          )}
        </div>
      </header>

      {tags.length > 0 && (
        <div class="filter" role="group" aria-label="Filter by tag">
          <button type="button" class={`chip ${tag == null ? 'on' : ''}`} aria-pressed={tag == null} onClick={() => setTag(null)}>All</button>
          {tags.map((t) => <button type="button" class={`chip ${tag === t ? 'on' : ''}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>{t}</button>)}
        </div>
      )}

      <div class="history">
        <div class="history-side">
          <MonthCalendar checkins={filtered} month={month} onMonth={(m) => { setMonth(m); setDay(null); setBrowsing(true); }} selected={day} onSelect={setDay} now={now} />
          <WeekSummary checkins={all} now={now} />
          <TagTrends checkins={all} onTag={(t) => setTag(t)} />
        </div>
        <section class="history-list" aria-labelledby="list-h">
          <div class="list-head">
            <h2 id="list-h" class="card-title">{day != null ? longDate(day) : browsing ? MONTHS[month.getMonth()] : 'Last 30 days'}{tag ? ` · ${tag}` : ''}</h2>
            {(day != null || tag || browsing) && <button type="button" class="link" onClick={() => { setDay(null); setTag(null); setBrowsing(false); setMonth(new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1)); }}>Show recent</button>}
          </div>
          {groups.length === 0 ? <p class="muted pad">No check-ins {tag ? `tagged "${tag}" ` : ''}{browsing ? `in ${MONTHS[month.getMonth()]}` : 'in the last 30 days'}.</p> : groups.map(([d, cs]) => (
            <div class="day-group">
              <h3 class="kicker day-label">{/\d/.test(relDay(d, now)) ? longDate(d) : `${relDay(d, now)} · ${dayMonth(d)}`}</h3>
              <ul class="hlist">{cs.map((c) => <Row c={c} />)}</ul>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

export function CheckInDetail({ id }: { id: string }) {
  const s = useApp();
  const c = s.checkins.find((x) => x.id === id);
  const [confirm, setConfirm] = useState(false);
  if (!s.loaded) return null;
  if (!c) {
    return (
      <div class="page">
        <Link href="/history" class="back-link"><IconBack size={18} />History</Link>
        <div class="empty"><h1 class="card-title">This check-in is not here</h1><p class="muted">It may have been deleted on another device.</p><Link href="/history" class="btn secondary">Back to History</Link></div>
      </div>
    );
  }
  return (
    <div class="page narrow">
      <Link href="/history" class="back-link"><IconBack size={18} />History</Link>
      <header class="page-head"><h1>{relDay(c.createdAt)}, {time(c.createdAt)}</h1></header>
      <ResultView c={c} baseline={s.baseline} baselineCount={s.baseline?.calibration.n ?? 0}>
        <div class="danger-zone">
          {!confirm ? (
            <button type="button" class="btn secondary danger" onClick={() => setConfirm(true)}>Delete this check-in</button>
          ) : (
            <div class="confirm" role="alertdialog" aria-labelledby="del-h">
              <p id="del-h">Delete this check-in from every device? This cannot be undone.</p>
              <div class="actions">
                <button type="button" class="btn danger-solid" onClick={async () => { await vault.remove(c.id); toast('Check-in deleted.'); navigate('/history', { replace: true }); }}>Delete</button>
                <button type="button" class="btn secondary" onClick={() => setConfirm(false)}>Keep it</button>
              </div>
            </div>
          )}
        </div>
      </ResultView>
    </div>
  );
}
