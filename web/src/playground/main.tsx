// Dev-only playground: every device state and every activity (start, running, done) and the
// stress session, one view per ?v=, without the app shell. Served by `vite` at
// /src/playground/index.html; never part of the production build (not a build input).
// ?theme=dark|light forces a theme. src/playground/shots.mjs screenshots every view.
import { render, type VNode } from 'preact';
import '../styles/tokens.css';
import './playground.css';
import type { ActivityId, ActivityResult, Beat, FileInput, LiveInput, StressSession } from '../contract';
import { ACTIVITIES, ActivityPicker, activityById } from '../activities';
import { ResultView, type Meta, type RunProps } from '../activities/kit';
import '../activities/kit.css';
import { appleHealth, empaticaE4, fitbit } from '../imports';
import { bleHr, NO_BLUETOOTH_REASON } from '../inputs/ble-hr';
import { BluetoothRow, CameraRow, DevicesPanel, ImportRow, LiveCard } from '../inputs/Devices';
import { FakeConnection } from '../inputs/fake';
import { liveStore } from '../inputs/live-store';
import { cameraPlaceholder } from '../inputs/registry';
import { SessionSummary, StressSessionView } from '../session';
import { sessionSeries, summaryNumbers, summaryText } from '../session/summary';
import '../inputs/devices.css';

const q = new URLSearchParams(location.search);
const theme = q.get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
const view = q.get('v') ?? 'index';

const noop = () => undefined;
const log = (label: string) => (x?: unknown) => console.info(label, JSON.stringify(x));

// ---------- stub providers so every state renders the same way in any browser ----------
const btOk: LiveInput = { ...bleHr, available: async () => ({ ok: true }), connect: async () => new FakeConnection() };
const btNo: LiveInput = { ...bleHr, available: async () => ({ ok: false, reason: NO_BLUETOOTH_REASON }) };
const camOk: LiveInput = { ...cameraPlaceholder, available: async () => ({ ok: true }) };
const files: FileInput[] = [appleHealth, fitbit, empaticaE4];

// ---------- sample results ----------
const SAMPLE: Record<ActivityId, Record<string, number>> = {
  typing: { wpm: 46.2, holdMeanMs: 104, holdSdMs: 21, flightMeanMs: 96, interKeyMeanMs: 212, interKeySdMs: 71, interKeyCv: 0.335, errorRate: 0.041, corrections: 6, pauses: 1, charsTyped: 148, progress: 0.9 },
  'follow-dot': { meanErrorPct: 3.8, rmsErrorPct: 4.6, onTargetPct: 58, jerk: 142, overCorrectionsPerMin: 9 },
  'target-taps': { trials: 31, accuracyPct: 93.5, timeToTapMs: 812, timeToTapSdMs: 140, errorRadii: 0.42, reactionMs: 268, movementMs: 544, hesitationMs: 118, overshootPct: 22.6, throughputBits: 4.1 },
  stroop: { trials: 104, rtCongruentMs: 642, rtIncongruentMs: 781, interferenceMs: 139, errorRate: 0.048, incongruentErrors: 4, missed: 2 },
  'beat-the-clock': { problems: 27, accuracy: 0.52, meanRtMs: 4310, meanLevel: 5.4, finalLevel: 6, timeouts: 5, stoppedEarly: 0 },
  'paced-breathing': { breaths: 18, completedPct: 100, hrStart: 76, hrEnd: 68, hrChange: -8, rsaBpm: 9.4 },
  'steady-hand': { rms: 0.061, p95: 0.12, peakHz: 9.25, bandShare: 0.41, sampleHz: 60 },
  'tap-rhythm': { pacedTaps: 8, asyncMeanMs: -34, asyncSdMs: 28, freeTaps: 16, intervalMeanMs: 731, intervalMedianMs: 728, intervalCv: 0.046, driftMsPerTap: -1.8, tempoErrorPct: -2.5 },
};
const Z: Partial<Record<ActivityId, Record<string, number>>> = {
  typing: { wpm: -1.4, holdMeanMs: 0.4, interKeyCv: 2.3, corrections: 1.1 },
  stroop: { rtCongruentMs: 0.3, rtIncongruentMs: 1.2, interferenceMs: 1.6, errorRate: 0.2 },
  'follow-dot': { meanErrorPct: 1.2, onTargetPct: -0.8, overCorrectionsPerMin: 2.1 },
};
const result = (id: ActivityId, withZ: boolean): ActivityResult => ({
  activity: id, startedAt: Date.now() - 60000, durationS: activityById(id).durationS, completed: true, metrics: SAMPLE[id], vsBaseline: withZ ? Z[id] ?? null : null,
});
const meta = (id: ActivityId): Meta => { const d = activityById(id); return { id, name: d.name, job: d.job, durationS: d.durationS, device: d.device, blurb: d.blurb ?? '' }; };

// ---------- a synthetic finished session ----------
function demoSession(): { s: StressSession; beats: Beat[] } {
  const T0 = Date.now() - 600000;
  const beats: Beat[] = [];
  let t = T0, k = 0;
  while (t < T0 + 600000) {
    const s = (t - T0) / 1000;
    const base = s < 180 ? 71 : s < 420 ? 71 + 17 * (1 - Math.exp(-(s - 180) / 25)) : 71 + 17 * Math.exp(-(s - 420) / 45);
    const breath = s >= 420 ? 5 * Math.sin((2 * Math.PI * (s - 420)) / 10) : 1.5 * Math.sin(s / 1.7);
    const hr = base + breath + 1.2 * Math.sin(k++ * 0.9);
    const rr = 60000 / hr;
    t += rr;
    beats.push({ t: Math.round(t), rr, hr: Math.round(hr) });
  }
  const run = (id: ActivityId, m: Record<string, number>): ActivityResult => ({ activity: id, startedAt: T0, durationS: 30, completed: true, metrics: m, vsBaseline: null });
  const phases: StressSession['phases'] = [
    { name: 'rest', startedAt: T0, endedAt: T0 + 180000, activities: [run('follow-dot', { meanErrorPct: 3.4, onTargetPct: 63, overCorrectionsPerMin: 7 })] },
    { name: 'challenge', startedAt: T0 + 180000, endedAt: T0 + 420000, activities: [run('stroop', SAMPLE.stroop), run('follow-dot', { meanErrorPct: 4.6, onTargetPct: 51, overCorrectionsPerMin: 11 }), run('beat-the-clock', SAMPLE['beat-the-clock'])] },
    { name: 'recovery', startedAt: T0 + 420000, endedAt: T0 + 600000, activities: [run('paced-breathing', SAMPLE['paced-breathing'])] },
  ];
  const series = sessionSeries(beats, T0, 'ble-hr');
  const n = summaryNumbers({ phases, series });
  return { beats, s: { id: 'demo', createdAt: T0, phases, series, aborted: false, summary: { hrRise: n.hrRise, recoveryHalfTimeS: n.recoveryHalfTimeS, text: summaryText(n, { phases, aborted: false }, 'Polar H10') } } };
}

// ---------- views ----------
const Page = (p: { title: string; children: VNode | VNode[] }) => (
  <main class="pg" id="pg-main">
    <h1 class="pg-crumb"><a href="?v=index">Playground</a> · {p.title}</h1>
    {p.children}
  </main>
);

function withLive(conn: FakeConnection) { liveStore.set(conn); return conn; }

const views: Record<string, () => VNode> = {
  'devices-empty': () => <Page title="Devices, nothing connected"><DevicesPanel inputs={[btOk, camOk, ...files]} onImport={log('import')} /></Page>,
  'devices-connected': () => { withLive(new FakeConnection()); return <Page title="Devices, strap connected"><DevicesPanel inputs={[btOk, camOk, ...files]} /></Page>; },
  'devices-unavailable': () => <Page title="Devices, no Web Bluetooth (iPhone Safari, Firefox)"><DevicesPanel inputs={[btNo, cameraPlaceholder, ...files]} /></Page>,
  'devices-states': () => {
    const rec = new FakeConnection({ device: 'Garmin HRM-Pro 41822', hasRR: true, battery: 64 });
    rec.simulate({ state: 'reconnecting', attempt: 2, message: 'Lost Garmin HRM-Pro 41822. Reconnecting…' });
    const gone = new FakeConnection({ device: 'Forerunner 265', hasRR: false, battery: null });
    void gone.disconnect().then(() => gone.simulate({ message: 'Forerunner 265 went out of range. Bring it closer and connect again.' }));
    return (
      <Page title="Devices, link states">
        <div class="ax dv">
          <section><h2 class="ax-kicker dv-h">Connecting</h2><ul class="dv-list"><BluetoothRow provider={btOk} avail={{ ok: true }} state={{ kind: 'connecting' }} connected={false} onConnect={noop} /></ul></section>
          <section><h2 class="ax-kicker dv-h">Permission denied</h2><ul class="dv-list"><BluetoothRow provider={btOk} avail={{ ok: true }} state={{ kind: 'error', name: 'NotAllowedError', message: 'Bluetooth permission was blocked. Allow Bluetooth for this site in the browser’s site settings, then try again.' }} connected={false} onConnect={noop} /></ul></section>
          <section><h2 class="ax-kicker dv-h">Bluetooth off</h2><ul class="dv-list"><BluetoothRow provider={btOk} avail={{ ok: false, reason: 'Bluetooth is turned off or this computer has no Bluetooth adapter. Turn it on in your system settings and try again.' }} state={{ kind: 'idle' }} connected={false} onConnect={noop} /><CameraRow provider={camOk} avail={{ ok: true }} /></ul></section>
          <section><h2 class="ax-kicker dv-h">Reconnecting</h2><LiveCard conn={rec} onDisconnect={noop} /></section>
          <section><h2 class="ax-kicker dv-h">Disconnected</h2><LiveCard conn={gone} onDisconnect={noop} onReconnect={noop} /></section>
        </div>
      </Page>
    );
  },
  'devices-import': () => (
    <Page title="Devices, file imports">
      <div class="ax dv"><section><h2 class="ax-kicker dv-h">Import a file</h2><ul class="dv-list">
        <ImportRow provider={appleHealth} state={{ kind: 'reading', fraction: 0.42, fileName: 'export.zip' }} onFile={noop} />
        <ImportRow provider={fitbit} state={{ kind: 'done', fileName: 'takeout-20260930.zip', summary: 'Fitbit: 41,208 heart-rate minutes and 1,012 overnight HRV readings from 2 Jul 2026 to 30 Sept 2026. Resting heart rate on 88 days.' }} onFile={noop} />
        <ImportRow provider={empaticaE4} state={{ kind: 'error', message: 'No Empatica E4 files were found. Use the session zip from E4 connect (it contains EDA.csv, TEMP.csv, IBI.csv and others).' }} onFile={noop} />
      </ul></section></div>
    </Page>
  ),
  picker: () => <Page title="Activities"><ActivityPicker onPick={log('pick')} onSession={noop} isPhone={matchMedia('(pointer: coarse)').matches} liveDevice="Polar H10 8C4F21A0" calmRuns={[result('typing', false), result('typing', false), result('follow-dot', false)]} /></Page>,
  'session-intro': () => <Page title="Stress session"><StressSessionView onDone={log('session')} onCancel={noop} live={new FakeConnection()} /></Page>,
  'session-rest': () => <Page title="Stress session, rest"><StressSessionView onDone={log('session')} onCancel={noop} live={new FakeConnection({ history: 60 })} startAt={0} /></Page>,
  'session-challenge': () => <Page title="Stress session, challenge"><StressSessionView onDone={log('session')} onCancel={noop} live={new FakeConnection({ base: 84, history: 60 })} startAt={2} /></Page>,
  'session-summary': () => { const d = demoSession(); return <Page title="Stress session, summary"><SessionSummary session={d.s} beats={d.beats} onSave={noop} onDiscard={noop} /></Page>; },
  'session-summary-nodevice': () => { const d = demoSession(); const n = summaryNumbers({ phases: d.s.phases, series: null }); return <Page title="Stress session, no device"><SessionSummary session={{ ...d.s, series: null, summary: { hrRise: null, recoveryHalfTimeS: null, text: summaryText(n, { phases: d.s.phases, aborted: false }, null) } }} beats={[]} onSave={noop} onDiscard={noop} /></Page>; },
};
for (const a of ACTIVITIES) {
  const C = a.Component as (p: RunProps) => VNode;
  const live = a.id === 'paced-breathing' ? new FakeConnection({ history: 5 }) : undefined;
  views[`${a.id}-start`] = () => <Page title={`${a.name}, start`}><C onDone={log('done')} onCancel={noop} live={live} seed={7} /></Page>;
  views[`${a.id}-run`] = () => <Page title={`${a.name}, running`}><C onDone={log('done')} onCancel={noop} live={live} seed={7} autoStart /></Page>;
  views[`${a.id}-done`] = () => <Page title={`${a.name}, result`}><ResultView meta={meta(a.id)} result={result(a.id, !!Z[a.id])} calmCount={Z[a.id] ? 3 : 1} onDone={noop} /></Page>;
}

function Index() {
  const groups: Record<string, string[]> = {
    Devices: Object.keys(views).filter((k) => k.startsWith('devices')),
    Activities: ['picker', ...ACTIVITIES.flatMap((a) => [`${a.id}-start`, `${a.id}-run`, `${a.id}-done`])],
    Session: Object.keys(views).filter((k) => k.startsWith('session')),
  };
  return (
    <main class="pg" id="pg-main">
      <h1 class="ax-title">Inputs playground</h1>
      <p class="ax-small">Dev only. Add <code>&amp;theme=dark</code> to any view.</p>
      {Object.entries(groups).map(([g, ks]) => (
        <section key={g}><h2 class="ax-kicker">{g}</h2><ul class="pg-list">{ks.map((k) => <li key={k}><a href={`?v=${k}`}>{k}</a></li>)}</ul></section>
      ))}
    </main>
  );
}

export const VIEWS = Object.keys(views);
render(view === 'index' ? <Index /> : (views[view] ?? Index)(), document.getElementById('app')!);
