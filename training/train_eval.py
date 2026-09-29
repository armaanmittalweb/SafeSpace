"""Leave-one-subject-out evaluation of the per-signal models and the fused score.

For each calibration mode (baseline / none / rest5) and each signal:
  * logistic regression (class_weight='balanced'), C tuned by an inner leave-one-subject-out
    loop on the training subjects only;
  * a small gradient-boosted model (XGBoost, depth 3) for comparison.
Fusion (logistic-regression signals only):
  (a) mean of the per-signal logits over the signals available in the window;
  (b) a logistic regression on the per-signal probabilities, fitted on inner out-of-fold
      probabilities of the training subjects (no leakage from the test subject).

Usage:
    python training/train_eval.py --features training/cache/features.csv --out training/results
"""
import argparse
import csv
import json
import os
import time

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from xgboost import XGBClassifier

import features as F
import pipeline as P

FUSION_SIGNALS = ["hr", "hrv", "eda", "temp"]
FUSION_SUBSETS = {
    "all": ["hr", "hrv", "eda", "temp"],
    "hr+eda+temp": ["hr", "eda", "temp"],
    "hr+eda": ["hr", "eda"],
}
MODES = ["baseline", "none", "rest5"]


def xgb_model(y):
    pos = max(int(np.sum(y == 1)), 1)
    return XGBClassifier(n_estimators=150, max_depth=3, learning_rate=0.05, subsample=0.8,
                         colsample_bytree=1.0, min_child_weight=5, reg_lambda=1.0,
                         scale_pos_weight=np.sum(y == 0) / pos, n_jobs=4, verbosity=0,
                         eval_metric="logloss")


def per_subject_table(y, p, g, subjects):
    return {s: P.subject_metrics(y[g == s], p[g == s]) for s in subjects}


def run_mode(t, mode, subjects, log):
    n = len(t["subject"])
    Z, eval_mask, _ = P.calibrate(t, mode)
    scale = mode == "none"
    y_all, g_all = t["stress"], t["subject"]
    res = {"signals": {}, "fusion": {}}
    P_lr = {s: np.full(n, np.nan) for s in F.SIGNALS}
    P_xgb = {s: np.full(n, np.nan) for s in F.SIGNALS}
    inner_oof = {k: {s: np.full(n, np.nan) for s in F.SIGNALS} for k in subjects}

    for sig in F.SIGNALS:
        X, valid = P.signal_matrix(Z, sig)
        rows = valid & eval_mask
        idx = np.flatnonzero(rows)
        Xr, yr, gr = X[rows], y_all[rows], g_all[rows]
        chosen_C, coefs = {}, {}
        for k in subjects:
            tr, te = gr != k, gr == k
            C, oof, _ = P.tune_C(Xr[tr], yr[tr], gr[tr], scale)
            inner_oof[k][sig][idx[tr]] = oof
            m = P.make_lr(C, scale).fit(Xr[tr], yr[tr])
            chosen_C[k] = C
            coefs[k] = P.lr_coefs(m)
            if te.any():
                P_lr[sig][idx[te]] = m.predict_proba(Xr[te])[:, 1]
                xm = xgb_model(yr[tr]).fit(Xr[tr], yr[tr])
                P_xgb[sig][idx[te]] = xm.predict_proba(Xr[te])[:, 1]
        feats = F.SIGNALS[sig]
        sign_ok = {f: float(np.mean([np.sign(coefs[k][0][j]) == F.EXPECTED_SIGN[f] for k in subjects]))
                   for j, f in enumerate(feats)}
        lr_tab = per_subject_table(yr, P_lr[sig][rows], gr, subjects)
        xgb_tab = per_subject_table(yr, P_xgb[sig][rows], gr, subjects)
        # 3-way breakdown of the LOSO scores
        cond = {}
        for lab, name in F.COND_NAMES.items():
            mm = rows & (t["label3"] == lab)
            pp = P_lr[sig][mm]
            cond[name] = dict(n=int(mm.sum()), mean_score=float(np.mean(2 * pp - 1)) if mm.any() else None,
                              frac_flagged=float(np.mean(pp >= 0.5)) if mm.any() else None)
        res["signals"][sig] = dict(
            features=feats, n_windows=int(rows.sum()), n_stress=int(yr.sum()),
            n_subjects_with_windows=int(len(np.unique(gr))),
            lr=dict(summary=P.summarize(lr_tab), per_subject=lr_tab,
                    pooled_auc=float(roc_auc_score(yr, P_lr[sig][rows])),
                    C_per_fold=chosen_C, coef_per_fold={k: coefs[k] for k in subjects},
                    sign_match_frac=sign_ok, by_condition=cond),
            xgb=dict(summary=P.summarize(xgb_tab), per_subject=xgb_tab,
                     pooled_auc=float(roc_auc_score(yr, P_xgb[sig][rows]))),
        )
        s1, s2 = res["signals"][sig]["lr"]["summary"], res["signals"][sig]["xgb"]["summary"]
        log(f"[{mode}] {sig:5s} n={rows.sum():4d} LR  BA {s1['balanced_accuracy']['mean']:.3f}"
            f"+/-{s1['balanced_accuracy']['std']:.3f} F1 {s1['macro_f1']['mean']:.3f} AUC "
            f"{s1['roc_auc']['mean']:.3f}+/-{s1['roc_auc']['std']:.3f} (n={s1['roc_auc']['n_subjects']}) | XGB BA "
            f"{s2['balanced_accuracy']['mean']:.3f} F1 {s2['macro_f1']['mean']:.3f} AUC {s2['roc_auc']['mean']:.3f} | "
            f"signs {sign_ok}")

    # ---- fusion ----
    ev = eval_mask
    y, g = y_all[ev], g_all[ev]
    for name, sigs in FUSION_SUBSETS.items():
        L = np.column_stack([P.logit(P_lr[s][ev]) for s in sigs])
        avail = np.isfinite(L)
        mean_logit = np.where(avail, L, 0).sum(1) / np.maximum(avail.sum(1), 1)
        p_a = P.sigmoid(mean_logit)
        # (b) stacked LR on probabilities; missing signal -> 0.5
        p_b = np.full(ev.sum(), np.nan)
        stack_coefs = {}
        idx_ev = np.flatnonzero(ev)
        for k in subjects:
            trm = ev & (g_all != k)
            Xtr = np.column_stack([inner_oof[k][s][trm] for s in sigs])
            Xtr = np.where(np.isfinite(Xtr), Xtr, 0.5)
            st = LogisticRegression(C=1.0, class_weight="balanced", max_iter=2000).fit(Xtr, y_all[trm])
            stack_coefs[k] = P.lr_coefs(st)
            te = g == k
            Xte = np.column_stack([P_lr[s][idx_ev[te]] for s in sigs])
            Xte = np.where(np.isfinite(Xte), Xte, 0.5)
            p_b[te] = st.predict_proba(Xte)[:, 1]
        out = {}
        for tag, pf in (("mean_logit", p_a), ("stacked_lr", p_b)):
            tab = per_subject_table(y, pf, g, subjects)
            cond = {}
            for lab, cname in F.COND_NAMES.items():
                mm = t["label3"][ev] == lab
                cond[cname] = dict(n=int(mm.sum()), mean_score=float(np.mean(2 * pf[mm] - 1)),
                                   frac_flagged=float(np.mean(pf[mm] >= 0.5)))
            out[tag] = dict(summary=P.summarize(tab), per_subject=tab,
                            pooled_auc=float(roc_auc_score(y, pf)), by_condition=cond)
            s1 = out[tag]["summary"]
            log(f"[{mode}] fused {name:12s} {tag:10s} BA {s1['balanced_accuracy']['mean']:.3f}"
                f"+/-{s1['balanced_accuracy']['std']:.3f} F1 {s1['macro_f1']['mean']:.3f}"
                f"+/-{s1['macro_f1']['std']:.3f} AUC {s1['roc_auc']['mean']:.3f}+/-{s1['roc_auc']['std']:.3f}")
        out["stacked_lr"]["coef_per_fold"] = stack_coefs
        out["signals"] = sigs
        res["fusion"][name] = out
    res["n_eval_windows"] = int(ev.sum())
    probs = {s: P_lr[s] for s in F.SIGNALS}
    return res, probs


def hrv_ablation(t, log):
    """LOSO comparison of HRV feature sets (baseline calibration, logistic regression)."""
    Z, ev, _ = P.calibrate(t, "baseline")
    subjects = np.unique(t["subject"])
    out = {}
    for feats in (["rmssd", "sdnn", "pnn50"], ["rmssd", "sdnn"], ["rmssd"], ["sdnn"]):
        X = np.column_stack([Z[f] for f in feats])
        ok = np.all(np.isfinite(X), 1) & ev
        X, y, g = X[ok], t["stress"][ok], t["subject"][ok]
        p, signs = np.full(len(y), np.nan), []
        for k in subjects:
            tr, te = g != k, g == k
            C, _, _ = P.tune_C(X[tr], y[tr], g[tr], False)
            m = P.make_lr(C, False).fit(X[tr], y[tr])
            p[te] = m.predict_proba(X[te])[:, 1]
            signs.append(np.sign(m.coef_[0]))
        sm = P.summarize({k: P.subject_metrics(y[g == k], p[g == k]) for k in subjects})
        key = "+".join(feats)
        out[key] = dict(summary=sm, mean_coef_sign=np.mean(signs, 0).tolist())
        log(f"hrv ablation {key:18s} BA {sm['balanced_accuracy']['mean']:.3f} F1 {sm['macro_f1']['mean']:.3f} "
            f"AUC {sm['roc_auc']['mean']:.3f}+/-{sm['roc_auc']['std']:.3f} mean coef sign {np.mean(signs, 0)}")
    return out


def motion_report(t, log):
    """How motion (ACC magnitude std) relates to the stress label and to signal quality."""
    y, g, a = t["stress"], t["subject"], t["acc_std"]
    per_sub = {}
    for s in np.unique(g):
        m = g == s
        per_sub[s] = float(roc_auc_score(y[m], a[m]))
    by_cond = {name: dict(mean_g=float(np.mean(a[t["label3"] == l])),
                          median_g=float(np.median(a[t["label3"] == l]))) for l, name in F.COND_NAMES.items()}
    hv = t["hrv_valid"] == 1
    out = dict(
        auc_motion_for_stress_per_subject=per_sub,
        auc_motion_for_stress_mean=float(np.mean(list(per_sub.values()))),
        auc_motion_for_stress_pooled=float(roc_auc_score(y, a)),
        pointbiserial_r_pooled=float(np.corrcoef(a, y)[0, 1]),
        acc_std_by_condition=by_cond,
        acc_std_median_hrv_valid=float(np.median(a[hv])),
        acc_std_median_hrv_invalid=float(np.median(a[~hv])),
        corr_acc_std_vs_beat_coverage=float(np.corrcoef(a, t["beat_coverage"])[0, 1]),
        hrv_valid_frac_by_condition={name: float(np.mean(hv[t["label3"] == l])) for l, name in F.COND_NAMES.items()},
        hr_valid_frac_by_condition={name: float(np.mean(t["hr_valid"][t["label3"] == l])) for l, name in F.COND_NAMES.items()},
    )
    log(f"motion: AUC(acc_std -> stress) mean over subjects {out['auc_motion_for_stress_mean']:.3f}, pooled "
        f"{out['auc_motion_for_stress_pooled']:.3f}, r={out['pointbiserial_r_pooled']:.3f}; by condition {by_cond}; "
        f"median acc_std HRV-valid {out['acc_std_median_hrv_valid']:.4f} vs invalid {out['acc_std_median_hrv_invalid']:.4f}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    t = P.load_table(args.features)
    subjects = sorted(np.unique(t["subject"]), key=lambda s: int(s[1:]))
    lines = []

    def log(msg):
        print(msg, flush=True)
        lines.append(msg)

    t0 = time.time()
    results = {"subjects": subjects, "n_windows": int(len(t["subject"])),
               "windows_per_subject": {s: {F.COND_NAMES[l]: int(np.sum((t["subject"] == s) & (t["label3"] == l)))
                                           for l in F.COND_NAMES} for s in subjects},
               "motion": motion_report(t, log), "hrv_ablation": hrv_ablation(t, log), "modes": {}}
    all_probs = {}
    for mode in MODES:
        results["modes"][mode], all_probs[mode] = run_mode(t, mode, subjects, log)
    json.dump(results, open(os.path.join(args.out, "loso_results.json"), "w"), indent=1)
    # LOSO probabilities (for the demo sessions' held-out scores)
    np.savez_compressed(os.path.join(args.out, "..", "cache", "loso_probs.npz"),
                        **{f"{m}__{s}": all_probs[m][s] for m in MODES for s in F.SIGNALS})
    # per-subject CSV (baseline calibration, LR)
    with open(os.path.join(args.out, "loso_per_subject.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["mode", "model", "subject", "n", "n_stress", "balanced_accuracy", "macro_f1", "roc_auc"])
        for mode in MODES:
            r = results["modes"][mode]
            for sig in F.SIGNALS:
                for mk in ("lr", "xgb"):
                    for s, m in r["signals"][sig][mk]["per_subject"].items():
                        w.writerow([mode, f"{sig}:{mk}", s, m["n"], m["n_pos"], m["balanced_accuracy"],
                                    m["macro_f1"], m["roc_auc"]])
            for name, fu in r["fusion"].items():
                for tag in ("mean_logit", "stacked_lr"):
                    for s, m in fu[tag]["per_subject"].items():
                        w.writerow([mode, f"fused[{name}]:{tag}", s, m["n"], m["n_pos"], m["balanced_accuracy"],
                                    m["macro_f1"], m["roc_auc"]])
    with open(os.path.join(args.out, "train_eval_log.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
