import { MODELS, type Channel, type Feature } from '../model/score';

export interface FeatureUi { label: string; unit: string; min: number; max: number; step: number; digits: number }

const unit = (f: Feature) => {
  for (const s of Object.values(MODELS.signals)) {
    const hit = s.features.find((x) => x.name === f);
    if (hit) return hit.unit;
  }
  return '';
};

/** Labels and slider ranges in natural units. Ranges cover resting and stressed values. */
export const FEATURE_UI: Record<Feature, FeatureUi> = {
  hr_mean: { label: 'Heart rate', unit: unit('hr_mean'), min: 40, max: 150, step: 1, digits: 0 },
  rmssd: { label: 'RMSSD', unit: unit('rmssd'), min: 5, max: 150, step: 1, digits: 0 },
  sdnn: { label: 'SDNN', unit: unit('sdnn'), min: 10, max: 180, step: 1, digits: 0 },
  eda_tonic: { label: 'Tonic level', unit: unit('eda_tonic'), min: 0.05, max: 8, step: 0.05, digits: 2 },
  eda_slope: { label: 'Tonic slope', unit: unit('eda_slope'), min: -0.5, max: 0.5, step: 0.01, digits: 2 },
  scr_count: { label: 'SCR rate', unit: '/min', min: 0, max: 20, step: 1, digits: 0 },
  scr_amp: { label: 'SCR amplitude', unit: unit('scr_amp'), min: 0, max: 0.3, step: 0.005, digits: 3 },
  temp_mean: { label: 'Skin temp', unit: unit('temp_mean'), min: 26, max: 37, step: 0.05, digits: 2 },
  temp_slope: { label: 'Temp slope', unit: unit('temp_slope'), min: -0.3, max: 0.3, step: 0.01, digits: 2 },
};

export const CHANNEL_LABEL = (c: Channel) => (c === 'acc_std' ? 'Wrist motion' : FEATURE_UI[c].label);
