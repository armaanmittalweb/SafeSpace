// Scoring for the four per-signal logistic regressions.
//
// The exported ONNX files (models_v2/*.onnx) are LinearClassifier graphs, i.e. one dot
// product and a sigmoid each. The browser does the same arithmetic from models.json,
// which training/export_web.py writes from the model card; tests/score.test.ts checks
// the result against onnxruntime to within 1e-6.
import raw from './models.json';

export type Signal = 'hr' | 'hrv' | 'eda' | 'temp';
export type Feature =
  | 'hr_mean' | 'rmssd' | 'sdnn'
  | 'eda_tonic' | 'eda_slope' | 'scr_count' | 'scr_amp'
  | 'temp_mean' | 'temp_slope';
/** Model features plus wrist motion, which is simulated and flagged but never scored. */
export type Channel = Feature | 'acc_std';

export interface FeatureSpec { name: Feature; unit: string; sd_floor: number; coef: number }
interface Metric { mean: number; sd: number; n_subjects: number }
export interface SignalModel {
  strength: 'primary' | 'weak';
  weak_reason: string | null;
  features: FeatureSpec[];
  intercept: number;
  C: number;
  loso_rest5: { balanced_accuracy: Metric; roc_auc: Metric; macro_f1: Metric };
  subjects_below_chance: string[];
  limitations: string[];
}
export interface ModelsJson {
  name: string;
  dataset: { name: string; citation: string; terms: string; n_subjects: number };
  window_s: number;
  stride_s: number;
  calibration: { method: string; rest_seconds: number; description: string; sd_floor: Record<Channel | 'pnn50', number> };
  fusion: {
    method: string;
    loso_rest5: { balanced_accuracy: Metric; roc_auc: Metric; macro_f1: Metric };
    loso_none: { balanced_accuracy: Metric; roc_auc: Metric; macro_f1: Metric };
    by_condition_rest5: Record<'baseline' | 'stress' | 'amusement', { n: number; mean_score: number; frac_flagged: number }>;
  };
  motion: { flag_rule_z: number; auc_motion_alone: number; hrv_valid_frac: Record<string, number>; hr_valid_frac: Record<string, number> };
  hr_check_vs_ecg: { hr_mae_bpm: number; hr_corr: number; rmssd_corr: number };
  typical: {
    rest: Record<Channel, { mean: number; sd: number; n_subjects: number }>;
    shift: Record<'stress' | 'amusement', Record<Channel, number>>;
  };
  limitations: string[];
  signals: Record<Signal, SignalModel>;
}

export const MODELS = raw as unknown as ModelsJson;
/** Display order: the two strong pens first. */
export const SIGNALS: Signal[] = ['hr', 'eda', 'temp', 'hrv'];
export const FEATURES: Feature[] = SIGNALS.flatMap((s) => MODELS.signals[s].features.map((f) => f.name));
export const CHANNELS: Channel[] = [...FEATURES, 'acc_std'];

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** w . z + b for one signal; z in the model's feature order. */
export function logitOf(signal: Signal, z: readonly number[]): number {
  const m = MODELS.signals[signal];
  let acc = m.intercept;
  for (let i = 0; i < m.features.length; i++) acc += m.features[i].coef * z[i];
  return acc;
}

export const probabilityOf = (signal: Signal, z: readonly number[]) => sigmoid(logitOf(signal, z));
export const toScore = (p: number) => 2 * p - 1;

export interface Contribution { feature: Feature; z: number; coef: number; value: number }
export interface Reading {
  signal: Signal;
  logit: number;
  p: number;
  score: number;
  contributions: Contribution[];
}

export function readSignal(signal: Signal, z: Partial<Record<Feature, number>>): Reading {
  const m = MODELS.signals[signal];
  const zs = m.features.map((f) => z[f.name] ?? 0);
  const logit = logitOf(signal, zs);
  const p = sigmoid(logit);
  return {
    signal,
    logit,
    p,
    score: toScore(p),
    contributions: m.features.map((f, i) => ({ feature: f.name, z: zs[i], coef: f.coef, value: f.coef * zs[i] })),
  };
}

// The training pipeline clips p to [1e-6, 1 - 1e-6] before taking the logit for fusion.
const LOGIT_CLIP = Math.log((1 - 1e-6) / 1e-6);

export interface Fused { logit: number; p: number; score: number; n: number }

/** Fused score = 2 * sigmoid(mean of the per-signal logits) - 1, over the signals given. */
export function fuse(logits: readonly number[]): Fused | null {
  if (logits.length === 0) return null;
  let sum = 0;
  for (const l of logits) sum += Math.max(-LOGIT_CLIP, Math.min(LOGIT_CLIP, l));
  const logit = sum / logits.length;
  const p = sigmoid(logit);
  return { logit, p, score: toScore(p), n: logits.length };
}

export type ReadingSet = Record<Signal, Reading | null>;

export function fuseReadings(r: ReadingSet, included: Record<Signal, boolean>): Fused | null {
  const ls: number[] = [];
  for (const s of SIGNALS) {
    const x = r[s];
    if (x && included[s]) ls.push(x.logit);
  }
  return fuse(ls);
}
