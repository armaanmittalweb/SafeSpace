"""Write the browser's copy of the v2 models: web/src/model/models.json.

The four models are logistic regressions on calibrated (z-scored) features, so the
browser needs only their coefficients and intercepts: p = sigmoid(w . z + b). This
script copies them from the model card, checks them against the ONNX files, and adds
what the web app needs to simulate and explain a session:

  * feature order, units and SD floors (from the card)
  * typical resting values: for each feature, the median across the 15 subjects of the
    subject's rest5 mean and rest5 SD (the same windows the rest5 calibration uses)
  * typical condition shifts: for each feature, the median across subjects of
    (median value in the condition - rest5 mean), for WESAD stress and amusement
  * headline LOSO metrics and limitations (from the card)

Only these summary constants leave the feature cache; no per-window data is written.
If cache/features.csv is absent, the constants already in models.json are kept.

With --fixtures it also writes web/src/model/parity.fixtures.json: random calibrated
feature vectors (not WESAD data) and the stress probabilities onnxruntime computes for
them from models_v2/*.onnx. The web test suite checks the TypeScript scorer against them.

Usage (from training/):
    python export_web.py --card ../models_v2/model_card.json --models ../models_v2 \
        --features cache/features.csv --out ../web/src/model/models.json --fixtures
"""
import argparse
import json
import os

import numpy as np

import features as F

UNIT_DISPLAY = {"uS": "µS", "uS/min": "µS/min", "degC": "°C", "degC/min": "°C/min"}
WEAK_REASON = {
    "hrv": "Wrist PPG loses beats under motion, so HRV is missing or noisy when it matters.",
    "temp": "Slow, and tracks the room and clothing as much as stress.",
}


def round_sig(x, n=5):
    return float(f"{x:.{n}g}")


def summary_constants(features_csv):
    import pipeline as P  # needs scikit-learn; only imported when the cache is used

    t = P.load_table(features_csv)
    ref = P.reference_mask(t, "rest5")
    feats = [f for fs in F.SIGNALS.values() for f in fs] + ["acc_std"]
    rest, shift = {}, {"stress": {}, "amusement": {}}
    for f in feats:
        mus, sds, d = [], [], {2: [], 3: []}
        for s in np.unique(t["subject"]):
            m = t["subject"] == s
            v = t[f][m & ref]
            v = v[np.isfinite(v)]
            if len(v) < 2:
                continue
            mu = float(np.mean(v))
            mus.append(mu)
            sds.append(float(np.std(v, ddof=1)))
            for c in (2, 3):
                w = t[f][m & ~ref & (t["label3"] == c)]
                w = w[np.isfinite(w)]
                if len(w):
                    d[c].append(float(np.median(w)) - mu)
        rest[f] = {"mean": round_sig(np.median(mus)), "sd": round_sig(np.median(sds)),
                   "n_subjects": len(mus)}
        shift["stress"][f] = round_sig(np.median(d[2]))
        shift["amusement"][f] = round_sig(np.median(d[3]))
    return rest, shift


def onnx_coefficients(path):
    import onnx

    node = onnx.load(path).graph.node[0]
    a = {x.name: onnx.helper.get_attribute_value(x) for x in node.attribute}
    k = len(a["coefficients"]) // 2
    return np.array(a["coefficients"][k:]), float(a["intercepts"][1])


def write_fixtures(card, models_dir, out_path, n=64, seed=20260930):
    import onnxruntime as ort

    rng = np.random.default_rng(seed)
    fx = {"note": "Random calibrated feature vectors (not WESAD data) and the stress probability "
                  "onnxruntime returns for them from models_v2/*.onnx. Written by "
                  "training/export_web.py --fixtures.",
          "signals": {}}
    for sig, spec in card["signals"].items():
        k = len(spec["features"])
        # mostly ordinary z values, plus some large ones (stress windows reach z > 10)
        z = np.concatenate([rng.normal(0, 3, (n - 8, k)), rng.uniform(-25, 25, (8, k))])
        z = z.astype(np.float32)  # the ONNX input type; stored exactly below
        sess = ort.InferenceSession(os.path.join(models_dir, spec["onnx"]["file"]),
                                    providers=["CPUExecutionProvider"])
        names = [o.name for o in sess.get_outputs()]
        p = sess.run(None, {"input": z})[names.index("probabilities")][:, 1]
        fx["signals"][sig] = [{"z": [float(v) for v in row], "p": float(pv)} for row, pv in zip(z, p)]
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fx, f, indent=1)
    print(f"fixtures: {sum(len(v) for v in fx['signals'].values())} vectors -> {out_path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--card", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--features", default="cache/features.csv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fixtures", action="store_true")
    args = ap.parse_args()

    card = json.load(open(args.card, encoding="utf-8"))
    old = json.load(open(args.out, encoding="utf-8")) if os.path.exists(args.out) else None
    if os.path.exists(args.features):
        rest, shift = summary_constants(args.features)
    elif old:
        rest, shift = old["typical"]["rest"], old["typical"]["shift"]
        print("feature cache not found: keeping the typical values already in", args.out)
    else:
        raise SystemExit("need cache/features.csv (or an existing models.json) for the constants")

    def metrics(s):
        return {k: {"mean": round(s[k]["mean"], 4), "sd": round(s[k]["std"], 4),
                    "n_subjects": s[k]["n_subjects"]} for k in ("balanced_accuracy", "roc_auc", "macro_f1")}

    signals = {}
    for sig, spec in card["signals"].items():
        feats = [f["name"] for f in spec["features"]]
        w = np.array([spec["coefficients"][f] for f in feats])
        b = float(spec["intercept"])
        w32, b32 = onnx_coefficients(os.path.join(args.models, spec["onnx"]["file"]))
        assert np.allclose(w, w32, atol=1e-6) and abs(b - b32) < 1e-6, f"{sig}: card and ONNX disagree"
        signals[sig] = {
            "strength": spec["strength"],
            "weak_reason": WEAK_REASON.get(sig),
            "features": [{"name": f["name"], "unit": UNIT_DISPLAY.get(f["unit"], f["unit"]),
                          "sd_floor": f["sd_floor"], "coef": spec["coefficients"][f["name"]]}
                         for f in spec["features"]],
            "intercept": b,
            "C": spec["C"],
            "loso_rest5": metrics(spec["loso"]["rest5"]["summary"]),
            "subjects_below_chance": spec["subjects_below_chance"],
            "limitations": spec["limitations"],
        }

    fusion = card["fusion"]
    out = {
        "_generated_by": "training/export_web.py from models_v2/model_card.json (coefficients checked "
                         "against the ONNX files) and summary constants from training/cache/features.csv",
        "name": card["name"],
        "dataset": {k: card["dataset"][k] for k in ("name", "citation", "terms")}
                   | {"n_subjects": len(card["dataset"]["subjects"])},
        "window_s": card["windowing"]["window_s"],
        "stride_s": card["windowing"]["stride_s"],
        "calibration": {
            "method": "rest5",
            "rest_seconds": 300,
            "description": card["calibration"]["method"],
            "sd_floor": card["calibration"]["sd_floor"],
        },
        "score_mapping": card["score_mapping"],
        "fusion": {
            "method": fusion["method"],
            "loso_rest5": metrics(fusion["loso"]["rest5"]["summary"]),
            "by_condition_rest5": fusion["loso"]["rest5"]["by_condition"],
            "loso_none": metrics(fusion["loso"]["none"]["summary"]),
        },
        "motion": {
            "flag_rule_z": 3.0,
            "auc_motion_alone": round(card["motion_confound"]["auc_motion_for_stress_mean"], 3),
            "hrv_valid_frac": card["motion_confound"]["hrv_valid_frac_by_condition"],
            "hr_valid_frac": card["motion_confound"]["hr_valid_frac_by_condition"],
        },
        "hr_check_vs_ecg": {k: round(card["hr_extraction_check_vs_chest_ecg"][k], 3)
                            for k in ("hr_mae_bpm", "hr_corr", "rmssd_corr")},
        "typical": {
            "_how": "rest: median across the 15 subjects of each subject's rest5 mean and SD (first 5 min "
                    "of the WESAD baseline). shift: median across subjects of (median value in the "
                    "condition - rest5 mean). Computed by training/export_web.py from the local feature "
                    "cache; no per-window data is included.",
            "rest": rest,
            "shift": shift,
        },
        "limitations": card["limitations"],
        "signals": signals,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
    print(f"wrote {args.out} ({os.path.getsize(args.out)} B)")
    if args.fixtures:
        write_fixtures(card, args.models, os.path.join(os.path.dirname(args.out), "parity.fixtures.json"))


if __name__ == "__main__":
    main()
