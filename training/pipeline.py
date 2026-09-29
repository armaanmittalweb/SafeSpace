"""Shared pieces for training/evaluation: loading the feature table, per-subject
calibration, the per-signal logistic regression with grouped C tuning, metrics."""
import csv

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import balanced_accuracy_score, f1_score, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

import features as F

C_GRID = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0]
REST_SECONDS = 300.0  # length of the "calibrate at rest" segment in the rest5 mode
EXTRA = ["acc_std"]
CAL_FEATURES = F.ALL_FEATURES + EXTRA


def load_table(path):
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    t = {}
    for k in rows[0]:
        if k == "subject":
            t[k] = np.array([r[k] for r in rows])
        else:
            t[k] = np.array([float(r[k]) for r in rows])
    for k in ("label3", "stress", "hr_valid", "hrv_valid"):
        t[k] = t[k].astype(int)
    return t


def reference_mask(t, mode):
    """Which windows of each subject define its calibration statistics.
    baseline: all baseline (label 1) windows.
    rest5   : only windows lying entirely in the first 5 min of the baseline condition,
              mimicking a short "calibrate at rest" step (these windows are then excluded
              from evaluation)."""
    base = t["label3"] == 1
    if mode == "baseline":
        return base
    if mode == "rest5":
        ref = np.zeros(len(base), bool)
        for s in np.unique(t["subject"]):
            m = (t["subject"] == s) & base
            t0 = t["t_start"][m].min()
            ref |= m & (t["t_start"] + F.WIN_S <= t0 + REST_SECONDS + 1e-9)
        return ref
    raise ValueError(mode)


def calibration_stats(values, floor):
    v = values[np.isfinite(values)]
    if len(v) == 0:
        return np.nan, np.nan
    sd = np.std(v, ddof=1) if len(v) > 1 else 0.0
    return float(np.mean(v)), float(max(sd, floor))


def calibrate(t, mode):
    """Returns (Z: dict feature->array, eval_mask, stats: {subject: {feature: (mean, sd)}}).
    mode 'none' returns the raw features (models then standardise with a global scaler)."""
    n = len(t["subject"])
    if mode == "none":
        return {f: t[f].copy() for f in CAL_FEATURES}, np.ones(n, bool), {}
    ref = reference_mask(t, mode)
    Z = {f: np.full(n, np.nan) for f in CAL_FEATURES}
    stats = {}
    for s in np.unique(t["subject"]):
        m = t["subject"] == s
        stats[s] = {}
        for f in CAL_FEATURES:
            mu, sd = calibration_stats(t[f][m & ref], F.STD_FLOOR[f])
            stats[s][f] = (mu, sd)
            Z[f][m] = (t[f][m] - mu) / sd
    eval_mask = np.ones(n, bool) if mode == "baseline" else ~ref
    return Z, eval_mask, stats


def signal_matrix(Z, signal):
    X = np.column_stack([Z[f] for f in F.SIGNALS[signal]])
    return X, np.all(np.isfinite(X), axis=1)


def make_lr(C, scale):
    lr = LogisticRegression(C=C, class_weight="balanced", max_iter=2000)
    return make_pipeline(StandardScaler(), lr) if scale else lr


def balanced_logloss(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    w = np.where(y == 1, 0.5 / max(np.mean(y == 1), 1e-9), 0.5 / max(np.mean(y == 0), 1e-9))
    return float(np.sum(w * -(y * np.log(p) + (1 - y) * np.log(1 - p))) / np.sum(w))


def tune_C(X, y, g, scale, grid=C_GRID):
    """Inner leave-one-subject-out over the training subjects; criterion = class-balanced
    log loss of the pooled out-of-fold probabilities (it rewards calibrated probabilities,
    which matter because the score is 2p-1). Returns (best C, OOF probs at best C, losses)."""
    subs = np.unique(g)
    losses, oofs = [], []
    for C in grid:
        oof = np.full(len(y), np.nan)
        for s in subs:
            tr, te = g != s, g == s
            if len(np.unique(y[tr])) < 2:
                continue
            oof[te] = make_lr(C, scale).fit(X[tr], y[tr]).predict_proba(X[te])[:, 1]
        ok = np.isfinite(oof)
        losses.append(balanced_logloss(y[ok], oof[ok]))
        oofs.append(oof)
    i = int(np.argmin(losses))
    return grid[i], oofs[i], losses


def lr_coefs(model):
    """Coefficients in the model's input units (for scaled pipelines: per global SD)."""
    lr = model[-1] if hasattr(model, "steps") else model
    return lr.coef_[0].tolist(), float(lr.intercept_[0])


def subject_metrics(y, p):
    out = dict(n=int(len(y)), n_pos=int(np.sum(y == 1)), n_neg=int(np.sum(y == 0)),
               balanced_accuracy=np.nan, macro_f1=np.nan, roc_auc=np.nan)
    if len(y) == 0:
        return out
    yhat = (p >= 0.5).astype(int)
    if len(np.unique(y)) == 2:
        out["balanced_accuracy"] = float(balanced_accuracy_score(y, yhat))
        out["roc_auc"] = float(roc_auc_score(y, p))
    out["macro_f1"] = float(f1_score(y, yhat, average="macro", labels=[0, 1], zero_division=0))
    return out


def summarize(per_subject):
    out = {}
    for k in ("balanced_accuracy", "macro_f1", "roc_auc"):
        v = np.array([m[k] for m in per_subject.values()], float)
        v = v[np.isfinite(v)]
        out[k] = dict(mean=float(np.mean(v)) if len(v) else None,
                      std=float(np.std(v)) if len(v) else None, n_subjects=int(len(v)))
    return out


def logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))
