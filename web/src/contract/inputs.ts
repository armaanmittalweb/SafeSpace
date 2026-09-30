// Shared types for inputs, activities, sessions and the personal model, copied verbatim
// from docs/rebuild/contract.md ("Plaintext record shapes" and "The input interface").
// If the app agent's web/src/contract/ lands with the same names, keep one copy.
import type { VNode } from 'preact';

export type Signal = 'hr' | 'hrv' | 'eda' | 'temp';
export type InputSource = 'camera' | 'ble-hr' | 'polar-h10' | 'import-apple' | 'import-fitbit' | 'import-e4' | 'manual';

export interface BeatSeries { t0: number; rr: number[] } // RR intervals in ms, t0 = epoch ms of the first beat

export type FeatureName =
  | 'hr_mean' | 'rmssd' | 'sdnn' | 'eda_tonic' | 'eda_slope' | 'scr_count' | 'scr_amp' | 'temp_mean' | 'temp_slope' | 'acc_std';

export interface Measurement {
  source: InputSource;
  device: string | null;
  startedAt: number; durationS: number;
  quality: 'good' | 'fair' | 'poor';
  features: Partial<Record<FeatureName, number>>;
  beats?: BeatSeries;
  motion?: { flagged: boolean; accStd: number | null };
}

export type ActivityId = 'typing' | 'follow-dot' | 'target-taps' | 'stroop' | 'beat-the-clock' | 'paced-breathing' | 'steady-hand' | 'tap-rhythm';

export interface ActivityResult {
  activity: ActivityId; startedAt: number; durationS: number; completed: boolean;
  metrics: Record<string, number>;
  vsBaseline: Record<string, number> | null;
}

export interface StressSession {
  id: string; createdAt: number;
  phases: { name: 'rest' | 'challenge' | 'recovery'; startedAt: number; endedAt: number; activities: ActivityResult[] }[];
  series: { source: InputSource; hr: [number, number][]; rmssd: [number, number][] } | null;
  summary: { hrRise: number | null; recoveryHalfTimeS: number | null; text: string };
  aborted: boolean;
}

export interface PersonalModel {
  activity: ActivityId; features: string[]; coef: number[]; intercept: number;
  trainedOn: number; heldOut: { balancedAccuracy: number; n: number }; ready: boolean;
}

export type Quality = 'good' | 'fair' | 'poor';

export interface InputProvider {
  id: InputSource;
  label: string;
  gives: Signal[];
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
}
export interface LiveInput extends InputProvider {
  connect(): Promise<LiveConnection>;
}
export interface LiveConnection {
  device: string;
  onBeat(cb: (beat: { t: number; rr: number | null; hr: number }) => void): () => void;
  onQuality(cb: (q: Quality, why: string | null) => void): () => void;
  measure(durationS: number, signal?: AbortSignal): Promise<Measurement>;
  disconnect(): Promise<void>;
}
export interface FileInput extends InputProvider {
  accept: string;
  parse(file: File, onProgress?: (fraction: number) => void): Promise<{ measurements: Measurement[]; summary: string }>;
}

export interface ActivityProps {
  onDone(r: ActivityResult): void;
  onCancel(): void;
  live?: LiveConnection;
}
export interface ActivityDef {
  id: ActivityId;
  name: string;
  job: 'baseline' | 'check-in' | 'challenge' | 'recovery';
  durationS: number;
  device: 'keyboard' | 'pointer' | 'phone' | 'any';
  Component: (props: ActivityProps) => VNode;
}
