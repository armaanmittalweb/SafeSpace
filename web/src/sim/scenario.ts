// Scripted sessions. Everything here is simulated from the visitor's settings; no
// recorded data is used. The time step is the model's window stride (15 s): each tick the
// underlying level of every channel relaxes towards its target (baseline + the segment's
// shift) with a per-channel time constant, a 60 s window averages five ticks, and AR(1)
// noise scaled to the typical resting variability is added on top.
import { calibrate, zScores, type Calibration } from '../model/calibrate';
import {
  CHANNELS, MODELS, SIGNALS, fuseReadings, readSignal,
  type Channel, type Feature, type Fused, type ReadingSet, type Signal,
} from '../model/score';
import { PRESETS, type PresetId } from './presets';

export type Baseline = Record<Channel, number>;
export interface Segment { preset: PresetId; minutes: number }
export interface Scenario { baseline: Baseline; segments: Segment[]; seed: number }

export const CAL_MIN = MODELS.calibration.rest_seconds / 60; // 5
export const WIN_MIN = MODELS.window_s / 60; // 1
export const STEP_MIN = MODELS.stride_s / 60; // 0.25

/** Relaxation time constant of each channel, in minutes. */
const TAU: Record<Channel, number> = {
  hr_mean: 0.4, rmssd: 0.5, sdnn: 0.5,
  eda_tonic: 1.5, eda_slope: 0.5, scr_count: 0.4, scr_amp: 0.4,
  temp_mean: 3, temp_slope: 1, acc_std: 0.15,
};
const NONNEG: Channel[] = ['hr_mean', 'rmssd', 'sdnn', 'eda_tonic', 'scr_count', 'scr_amp', 'acc_std'];
const AR = 0.6; // window-to-window noise correlation (windows overlap by 45 s)

export const DEFAULT_BASELINE: Baseline = Object.fromEntries(
  CHANNELS.map((c) => [c, MODELS.typical.rest[c].mean]),
) as Baseline;

export const DEFAULT_SEGMENTS: Segment[] = [
  { preset: 'rest', minutes: 3 },
  { preset: 'speaking', minutes: 10 },
  { preset: 'rest', minutes: 5 },
  { preset: 'amusement', minutes: 5 },
  { preset: 'walking', minutes: 5 },
];

export const DEFAULT_SCENARIO: Scenario = { baseline: DEFAULT_BASELINE, segments: DEFAULT_SEGMENTS, seed: 7 };

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

export interface Span { preset: PresetId; start: number; end: number; calibration: boolean }
export interface Win {
  i: number;
  start: number;
  end: number;
  preset: PresetId;
  calibration: boolean;
  raw: Record<Channel, number>;
  valid: Record<Signal, boolean>;
  motion: boolean;
}
export interface Session {
  scenario: Scenario;
  total: number;
  spans: Span[];
  windows: Win[];
  calibration: Calibration;
  firstScored: number;
}

export function spansOf(segments: Segment[]): Span[] {
  const spans: Span[] = [{ preset: 'rest', start: 0, end: CAL_MIN, calibration: true }];
  let t = CAL_MIN;
  for (const s of segments) {
    const m = Math.max(1, Math.round(s.minutes));
    spans.push({ preset: s.preset, start: t, end: t + m, calibration: false });
    t += m;
  }
  return spans;
}

export function simulate(scenario: Scenario): Session {
  const spans = spansOf(scenario.segments);
  const total = spans[spans.length - 1].end;
  const rand = mulberry32(scenario.seed);
  const nTicks = Math.round(total / STEP_MIN) + 1;
  const presetAt = (t: number) => (spans.find((s) => t < s.end) ?? spans[spans.length - 1]).preset;

  // underlying levels, one per 15 s tick
  const level: Record<Channel, number[]> = {} as Record<Channel, number[]>;
  for (const c of CHANNELS) {
    const out = new Array<number>(nTicks);
    let x = scenario.baseline[c];
    const k = 1 - Math.exp(-STEP_MIN / TAU[c]);
    for (let j = 0; j < nTicks; j++) {
      const target = scenario.baseline[c] + (PRESETS[presetAt(j * STEP_MIN)].shift[c] ?? 0);
      if (j > 0) x += (target - x) * k;
      out[j] = x;
    }
    level[c] = out;
  }

  const perWin = Math.round(WIN_MIN / STEP_MIN); // 4 steps = 5 ticks per window
  const nWin = Math.round((total - WIN_MIN) / STEP_MIN) + 1;
  const noise: Record<Channel, number> = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
  const ok: Record<'hr' | 'hrv', boolean> = { hr: true, hrv: true };
  const windows: Win[] = [];
  for (let i = 0; i < nWin; i++) {
    const start = i * STEP_MIN;
    const end = start + WIN_MIN;
    const preset = presetAt(start + WIN_MIN / 2);
    const P = PRESETS[preset];
    const raw = {} as Record<Channel, number>;
    for (const c of CHANNELS) {
      let m = 0;
      for (let j = i; j <= i + perWin; j++) m += level[c][j];
      m /= perWin + 1;
      const sd = MODELS.typical.rest[c].sd * P.noise;
      noise[c] = AR * noise[c] + Math.sqrt(1 - AR * AR) * sd * gaussian(rand);
      let v = m + noise[c];
      if (NONNEG.includes(c)) v = Math.max(0, v);
      raw[c] = v;
    }
    raw.scr_count = Math.round(raw.scr_count); // SCRs are counted in a 60 s window
    if (raw.scr_count === 0) raw.scr_amp = 0;
    // Beat coverage switches in runs (a two-state Markov chain whose long-run share of
    // valid windows is the preset's rate), like PPG dropping out while someone moves.
    for (const s of ['hr', 'hrv'] as const) {
      const p = P.valid[s];
      const r = rand();
      ok[s] = ok[s] ? r >= 0.3 * (1 - p) : r < 0.3 * p;
    }
    windows.push({
      i, start, end, preset,
      calibration: end <= CAL_MIN + 1e-9,
      raw,
      valid: { hr: ok.hr, hrv: ok.hrv && ok.hr, eda: true, temp: true },
      motion: false,
    });
  }
  const calWins = windows.filter((w) => w.calibration);
  // Calibration uses every channel of the resting windows; HR/HRV only where beats were clean.
  const calibration = calibrate(calWins.map((w) => ({
    ...w.raw,
    hr_mean: w.valid.hr ? w.raw.hr_mean : NaN,
    rmssd: w.valid.hrv ? w.raw.rmssd : NaN,
    sdnn: w.valid.hrv ? w.raw.sdnn : NaN,
  })));
  for (const w of windows) {
    w.motion = (w.raw.acc_std - calibration.mean.acc_std) / calibration.sd.acc_std > MODELS.motion.flag_rule_z;
  }
  return { scenario, total, spans, windows, calibration, firstScored: calWins.length };
}

/** Per-signal readings for one window, with optional what-if values replacing the raw ones. */
export function readWindow(w: Win, cal: Calibration, edits?: Partial<Record<Feature, number>> | null): ReadingSet {
  const raw = edits ? { ...w.raw, ...edits } : w.raw;
  const z = zScores(raw, cal);
  const out = {} as ReadingSet;
  for (const s of SIGNALS) {
    const edited = !!edits && MODELS.signals[s].features.some((f) => f.name in edits);
    out[s] = w.calibration || !(w.valid[s] || edited) ? null : readSignal(s, z);
  }
  return out;
}

export function readSession(session: Session): ReadingSet[] {
  return session.windows.map((w) => readWindow(w, session.calibration));
}

export function fusedSeries(readings: ReadingSet[], included: Record<Signal, boolean>): (Fused | null)[] {
  return readings.map((r) => fuseReadings(r, included));
}

/** Index of the last window finished by time t (minutes), or -1. */
export function windowAt(session: Session, t: number): number {
  const i = Math.floor((t - WIN_MIN) / STEP_MIN + 1e-9);
  return Math.max(-1, Math.min(i, session.windows.length - 1));
}
