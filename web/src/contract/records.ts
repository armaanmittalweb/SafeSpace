// Plaintext record shapes (they live inside the ciphertext) and the vault's wire types.
// Source of truth: docs/rebuild/contract.md. Change both together.

export type Signal = 'hr' | 'hrv' | 'eda' | 'temp';
export type InputSource = 'camera' | 'ble-hr' | 'polar-h10' | 'import-apple' | 'import-fitbit' | 'import-e4' | 'manual';
export type Quality = 'good' | 'fair' | 'poor';

export type FeatureName =
  | 'hr_mean' | 'rmssd' | 'sdnn'
  | 'eda_tonic' | 'eda_slope' | 'scr_count' | 'scr_amp'
  | 'temp_mean' | 'temp_slope' | 'acc_std';

/** RR intervals in ms; t0 = epoch ms of the first beat. */
export interface BeatSeries { t0: number; rr: number[] }

/** What any input produces for one window. */
export interface Measurement {
  source: InputSource;
  /** "Polar H10 A1B2C3D4", "Pixel 8 camera" */
  device: string | null;
  startedAt: number;
  durationS: number;
  quality: Quality;
  features: Partial<Record<FeatureName, number>>;
  /** Kept only when the user turns on "keep raw beats". */
  beats?: BeatSeries;
  motion?: { flagged: boolean; accStd: number | null };
}

export interface Baseline {
  id: string;
  createdAt: number;
  readings: Measurement[];
  /** calibrate.ts over the readings; n = readings on distinct days (or rest windows). Ready when n >= 3. */
  calibration: { mean: Record<string, number>; sd: Record<string, number>; n: number };
}

export interface Contribution { feature: string; z: number; coef: number; value: number }

export interface CheckIn {
  id: string;
  createdAt: number;
  /** null when only an activity or self-report was done */
  measurement: Measurement | null;
  activities: ActivityResult[];
  score: {
    fused: number | null;
    bySignal: Partial<Record<Signal, { score: number; contributions: Contribution[] }>>;
    baselineId: string | null;
  } | null;
  /** very calm … very tense */
  feeling: 1 | 2 | 3 | 4 | 5 | null;
  /** "before exam", "after gym" */
  tags: string[];
  note: string | null;
  narration: { text: string; source: 'template' | 'llm'; model?: string } | null;
}

export type ActivityId =
  | 'typing' | 'follow-dot' | 'target-taps' | 'stroop'
  | 'beat-the-clock' | 'paced-breathing' | 'steady-hand' | 'tap-rhythm';

export interface ActivityResult {
  activity: ActivityId;
  startedAt: number;
  durationS: number;
  completed: boolean;
  /** per activity, documented in web/src/activities/README.md */
  metrics: Record<string, number>;
  /** z against the user's calm runs of the same activity */
  vsBaseline: Record<string, number> | null;
}

export interface StressSession {
  id: string;
  createdAt: number;
  phases: { name: 'rest' | 'challenge' | 'recovery'; startedAt: number; endedAt: number; activities: ActivityResult[] }[];
  /** [t (s from start), value] */
  series: { source: InputSource; hr: [number, number][]; rmssd: [number, number][] } | null;
  summary: { hrRise: number | null; recoveryHalfTimeS: number | null; text: string };
  aborted: boolean;
}

/** Trained in the browser from the user's own sessions. */
export interface PersonalModel {
  activity: ActivityId;
  features: string[];
  coef: number[];
  intercept: number;
  trainedOn: number;
  heldOut: { balancedAccuracy: number; n: number };
  /** held-out balanced accuracy >= 0.7 on >= 6 windows */
  ready: boolean;
}

export interface NarrationFacts {
  fused: number | null;
  bySignal: Partial<Record<Signal, number>>;
  hr: number | null;
  restingHr: number | null;
  rmssd: number | null;
  feeling: number | null;
  tags: string[];
  activities: { id: ActivityId; change: string }[];
}

/** kind 'settings': one record per user, id 'settings'. (Amendment: shape added by the app agent.) */
export interface UserSettings {
  keepRawBeats: boolean;
  aiNotes: boolean;
}
export const DEFAULT_SETTINGS: UserSettings = { keepRawBeats: false, aiNotes: false };

// ---- vault wire types ----

export type RecordKind = 'checkin' | 'session' | 'baseline' | 'personal-model' | 'import' | 'settings';
export interface Me { user: { id: string; email: string; createdAt: string } }
export interface SealedRecord { id: string; kind: RecordKind; iv: string; ct: string; version: number; updatedAt: string; deleted: boolean }
export type ApiErrorCode =
  | 'bad_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict'
  | 'rate_limited' | 'too_large' | 'unavailable' | 'server';
export interface ApiError { error: string; code: ApiErrorCode }
/** GET /api/auth/sessions, as in EduSched. */
export interface SessionInfo { id: string; current: boolean; userAgent: string | null; createdAt: string; lastSeenAt: string }
