# SafeSpace v2 models: training on WESAD wrist signals

This folder retrains SafeSpace's stress models as one small, explainable model per signal ("pen"). It uses the wrist signals (Empatica E4) from WESAD and evaluates with leave-one-subject-out (LOSO) cross-validation. The old scripts and `models/` are left as they were. The new models are in `../models_v2/`, and `../models_v2/model_card.json` holds every number quoted here.

## Pipeline

| Step | Script | Output |
|---|---|---|
| 1. Extract wrist BVP/EDA/TEMP/ACC, labels at each wrist rate, subject metadata, and chest-ECG R-peak times (used only to check the wrist heart rate) | `extract_wesad.py` | `../../datasets/wesad_wrist/S<k>.npz`, `meta.json` (not in git) |
| 2. Check wrist HR/HRV against chest ECG | `validate_hr.py` | `results/hr_validation.json` |
| 3. 60 s windows, 15 s stride, per-window features | `build_features.py` (uses `features.py`) | `cache/features.csv` (not in git) |
| 4. LOSO evaluation: per-signal LR vs depth-3 XGBoost, two fusion methods, three calibration modes | `train_eval.py` (uses `pipeline.py`) | `results/loso_results.json`, `loso_per_subject.csv`, `train_eval_log.txt` |
| 5. Refit on all subjects, export ONNX, check parity, write the model card and demo sessions | `export_models.py` | `../models_v2/*.onnx`, `model_card.json`, `demo_sessions/*.json` |

## Reproduce

You need Python 3.10 with numpy, scipy, scikit-learn 1.7, xgboost, onnx, onnxruntime and skl2onnx. You also need `WESAD.zip` in `../../datasets/`; it is not included. Run from `training/`:

```
python extract_wesad.py --zip ../../datasets/WESAD.zip --out ../../datasets/wesad_wrist
python validate_hr.py   --data ../../datasets/wesad_wrist --out results/hr_validation.json
python build_features.py --data ../../datasets/wesad_wrist --out cache/features.csv
python train_eval.py    --features cache/features.csv --out results
python export_models.py --features cache/features.csv --results results --models ../models_v2 --demo demo_sessions
```

Extraction streams one subject's pickle at a time straight out of the zip, so nothing large is written to disk. It takes about 20 s per subject, and the LOSO run takes about 4 minutes.

## Method (short)

- **Windows:** a window is kept if at least 80% of it has one label: baseline (1), stress (2) or amusement (3). Target: stress = 1; baseline and amusement = 0. That gives 2103 windows across 15 subjects, about 76 baseline, 42 stress and 22 amusement per subject.
- **Pens and features:**
  - `hr`: mean heart rate.
  - `hrv`: RMSSD and SDNN. pNN50 is computed but not modelled because its coefficient came out backwards.
  - `eda`: tonic level, tonic slope, SCR count and SCR amplitude.
  - `temp`: mean and slope.
  - Motion (ACC magnitude SD) is not a pen. It is reported as a confound and used as an artifact flag.
- **Beat detection:** band-pass, then `find_peaks`, then each beat is timed at the steepest point of its upstroke, then IBIs pass artifact rejection. Against chest ECG, wrist HR is off by 2.4 bpm on average and r = 0.96. Wrist RMSSD correlates at r = 0.78 but reads about 20 ms high.
- **Calibration at rest:** each feature is z-scored per person against their own resting windows, with a fixed SD floor per feature.
  - The headline mode is **rest5**: statistics come from the first 5 minutes of rest, and those windows are then excluded from training and scoring. This is what the browser demo does: it asks the user to sit still first and computes the same statistics from that segment.
  - `baseline` (the whole 20-minute rest) and `none` (no per-person calibration) are reported for comparison.
- **Models:** `LogisticRegression(class_weight='balanced')` per pen. C is tuned by an inner LOSO loop on class-balanced log loss. Depth-3 XGBoost was never clearly better, so LR was kept.
- **Score:** `2p - 1`, in the range [-1, +1].
- **Fusion:** `2*sigmoid(mean of logit(p) over the pens valid in the window) - 1`. This beat a stacked LR (fitted inside the LOSO loop without leakage) and has no parameters.
- **ONNX:** opset 17, input `input` (float32, [N, n_features], calibrated features), outputs `label` and `probabilities` ([N, 2], no ZipMap). Each file is under 0.5 KB, and the largest difference from sklearn is about 1e-7.

## LOSO results

Mean ± SD over the 15 held-out subjects (HRV: 12 subjects, since 3 have no valid stress windows). Values are balanced accuracy / ROC AUC.

| Pen | rest5 (headline) | baseline-cal | no calibration |
|---|---|---|---|
| hr | 0.81 ± 0.16 / 0.94 ± 0.11 | 0.86 / 0.94 | 0.77 / 0.94 |
| hrv (weak) | 0.56 ± 0.18 / 0.64 ± 0.29 | 0.62 / 0.64 | 0.59 / 0.64 |
| eda | 0.84 ± 0.19 / 0.96 ± 0.08 | 0.84 / 0.96 | 0.80 / 0.87 |
| temp (weak) | 0.65 ± 0.20 / 0.77 ± 0.27 | 0.67 / 0.76 | 0.75 / 0.78 |
| **fused** | **0.91 ± 0.12 / 0.997 ± 0.007** (macro F1 0.90) | 0.95 / 0.995 | 0.87 / 0.97 |

The rest5 fused score flags 90% of stress windows, 2% of baseline windows and 20% of amusement windows. Every fitted coefficient has the physiologically expected sign in every LOSO fold:
- HR, EDA level, EDA slope, SCR count and SCR amplitude push towards stress.
- RMSSD, SDNN, temperature and temperature slope push away from it.

## Limitations (read before demoing)

- **Small, specific sample:** 15 subjects (12 male, 3 female, aged 24–35), one lab session each, one wrist device (E4).
- **Lab stress only:** stress was induced by the Trier Social Stress Test (a public speech plus mental arithmetic). The models detect "TSST versus sitting quietly or watching funny clips". They say nothing about everyday or chronic stress, and they are not a medical device.
- **Motion is a confound:** during the TSST people stand, speak and gesture. Motion alone separates stress from non-stress with AUC of about 0.70. Motion is also what degrades wrist-PPG quality, and HR responds to posture and speaking as well as to stress.
- **HRV is weak:** only 35% of stress windows have enough clean beats, versus 92% at baseline. The fitted model is heavily regularised, so its score stays near 0 in every condition, and it is below chance for 5 of 12 subjects. It adds nothing measurable to the fused score. Show it as low-confidence or leave it out of the headline.
- **Temperature is weak:** it is slow and depends on the room, clothing and time since the device was put on. It flags about half of the amusement windows and is backwards for S14 and S16. Two subjects did the stress test in a colder room.
- **Calibration is required:** the numbers assume a clean resting segment at the start.
- **Protocol order:** WESAD always starts with the baseline, so drifts after putting the device on can be mistaken for condition effects.

## Data terms and citation

WESAD may be used for scientific, non-commercial purposes, with credit. Please cite:

> Schmidt, P., Reiss, A., Duerichen, R., Marberger, C., Van Laerhoven, K. "Introducing WESAD, a Multimodal Dataset for Wearable Stress and Affect Detection", ICMI 2018.

This repository contains no raw WESAD data: `.gitignore` excludes the zip, pickles, npz files and `cache/`.

## Demo sessions (publication pending)

`demo_sessions/S4.json`, `S10.json` and `S13.json` hold per-window timestamps, condition labels, raw and calibrated feature values, validity and motion flags, and each pen's score plus the fused score. There are two sets of scores: from the final models, and from held-out LOSO models that never saw that subject. **They contain no waveforms.** They are still derived from WESAD, and redistributing even derived data is not clearly covered by its terms. **Publishing these files is pending the owner's licence decision.**

These subjects were chosen because the HR, EDA, temperature and fused pens behave typically for them: LOSO AUC 0.9–1.0, and their readme notes mention nothing unusual. HRV is poor even for them (LOSO AUC 0.64, 0.30 and 0.36).
