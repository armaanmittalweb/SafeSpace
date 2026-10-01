// Colour words (Stroop) and Beat the clock (adaptive mental arithmetic).
import { finite, mean, median, rng, round } from '../stats';

// ---------- Stroop ----------

export const INKS = ['red', 'green', 'blue', 'yellow'] as const;
export type Ink = (typeof INKS)[number];
export interface StroopTrial { word: Ink; ink: Ink; congruent: boolean }
export interface StroopResponse { trial: StroopTrial; rtMs: number | null; answer: Ink | null }

/** Half congruent, half not, never the same word twice in a row. */
export function stroopTrials(seed: number, n: number): StroopTrial[] {
  const r = rng(seed);
  const pick = () => INKS[Math.floor(r() * 4)];
  const out: StroopTrial[] = [];
  for (let i = 0; i < n; i++) {
    const congruent = r() < 0.5;
    let word = pick();
    while (out.length && out[out.length - 1].word === word) word = pick();
    let ink = word;
    if (!congruent) while (ink === word) ink = pick();
    out.push({ word, ink, congruent });
  }
  return out;
}

/** How long a word stays up before it counts as missed. */
export const STROOP_TIMEOUT_MS = 2500;

export function stroopMetrics(rs: readonly StroopResponse[]): Record<string, number> {
  if (!rs.length) return {};
  const ok = (r: StroopResponse) => r.answer === r.trial.ink && r.rtMs != null;
  const rt = (c: boolean) => rs.filter((r) => r.trial.congruent === c && ok(r)).map((r) => r.rtMs as number);
  const con = median(rt(true)), inc = median(rt(false));
  const answered = rs.filter((r) => r.answer != null);
  const wrong = answered.filter((r) => r.answer !== r.trial.ink).length;
  const incErrors = rs.filter((r) => !r.trial.congruent && r.answer != null && r.answer !== r.trial.ink).length;
  return finite({
    trials: rs.length,
    rtCongruentMs: round(con),
    rtIncongruentMs: round(inc),
    interferenceMs: round(inc - con),
    errorRate: answered.length ? round(wrong / answered.length, 3) : NaN,
    incongruentErrors: incErrors,
    missed: rs.length - answered.length,
  });
}

// ---------- Beat the clock ----------

export interface Problem { text: string; answer: number; level: number }

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 10;

/** Problems get harder with level: bigger numbers, then subtraction with borrowing, then products. */
export function makeProblem(level: number, r: () => number): Problem {
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  let a: number, b: number, op: '+' | '−' | '×';
  switch (level) {
    case 1: a = int(2, 9); b = int(2, 9); op = '+'; break;
    case 2: a = int(11, 49); b = int(2, 9); op = r() < 0.5 ? '+' : '−'; break;
    case 3: a = int(12, 59); b = int(11, 39); op = '+'; break;
    case 4: a = int(31, 99); b = int(12, 29); op = '−'; break;
    case 5: a = int(3, 9); b = int(12, 19); op = '×'; break;
    case 6: a = int(45, 99); b = int(26, 89); op = '+'; break;
    case 7: a = int(101, 199); b = int(17, 89); op = '−'; break;
    case 8: a = int(6, 9); b = int(21, 49); op = '×'; break;
    case 9: a = int(201, 499); b = int(67, 189); op = '−'; break;
    default: a = int(12, 19); b = int(12, 19); op = '×';
  }
  if (op === '−' && b > a) [a, b] = [b, a];
  const answer = op === '+' ? a + b : op === '−' ? a - b : a * b;
  return { text: `${a} ${op} ${b}`, answer, level };
}

/** Seconds allowed per problem at a level. */
export const timeLimitS = (level: number) => Math.max(5, 11 - Math.floor(level / 2));

/**
 * One-up one-down staircase: right -> one level harder, wrong or out of time -> one level
 * easier. A 1-up-1-down staircase settles where right and wrong are equally likely, i.e.
 * about half right, which is the point: challenging, never hopeless.
 */
export class Staircase {
  level: number;
  history: { level: number; correct: boolean; rtMs: number | null; timedOut: boolean }[] = [];
  constructor(start = 2) { this.level = start; }
  record(correct: boolean, rtMs: number | null, timedOut = false) {
    this.history.push({ level: this.level, correct, rtMs, timedOut });
    this.level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, this.level + (correct ? 1 : -1)));
  }
}

export function clockMetrics(s: Staircase, stoppedEarly: boolean): Record<string, number> {
  const h = s.history;
  if (!h.length) return { problems: 0, stoppedEarly: stoppedEarly ? 1 : 0 };
  const correct = h.filter((x) => x.correct);
  return finite({
    problems: h.length,
    accuracy: round(correct.length / h.length, 3),
    meanRtMs: round(mean(correct.map((x) => x.rtMs as number))),
    meanLevel: round(mean(h.map((x) => x.level)), 2),
    finalLevel: s.level,
    timeouts: h.filter((x) => x.timedOut).length,
    stoppedEarly: stoppedEarly ? 1 : 0,
  });
}
