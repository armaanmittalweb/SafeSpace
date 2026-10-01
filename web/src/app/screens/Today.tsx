import type { Baseline, CheckIn } from '../../contract/records';
import { DAYS_LONG, fmtSigned, longDate, plural, relDay, sameDay, stamp, startOfWeek, time } from '../format';
import { IconChevron, IconStrap, IconToday } from '../icons';
import { Link } from '../router';
import { baselineHasToday, baselineReady, BASELINE_NEEDED, feelingWord } from '../scoring';
import { setGuest, toast, useApp } from '../store';
import { vault } from '../vault';
import { avg, Legend, ScoreFigure, ScoreScale, SyncLine, TrendChart, WeekStrip } from '../ui';

const DAY = 864e5;

export function suggestion(cs: CheckIn[], now = Date.now()): string {
  if (!cs.length) return 'Your first check-in takes a minute. Sit down, rest your fingertip on the camera, and breathe normally.';
  const last = cs[0];
  const since = now - last.createdAt;
  if (since > 2 * DAY) return `You haven't done a check-in since ${relDay(last.createdAt, now) === 'Yesterday' ? 'yesterday' : DAYS_LONG[new Date(last.createdAt).getDay()]}.`;
  const week = cs.filter((c) => c.createdAt >= startOfWeek(now));
  const scored = week.filter((c) => c.score?.fused != null);
  if (scored.length >= 3) {
    const byTag = new Map<string, number[]>();
    for (const c of scored) for (const t of c.tags) byTag.set(t, [...(byTag.get(t) ?? []), c.score!.fused!]);
    const tags = [...byTag.entries()].filter(([, v]) => v.length >= 2).map(([t, v]) => [t, avg(v)!] as const).sort((a, b) => b[1] - a[1]);
    if (tags.length && tags[0][1] >= 0.1) return `This week, check-ins tagged "${tags[0][0]}" read highest, averaging ${fmtSigned(tags[0][1])}.`;
    const calmest = [...scored].sort((a, b) => a.score!.fused! - b.score!.fused!)[0];
    return `${plural(week.length, 'check-in')} this week. Your calmest was ${relDay(calmest.createdAt, now).toLowerCase() === 'today' ? 'today' : DAYS_LONG[new Date(calmest.createdAt).getDay()]}.`;
  }
  if (sameDay(last.createdAt, now)) return 'You have checked in today. Another one later helps you compare your morning and evening.';
  return 'A check-in at about the same time each day makes days easier to compare.';
}

export function LatestCard({ c, href }: { c: CheckIn; href?: string }) {
  const f = c.score?.fused;
  const hr = c.measurement?.features.hr_mean;
  const first = c.narration?.text.split(/(?<=\.)\s/)[0];
  const body = (
    <>
      <div class="card-head">
        <span class="kicker">Latest</span>
        <span class="kicker">{relDay(c.createdAt)} · {time(c.createdAt)}</span>
      </div>
      {f != null ? (
        <>
          <ScoreFigure score={f} size="l" />
          <ScoreScale score={f} compact />
        </>
      ) : (
        <div class="score-figure">
          <span class="num num-l">{hr != null ? Math.round(hr) : '--'}<span class="unit">bpm</span></span>
          <span class="score-word muted">{c.measurement ? 'No score until your baseline is set' : feelingWord(c.feeling) ?? 'Self-report'}</span>
        </div>
      )}
      {first && <p class="note-line">{first}</p>}
      {(c.tags.length > 0 || c.feeling) && (
        <p class="meta-line">
          {c.feeling && <span>Felt {feelingWord(c.feeling)!.toLowerCase()}</span>}
          {c.tags.map((t) => <span class="tag">{t}</span>)}
        </p>
      )}
    </>
  );
  return href ? <Link href={href} class="card card-link latest">{body}<IconChevron class="card-chev" /></Link> : <div class="card latest">{body}</div>;
}

export function BaselineCard({ b, sample = false, primary = false }: { b: Baseline | null; sample?: boolean; primary?: boolean }) {
  const n = b?.calibration.n ?? 0;
  const doneToday = baselineHasToday(b);
  return (
    <section class="card baseline-card" aria-labelledby="bl-h">
      <div class="card-head"><h2 id="bl-h" class="card-title">Baseline {Math.min(n, BASELINE_NEEDED)} of {BASELINE_NEEDED}</h2></div>
      <ol class="steps-dots" aria-hidden="true">{Array.from({ length: BASELINE_NEEDED }, (_, i) => <li class={i < n ? 'done' : i === n ? 'next' : ''} />)}</ol>
      <p class="muted">
        {n === 0 ? 'Three resting readings, one a day, tell SafeSpace what calm looks like for you. Scores start after the third.'
          : doneToday ? `Today's reading is in. Come back tomorrow for reading ${n + 1}.`
          : `Sit quietly for two minutes, then take reading ${n + 1}.`}
      </p>
      {!sample && !doneToday && !primary && <Link href="/baseline" class="btn secondary block">Take reading {n + 1}</Link>}
    </section>
  );
}

export function TodayView({ checkins, baseline, sample = false, now = Date.now() }: { checkins: CheckIn[]; baseline: Baseline | null; sample?: boolean; now?: number }) {
  const ready = baselineReady(baseline);
  const latest = checkins[0];
  const week = checkins.filter((c) => c.createdAt >= startOfWeek(now));
  const wk = avg(week.map((c) => c.score?.fused).filter((v): v is number => v != null));
  const n = baseline?.calibration.n ?? 0;
  // Until the baseline is set, today's baseline reading is the main thing to do.
  const baselineFirst = !sample && !ready && !baselineHasToday(baseline);
  return (
    <div class="today">
      <div class="today-main">
        {baselineFirst ? (
          <>
            <Link href="/baseline" class="btn primary cta"><IconToday /> <span>Take baseline reading {n + 1}<small>Sit quietly for two minutes first, then 60 seconds</small></span></Link>
            <BaselineCard b={baseline} primary />
            <p class="alt-line">Or <Link href="/check-in">start a check-in</Link>. It will show your heart rate, with no score until the baseline is set.</p>
          </>
        ) : sample ? (
          <span class="btn primary cta" aria-hidden="true"><IconToday /> <span>Start a check-in<small>60 seconds with your camera</small></span></span>
        ) : (
          <Link href="/check-in" class="btn primary cta"><IconToday /> <span>Start a check-in<small>60 seconds with your camera{ready ? '' : ' · no score until your baseline is set'}</small></span></Link>
        )}
        {baselineFirst && !latest ? null : latest ? <LatestCard c={latest} href={sample ? undefined : `/history/${latest.id}`} /> : (
          <div class="card empty-card">
            <p class="card-title">No check-ins yet</p>
            <p class="muted">Your results appear here: a score from calm to stressed, what each signal contributed, and a short note.</p>
          </div>
        )}
      </div>
      <div class="today-side">
        {!ready && !baselineFirst && <BaselineCard b={baseline} sample={sample} />}
        {checkins.length > 0 && <section class="card" aria-labelledby="wk-h">
          <div class="card-head">
            <h2 id="wk-h" class="kicker">This week</h2>
            {wk != null && <span class="kicker">avg {fmtSigned(wk)}</span>}
          </div>
          <WeekStrip checkins={checkins} now={now} />
          <Legend />
        </section>}
        {checkins.some((c) => c.score?.fused != null) && (
          <section class="card" aria-labelledby="tr-h">
            <div class="card-head"><h2 id="tr-h" class="kicker">Last two weeks</h2></div>
            <TrendChart checkins={checkins} now={now} />
          </section>
        )}
        {!(baselineFirst && !checkins.length) && <p class="suggestion">{suggestion(checkins, now)}</p>}
        {baselineFirst && !checkins.length && (
          <div class="card quiet">
            <h2 class="card-title">What you will see</h2>
            <p class="muted">After each check-in: a score from calm to stressed against your own rest, what each signal contributed, what was not measured, and a short note. Over days, a calendar of what tends to raise it.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export function Today() {
  const s = useApp();
  const now = Date.now();
  return (
    <div class="page">
      <header class="page-head">
        <p class="kicker">{longDate(now)}</p>
        <h1>Today</h1>
        <div class="head-aside"><SyncLine s={s.sync} signedIn /></div>
      </header>
      {s.device && (
        <Link href="/devices" class="device-line"><IconStrap size={18} /><span>{s.device.conn.device}</span><span class="mono">{s.device.hr ? `${Math.round(s.device.hr)} bpm` : 'connected'}</span></Link>
      )}
      {s.guest && (
        <div class="card guest-card" role="region" aria-labelledby="guest-h">
          <h2 id="guest-h" class="card-title">Keep the check-in you made before signing up?</h2>
          <p class="muted">{stamp(s.guest.createdAt)}{s.guest.measurement?.features.hr_mean ? ` · ${Math.round(s.guest.measurement.features.hr_mean)} bpm` : ''}. It is only on this device until you save it.</p>
          <div class="actions">
            <button type="button" class="btn primary small" onClick={async () => { await vault.put('checkin', s.guest!.id, s.guest); setGuest(null); toast('Saved to your history.'); }}>Save it</button>
            <button type="button" class="btn ghost small" onClick={() => setGuest(null)}>Discard</button>
          </div>
        </div>
      )}
      <TodayView checkins={s.checkins} baseline={s.baseline} now={now} />
    </div>
  );
}
