"""Refit the per-signal models on all subjects, export ONNX, check parity, and write the
model card and the (derived-only) demo sessions.

Needs the outputs of build_features.py, validate_hr.py and train_eval.py.

Usage (from training/):
    python export_models.py --features cache/features.csv --results results \
        --models ../models_v2 --demo demo_sessions
"""
import argparse
import hashlib
import json
import os

import numpy as np
import onnx
import onnxruntime as ort
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType

import features as F
import pipeline as P

HEADLINE = "rest5"  # what the browser does: calibrate on a short resting segment
COMPARE = ["baseline", "none"]
FUSION = "mean_logit"
DEMO_SUBJECTS = ["S4", "S10", "S13"]
MOTION_FLAG_Z = 3.0
WEAK = {"hrv", "temp"}

LIMITATIONS_COMMON = [
    "15 WESAD subjects (12 male, 3 female, aged 24-35), one lab session each.",
    "Stress is lab-induced (Trier Social Stress Test: public speech + mental arithmetic); "
    "it says nothing about everyday or chronic stress.",
    "Non-stress = baseline (seated reading) and amusement (funny clips) only.",
    "One wrist device (Empatica E4). Other sensors differ in noise, rate and units.",
    "Needs a per-person 'calibrate at rest' segment; without it performance drops (loso.none).",
    "Motion is a confound: wrist movement alone separates stress from non-stress with AUC ~0.70, "
    "and it is what degrades PPG quality during the TSST. It is reported and used as an artifact "
    "flag only, never as a stress input.",
    "The WESAD protocol always starts with the baseline and for some subjects the stress test ran "
    "in a colder room (readme notes for S8, S16), so slow drifts can be confounded with condition.",
    "Not a medical device.",
]
LIMITATIONS = {
    "hr": ["Wrist-PPG HR is corrupted by movement; windows with < 40% clean beats are dropped "
           "(HR available in 90% of stress vs 98% of baseline windows).",
           "HR also rises with talking, standing and activity, all part of the TSST."],
    "hrv": ["WEAK SIGNAL. Wrist-PPG RMSSD/SDNN are noisy (vs chest ECG: RMSSD r=0.78, biased ~+20 ms).",
            "Only 35% of stress windows (vs 92% of baseline) have enough clean beats, so the pen is "
            "usually absent during stress and was trained on the cleanest stress windows; 3 subjects "
            "have no valid stress windows at all.",
            "Adds nothing measurable to the fused score (fused with vs without HRV within 0.003).",
            "pNN50 is reported but not modelled: its coefficient came out positive (backwards) "
            "alongside RMSSD and SDNN."],
    "eda": ["EDA level depends on skin contact, sweat, room temperature and time since the device "
            "was put on; calibration removes the person's offset, not drifts.",
            "Fixed SCR threshold (0.02 uS); very dry skin may show no SCRs."],
    "temp": ["WEAK SIGNAL. Slow, and driven by room temperature, clothing and time since the device "
             "was put on; it flags many amusement windows as stress and is backwards for some "
             "subjects (see subjects_below_chance). It tracks 'not at rest / different room' as much "
             "as stress."],
}


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def export_onnx(model, n_features, path):
    onx = convert_sklearn(model, initial_types=[("input", FloatTensorType([None, n_features]))],
                          target_opset=17, options={id(model): {"zipmap": False}})
    onnx.checker.check_model(onx)
    with open(path, "wb") as f:
        f.write(onx.SerializeToString())


def onnx_parity(model, X, path):
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    names = [o.name for o in sess.get_outputs()]
    proba = sess.run(None, {"input": X.astype(np.float32)})[names.index("probabilities")]
    return (float(np.max(np.abs(proba - model.predict_proba(X)))),
            [i.name for i in sess.get_inputs()], names, list(proba.shape))


def r4(v):
    return None if v is None or not np.isfinite(v) else round(float(v), 4)


def loso_block(L, sig, m):
    s = L[m]["signals"][sig]
    return {"summary": s["lr"]["summary"], "pooled_auc": s["lr"]["pooled_auc"],
            "by_condition": s["lr"]["by_condition"], "n_windows": s["n_windows"],
            "gradient_boosting_summary": s["xgb"]["summary"]}


def main():
    ap = argparse.ArgumentParser()
    for a in ("--features", "--results", "--models", "--demo"):
        ap.add_argument(a, required=True)
    args = ap.parse_args()
    os.makedirs(args.models, exist_ok=True)
    os.makedirs(args.demo, exist_ok=True)
    t = P.load_table(args.features)
    loso = json.load(open(os.path.join(args.results, "loso_results.json")))
    hrval = json.load(open(os.path.join(args.results, "hr_validation.json")))["pooled"]
    L = loso["modes"]
    Z, train_mask, stats = P.calibrate(t, HEADLINE)
    y, g = t["stress"], t["subject"]
    n = len(y)

    fu = lambda m: {k: v for k, v in L[m]["fusion"]["all"][FUSION].items() if k != "per_subject"}
    card = {
        "name": "SafeSpace per-signal stress models v2",
        "dataset": {
            "name": "WESAD, wrist (Empatica E4) signals only",
            "citation": "Schmidt, P., Reiss, A., Duerichen, R., Marberger, C., Van Laerhoven, K. "
                        "\"Introducing WESAD, a Multimodal Dataset for Wearable Stress and Affect "
                        "Detection\", ICMI 2018.",
            "terms": "Scientific, non-commercial purposes, with credit.",
            "subjects": loso["subjects"], "windows_per_subject": loso["windows_per_subject"],
        },
        "windowing": {"window_s": F.WIN_S, "stride_s": F.STRIDE_S,
                      "label_rule": ">= 80% of the window has one label in {1 baseline, 2 stress, 3 amusement}",
                      "target": "stress (2) = 1; baseline (1) and amusement (3) = 0"},
        "evaluation": "Leave-one-subject-out (LOSO); C tuned by inner LOSO on the training subjects "
                      "(class-balanced log loss). Metrics = mean/std over held-out subjects.",
        "calibration": {
            "headline": HEADLINE,
            "method": "per-subject z-score z = (x - rest_mean) / max(rest_sd, floor). rest_mean/rest_sd come "
                      "from the windows lying entirely in the first 5 min of the subject's resting (WESAD "
                      "baseline) segment; those windows are excluded from training and scoring. The browser "
                      "demo does the same with a resting segment recorded first.",
            "comparisons": {"baseline": "rest statistics from the whole ~20 min baseline (its windows are "
                                        "also scored, so optimistic)",
                            "none": "raw features, global standardisation, no per-person calibration"},
            "sd_floor": {f: F.STD_FLOOR[f] for f in P.CAL_FEATURES},
            "onnx_input": "CALIBRATED features, in the order listed per signal",
        },
        "preprocessing": {
            "bvp": "64 Hz; band-pass 0.7-3.5 Hz (Butterworth order 3, zero-phase) per window; find_peaks "
                   "(distance 0.33 s, prominence >= 0.3 x IQR); beat time = steepest upstroke within 0.25 s "
                   "before each peak; IBIs kept if 0.33-1.5 s, within 30% of the window median, and for "
                   "adjacent pairs changing > 25% the one farther from the median is dropped. HR valid if "
                   "clean beats >= 40% of expected, HRV valid if >= 60% and >= 10 successive differences.",
            "eda": "4 Hz; 1 Hz low-pass; tonic = 0.05 Hz low-pass; phasic = smoothed - tonic; SCR = phasic "
                   "peak with prominence >= 0.02 uS, >= 1 s apart.",
            "temp": "4 Hz; window mean and least-squares slope.",
            "acc": "32 Hz; std of the 3-axis magnitude in g. Artifact flag only.",
        },
        "score_mapping": "score = 2p - 1 in [-1, +1], p = probabilities[:, 1]. No other calibration.",
        "fusion": {
            "method": "p = sigmoid(mean of logit(p_s) over the signals valid in the window); score = 2p - 1",
            "signals": list(F.SIGNALS),
            "why": "Better than a stacked logistic regression (fitted without leakage) in every "
                   "calibration mode, and has no parameters.",
            "loso": {HEADLINE: fu(HEADLINE), **{m: fu(m) for m in COMPARE}},
            "loso_per_subject": L[HEADLINE]["fusion"]["all"][FUSION]["per_subject"],
            "stacked_lr_comparison": {m: L[m]["fusion"]["all"]["stacked_lr"]["summary"] for m in L},
        },
        "hr_extraction_check_vs_chest_ecg": hrval,
        "motion_confound": {k: v for k, v in loso["motion"].items()
                            if k != "auc_motion_for_stress_per_subject"},
        "limitations": LIMITATIONS_COMMON,
        "signals": {},
    }

    final_p = {}
    parity = {}
    for sig, feats in F.SIGNALS.items():
        X, valid = P.signal_matrix(Z, sig)
        rows = valid & train_mask
        C, _, _ = P.tune_C(X[rows], y[rows], g[rows], scale=False)
        model = P.make_lr(C, scale=False).fit(X[rows], y[rows])
        path = os.path.join(args.models, f"{sig}.onnx")
        export_onnx(model, len(feats), path)
        diff, ins, outs, shape = onnx_parity(model, X[rows], path)
        parity[sig] = diff
        p = np.full(n, np.nan)
        p[valid] = model.predict_proba(X[valid])[:, 1]
        final_p[sig] = p
        coef, icpt = P.lr_coefs(model)
        per_sub = L[HEADLINE]["signals"][sig]["lr"]["per_subject"]
        card["signals"][sig] = {
            "strength": "weak" if sig in WEAK else "primary",
            "onnx": {"file": f"{sig}.onnx", "bytes": os.path.getsize(path), "sha256": sha256(path),
                     "opset": 17, "inputs": ins, "input_type": f"float32 [N, {len(feats)}]",
                     "outputs": outs, "probabilities_shape_on_training_set": shape,
                     "parity_max_abs_diff_vs_sklearn": diff},
            "features": [{"name": f, "unit": F.UNITS[f], "sd_floor": F.STD_FLOOR[f]} for f in feats],
            "model": "LogisticRegression(class_weight='balanced')", "C": C,
            "coefficients": dict(zip(feats, coef)), "intercept": icpt,
            "coefficient_meaning": "change in log-odds of stress per +1 resting SD of the feature",
            "sign_check": {f: {"coefficient": c, "expected_sign": F.EXPECTED_SIGN[f],
                               "matches_physiology": bool(np.sign(c) == F.EXPECTED_SIGN[f]),
                               "loso_folds_matching": L[HEADLINE]["signals"][sig]["lr"]["sign_match_frac"][f]}
                           for f, c in zip(feats, coef)},
            "n_windows": int(rows.sum()), "n_stress_windows": int(y[rows].sum()),
            "n_subjects": int(len(np.unique(g[rows]))),
            "loso": {HEADLINE: loso_block(L, sig, HEADLINE), **{m: loso_block(L, sig, m) for m in COMPARE}},
            "loso_per_subject": per_sub,
            "subjects_below_chance": sorted(k for k, v in per_sub.items()
                                            if v["roc_auc"] is not None and v["roc_auc"] < 0.5),
            "why_logistic_regression": "Depth-3 XGBoost was not clearly better in LOSO; LR is explainable "
                                       "and tiny.",
            "limitations": LIMITATIONS[sig],
        }
        print(f"{sig}: C={C} coef={np.round(coef, 3).tolist()} b={icpt:.3f} {os.path.getsize(path)} B "
              f"parity {diff:.2e} {ins}->{outs} {shape}")
    card["signals"]["hrv"]["reported_not_modelled"] = {"pnn50": loso["hrv_ablation"]}
    json.dump(card, open(os.path.join(args.models, "model_card.json"), "w"), indent=1)

    # ---- demo sessions: derived features and scores only, no waveforms ----
    lp = np.load(os.path.join(args.results, "..", "cache", "loso_probs.npz"))
    sigs = list(F.SIGNALS)
    loso_p = {s: lp[f"{HEADLINE}__{s}"] for s in sigs}

    def fuse(pd, i):
        ls = [P.logit(pd[s][i]) for s in sigs if np.isfinite(pd[s][i])]
        return float(2 * P.sigmoid(np.mean(ls)) - 1) if ls else None

    names = [f for fs in F.SIGNALS.values() for f in fs] + ["pnn50", "acc_std"]
    for s in DEMO_SUBJECTS:
        wins = []
        for i in np.flatnonzero(g == s):
            za = Z["acc_std"][i]
            wins.append({
                "t_start_s": float(t["t_start"][i]), "t_end_s": float(t["t_start"][i] + F.WIN_S),
                "condition": F.COND_NAMES[int(t["label3"][i])], "stress_label": int(y[i]),
                "calibration_window": bool(not train_mask[i]),
                "features": {f: r4(t[f][i]) for f in names},
                "calibrated": {f: r4(Z[f][i]) for f in names},
                "valid": {"hr": bool(t["hr_valid"][i]), "hrv": bool(t["hrv_valid"][i]),
                          "eda": True, "temp": True},
                "motion_flag": bool(np.isfinite(za) and za > MOTION_FLAG_Z),
                "scores": {k: r4(2 * final_p[k][i] - 1) for k in sigs} | {"fused": r4(fuse(final_p, i))},
                "scores_held_out": {k: r4(2 * loso_p[k][i] - 1) for k in sigs} | {"fused": r4(fuse(loso_p, i))},
            })
        doc = {
            "subject": s,
            "source": "Derived from WESAD (Schmidt et al., ICMI 2018; scientific, non-commercial use with "
                      "credit). Per-window derived features and scores only; no raw signals.",
            "publication_status": "PENDING the owner's licence decision - do not publish yet.",
            "window_s": F.WIN_S, "stride_s": F.STRIDE_S,
            "time_origin": "seconds from the start of the subject's WESAD recording",
            "calibration": {"method": "z-score vs the first 5 min of this subject's resting segment "
                                      "(windows marked calibration_window)",
                            "rest_mean_sd": {f: [r4(stats[s][f][0]), r4(stats[s][f][1])] for f in names}},
            "scores_note": "scores: final models (trained on all 15 subjects incl. this one; reproducible with "
                           "models_v2/*.onnx on 'calibrated'). scores_held_out: LOSO models that never saw this "
                           "subject (null for calibration windows). score = 2p-1; fused = 2*sigmoid(mean logit "
                           "over valid signals)-1; null = signal invalid in that window.",
            "motion_flag_rule": f"calibrated acc_std > {MOTION_FLAG_Z}; artifact hint only",
            "loso_auc_this_subject": {k: L[HEADLINE]["signals"][k]["lr"]["per_subject"][s]["roc_auc"] for k in sigs}
                                     | {"fused": L[HEADLINE]["fusion"]["all"][FUSION]["per_subject"][s]["roc_auc"]},
            "windows": wins,
        }
        path = os.path.join(args.demo, f"{s}.json")
        json.dump(doc, open(path, "w"), indent=1, allow_nan=False)
        print(f"demo {s}: {len(wins)} windows, {os.path.getsize(path)} B, LOSO AUC {doc['loso_auc_this_subject']}")


if __name__ == "__main__":
    main()
