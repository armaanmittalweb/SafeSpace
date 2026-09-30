import { MODELS, type Channel, type Signal } from '../model/score';

export type PresetId = 'rest' | 'speaking' | 'amusement' | 'walking';

export interface Preset {
  id: PresetId;
  name: string;
  /** Upper-case event mark written along the top of the paper. */
  mark: string;
  blurb: string;
  /** Where the numbers come from, shown in the builder. */
  source: string;
  /** Shift of each channel's level from the resting baseline, in natural units. */
  shift: Partial<Record<Channel, number>>;
  /** Multiplier on the resting window-to-window noise. */
  noise: number;
  /** Share of windows with enough clean beats for HR and for HRV. */
  valid: Record<Extract<Signal, 'hr' | 'hrv'>, number>;
}

const T = MODELS.typical.shift;
const V = MODELS.motion;

export const PRESETS: Record<PresetId, Preset> = {
  rest: {
    id: 'rest',
    name: 'Rest',
    mark: 'REST',
    blurb: 'Sitting still, reading. Every value hovers around the baseline you set.',
    source: 'Your baseline plus resting noise.',
    shift: {},
    noise: 1,
    valid: { hr: V.hr_valid_frac.baseline, hrv: V.hrv_valid_frac.baseline },
  },
  speaking: {
    id: 'speaking',
    name: 'Public speaking',
    mark: 'SPEAKING',
    blurb: 'A TSST-like stressor: a speech to a panel, then mental arithmetic. Heart rate and sweat responses climb, hands cool.',
    source: 'Shifts are the WESAD medians for the stress condition.',
    shift: { ...T.stress },
    noise: 1.4,
    valid: { hr: V.hr_valid_frac.stress, hrv: V.hrv_valid_frac.stress },
  },
  amusement: {
    id: 'amusement',
    name: 'Amusement',
    mark: 'AMUSEMENT',
    blurb: 'A funny video: mild arousal. In WESAD it barely moves heart rate or skin conductance.',
    source: 'Shifts are the WESAD medians for the amusement condition.',
    shift: { ...T.amusement },
    noise: 1.1,
    valid: { hr: V.hr_valid_frac.amusement, hrv: V.hrv_valid_frac.amusement },
  },
  walking: {
    id: 'walking',
    name: 'Walking',
    mark: 'WALKING',
    blurb: 'The motion confound: heart rate climbs with little change in skin conductance, and the fused score can read as stress.',
    source: 'Hand-set, not from WESAD (it has no walking condition).',
    // Brisk walking: heart rate up ~25 bpm, HRV down, sweat barely changes, hands cool a
    // little, the wrist moves a lot. Chosen from general physiology, not fitted.
    shift: {
      hr_mean: 25, rmssd: -15, sdnn: -10,
      eda_tonic: 0.08, eda_slope: 0.02, scr_count: 0.5, scr_amp: 0.004,
      temp_mean: -0.1, temp_slope: -0.03,
      acc_std: 0.15,
    },
    noise: 1.3,
    valid: { hr: 0.85, hrv: 0.2 },
  },
};

export const PRESET_ORDER: PresetId[] = ['rest', 'speaking', 'amusement', 'walking'];
