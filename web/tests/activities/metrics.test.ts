import { describe, expect, it } from 'vitest';
import { breathAt, breathingMetrics, rhythmMetrics, tremorMetrics, BREATH_S } from '../../src/activities/body/metrics';
import { clockMetrics, makeProblem, Staircase, stroopMetrics, stroopTrials, MAX_LEVEL } from '../../src/activities/cognitive/metrics';
import { dotPath, followMetrics, tapMetrics, targetSequence, type TapTrial, type TrackSample } from '../../src/activities/pointer/metrics';
import { rng, vsCalm } from '../../src/activities/stats';
import { PASSAGES, TypingRecorder } from '../../src/activities/typing/metrics';
import type { ActivityResult } from '../../src/contract';

/** Types `text` into a recorder the way a browser reports it: down, input, up per key. */
function typeInto(rec: TypingRecorder, text: string, t0: number, gap = 180, hold = 90) {
  let value = '';
  let t = t0;
  for (const ch of text) {
    const code = ch === '\b' ? 'Backspace' : `Key${ch.toUpperCase()}`;
    rec.keyDown(code, t);
    value = ch === '\b' ? value.slice(0, -1) : value + ch;
    rec.input(value, t + 1);
    rec.keyUp(code, t + hold);
    t += gap;
  }
  return t;
}

describe('Typing check', () => {
  it('never keeps what was typed or which keys were pressed', () => {
    const passage = PASSAGES[0];
    const rec = new TypingRecorder(passage);
    // A distinctive wrong word, corrected, then the passage start.
    typeInto(rec, 'zebra quokka\b\b\b\b\b\b\b\b\b\b\b\b' + passage.slice(0, 40), 1000);
    const r = rec.result();
    const stored = JSON.stringify({ activity: 'typing', metrics: r });
    for (const secret of ['zebra', 'quokka', 'KeyZ', 'KeyQ', 'Backspace', passage.slice(0, 12)]) expect(stored).not.toContain(secret);
    // Every metric is a number, and no metric name is a character or a key code.
    for (const [k, v] of Object.entries(r)) {
      expect(typeof v).toBe('number');
      expect(k.length).toBeGreaterThan(2);
    }
    // Nothing that looks like a key identity is left inside the recorder either.
    expect(JSON.stringify(rec)).not.toMatch(/Key[A-Z]|Backspace|zebra/);
  });

  it('measures hold, flight, rhythm, errors and corrections', () => {
    const rec = new TypingRecorder('the cat sat');
    typeInto(rec, 'the cs\bat sat', 0, 200, 80);
    const r = rec.result();
    expect(rec.finished).toBe(true);
    expect(r.holdMeanMs).toBe(80);
    expect(r.flightMeanMs).toBe(120);
    expect(r.interKeyMeanMs).toBe(218.2); // gaps between inserted characters; the one across the correction is 400 ms
    expect(r.corrections).toBe(1);
    expect(r.errorRate).toBeCloseTo(1 / 12, 3); // "s" in place of "a"
    expect(r.pauses).toBe(0);
    expect(r.wpm).toBeGreaterThan(0);
  });

  it('counts pauses and keeps them out of the rhythm', () => {
    const rec = new TypingRecorder('abcdef');
    let t = typeInto(rec, 'abc', 0, 200);
    t += 3000;
    typeInto(rec, 'abcdef'.slice(3), t, 200);
    const r = rec.result();
    expect(r.pauses).toBe(1);
    expect(r.interKeyMeanMs).toBe(200);
  });
});

describe('Follow the dot', () => {
  it('stays inside the stage and is smooth', () => {
    const p = dotPath(3);
    for (let t = 0; t < 30; t += 0.1) {
      const q = p(t);
      expect(q.x).toBeGreaterThan(0.1); expect(q.x).toBeLessThan(0.9);
      expect(q.y).toBeGreaterThan(0.1); expect(q.y).toBeLessThan(0.9);
    }
    const a = p(10), b = p(10.016);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.01);
  });

  it('scores close tracking better than loose tracking', () => {
    const path = dotPath(1);
    const r = rng(9);
    const run = (lag: number, noise: number): TrackSample[] => Array.from({ length: 1800 }, (_, i) => {
      const t = i / 60;
      const d = path(t), l = path(Math.max(0, t - lag));
      return { t: i * 16.67, tx: d.x, ty: d.y, px: l.x + (r() - 0.5) * noise, py: l.y + (r() - 0.5) * noise };
    });
    const good = followMetrics(run(0.05, 0.01));
    const bad = followMetrics(run(0.4, 0.12));
    expect(good.meanErrorPct).toBeLessThan(bad.meanErrorPct);
    expect(good.onTargetPct).toBeGreaterThan(bad.onTargetPct);
    expect(good.jerk).toBeLessThan(bad.jerk);
    expect(bad.overCorrectionsPerMin).toBeGreaterThan(good.overCorrectionsPerMin);
  });
});

describe('Target taps', () => {
  it('builds targets far enough apart, inside the stage', () => {
    const ts = targetSequence(5, 20);
    for (const t of ts) { expect(t.x - t.r).toBeGreaterThan(0); expect(t.x + t.r).toBeLessThan(1); }
  });

  it('measures accuracy, time, hesitation, overshoot and throughput', () => {
    const target = { x: 0.8, y: 0.5, r: 0.05 };
    const start = { x: 0.2, y: 0.5 };
    const path = [];
    for (let i = 0; i <= 30; i++) path.push({ t: 1200 + i * 20, x: 0.2 + Math.min(i / 25, 1.12) * 0.6, y: 0.5 });
    path.push({ t: 1850, x: 0.81, y: 0.5 }); // comes back into the target
    const overshoot: TapTrial = { target, start, shownAt: 1000, path, tap: { t: 1900, x: 0.81, y: 0.5 }, pointer: 'mouse' };
    const miss: TapTrial = { ...overshoot, path: path.slice(0, 20), tap: { t: 1800, x: 0.6, y: 0.5 } };
    const touch: TapTrial = { ...overshoot, path: [], pointer: 'touch', tap: { t: 1500, x: 0.8, y: 0.52 } };
    const m = tapMetrics([overshoot, miss, touch]);
    expect(m.trials).toBe(3);
    expect(m.accuracyPct).toBeCloseTo(66.7, 1);
    expect(m.reactionMs).toBe(220);
    expect(m.overshootPct).toBe(50);
    expect(m.hesitationMs).toBeGreaterThan(0);
    expect(m.throughputBits).toBeGreaterThan(0);
  });
});

describe('Colour words', () => {
  it('balances congruent and incongruent trials', () => {
    const t = stroopTrials(1, 200);
    const c = t.filter((x) => x.congruent).length;
    expect(c).toBeGreaterThan(80); expect(c).toBeLessThan(120);
    expect(t.filter((x) => !x.congruent).every((x) => x.word !== x.ink)).toBe(true);
    expect(t.every((x, i) => i === 0 || x.word !== t[i - 1].word)).toBe(true);
  });

  it('measures interference and errors', () => {
    const trials = stroopTrials(2, 40);
    const rs = trials.map((trial, i) => ({ trial, rtMs: trial.congruent ? 600 : 750, answer: i === 3 ? (trial.ink === 'red' ? 'blue' as const : 'red' as const) : i === 5 ? null : trial.ink }));
    const m = stroopMetrics(rs);
    expect(m.interferenceMs).toBe(150);
    expect(m.missed).toBe(1);
    expect(m.errorRate).toBeCloseTo(1 / 39, 3);
  });
});

describe('Beat the clock', () => {
  it('makes correct problems at every level', () => {
    const r = rng(4);
    for (let l = 1; l <= MAX_LEVEL; l++) for (let i = 0; i < 50; i++) {
      const p = makeProblem(l, r);
      const [a, op, b] = p.text.split(' ');
      const x = +a, y = +b;
      expect(p.answer).toBe(op === '+' ? x + y : op === '−' ? x - y : x * y);
      expect(p.answer).toBeGreaterThanOrEqual(0);
    }
  });

  it('settles near half right for a simulated person', () => {
    const s = new Staircase(2);
    const r = rng(11);
    // A person who gets level L right with probability falling from 0.95 to 0.05 across levels.
    for (let i = 0; i < 400; i++) s.record(r() < 0.95 - (s.level - 1) * 0.1, 2000);
    const acc = s.history.slice(50).filter((h) => h.correct).length / (s.history.length - 50);
    expect(acc).toBeGreaterThan(0.42); expect(acc).toBeLessThan(0.58);
    const m = clockMetrics(s, false);
    expect(m.problems).toBe(400);
    expect(m.stoppedEarly).toBe(0);
  });
});

describe('Paced breathing', () => {
  it('follows six breaths a minute', () => {
    expect(BREATH_S).toBe(10);
    expect(breathAt(0)).toMatchObject({ phase: 'in', fill: 0 });
    expect(breathAt(4).phase).toBe('out');
    expect(breathAt(4).fill).toBeCloseTo(1, 6);
    expect(breathAt(12).cycle).toBe(1);
  });

  it('measures RSA from beats that swing with breathing', () => {
    const beats = [];
    let t = 0;
    while (t < 60000) {
      const hr = 68 + 6 * Math.sin((2 * Math.PI * t) / 10000) - t / 20000;
      const rr = 60000 / hr;
      t += rr;
      beats.push({ t: 5000 + t, rr, hr: Math.round(hr) });
    }
    const m = breathingMetrics(beats, 5000, 60, 60);
    expect(m.breaths).toBe(6);
    expect(m.rsaBpm).toBeGreaterThan(10);
    expect(m.rsaBpm).toBeLessThan(13);
    expect(m.hrChange).toBeLessThan(0);
    expect(breathingMetrics([], 0, 180, 90)).toEqual({ breaths: 9, completedPct: 50 });
  });
});

describe('Steady hand', () => {
  it('finds a 9 Hz tremor and ranks shaking above stillness', () => {
    const mk = (amp: number) => Array.from({ length: 1200 }, (_, i) => {
      const t = i / 60;
      return { t: t * 1000, x: amp * Math.sin(2 * Math.PI * 9 * t), y: 0.2 * amp * Math.cos(2 * Math.PI * 9 * t), z: 0.01 * Math.sin(t) };
    });
    const still = tremorMetrics(mk(0.02));
    const shaky = tremorMetrics(mk(0.3));
    expect(shaky.peakHz).toBeCloseTo(9, 0);
    expect(shaky.bandShare).toBeGreaterThan(0.8);
    expect(shaky.rms).toBeGreaterThan(still.rms * 5);
  });
});

describe('Tap the rhythm', () => {
  it('measures asynchrony and drift', () => {
    const beats = Array.from({ length: 8 }, (_, i) => 1000 + i * 750);
    const paced = beats.map((b) => b - 30);
    const free: number[] = [];
    let t = 7000;
    for (let i = 0; i < 16; i++) { t += 700 - i * 5; free.push(t); }
    const m = rhythmMetrics(beats, paced, free);
    expect(m.asyncMeanMs).toBe(-30);
    expect(m.driftMsPerTap).toBeCloseTo(-5, 1);
    expect(m.tempoErrorPct).toBeLessThan(0);
  });
});

describe('vsCalm', () => {
  const run = (wpm: number, holdMeanMs: number): ActivityResult => ({ activity: 'typing', startedAt: 0, durationS: 45, completed: true, metrics: { wpm, holdMeanMs }, vsBaseline: null });
  it('needs two calm runs', () => {
    expect(vsCalm({ wpm: 40 }, [run(50, 100)], 'typing')).toBeNull();
  });
  it('gives z against calm runs with a 10% floor on the spread', () => {
    const z = vsCalm({ wpm: 40, holdMeanMs: 120 }, [run(50, 100), run(50, 100)], 'typing')!;
    expect(z.wpm).toBe(-2); // (40 - 50) / 5
    expect(z.holdMeanMs).toBe(2);
    expect(vsCalm({ wpm: 40 }, [run(50, 100), run(50, 100)], 'stroop')).toBeNull();
  });
});
