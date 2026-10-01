import type { Measurement } from '../contract';

export type ImportKind = 'import-apple' | 'import-fitbit' | 'import-e4';

/** One day of context from an import (not scored as momentary stress). */
export interface DailyContext {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  restingHr?: number;
  /** Overnight / daily RMSSD (Fitbit) or the day's mean SDNN (Apple), ms. */
  hrv?: number;
  hrvKind?: 'rmssd' | 'sdnn';
}

/** FileInput.parse's result plus an optional daily list (contract amendment, inputs agent). */
export interface ImportResult {
  measurements: Measurement[];
  summary: string;
  daily?: DailyContext[];
}

export interface ImportOptions {
  /** Keep only the last `days` days before the newest record (default 90). */
  days?: number;
  /** Hard cap on measurements returned, newest kept (default 20 000). */
  maxMeasurements?: number;
}

export const DEFAULT_DAYS = 90;
export const DEFAULT_MAX = 20000;

const DAY_MS = 86400000;

/** Applies the days / count limits; returns the kept list and how many were dropped. */
export function limit<T extends { startedAt: number }>(items: T[], opts: ImportOptions): { kept: T[]; dropped: number; from: number | null; to: number | null } {
  if (!items.length) return { kept: [], dropped: 0, from: null, to: null };
  items.sort((a, b) => a.startedAt - b.startedAt);
  const newest = items[items.length - 1].startedAt;
  const cutoff = newest - (opts.days ?? DEFAULT_DAYS) * DAY_MS;
  let kept = items.filter((m) => m.startedAt > cutoff);
  const max = opts.maxMeasurements ?? DEFAULT_MAX;
  if (kept.length > max) kept = kept.slice(kept.length - max);
  return { kept, dropped: items.length - kept.length, from: kept[0].startedAt, to: newest };
}

export const fmtInt = (n: number) => n.toLocaleString('en-GB');
export function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function plural(n: number, one: string, many = `${one}s`) { return `${fmtInt(n)} ${n === 1 ? one : many}`; }
