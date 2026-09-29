"""Compute the per-window feature table for all subjects.

Usage:
    python training/build_features.py --data ../datasets/wesad_wrist --out training/cache/features.csv
"""
import argparse
import csv
import os

import numpy as np

from features import subject_windows

SUBJECTS = [f"S{k}" for k in list(range(2, 12)) + list(range(13, 18))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    rows = []
    for s in SUBJECTS:
        d = np.load(os.path.join(args.data, f"{s}.npz"))
        d = {k: d[k] for k in d.files}
        rs = subject_windows(d)
        for r in rs:
            r["subject"] = s
        rows += rs
        lab = np.array([r["label3"] for r in rs])
        hrv = np.array([r["hrv_valid"] for r in rs])
        hr = np.array([r["hr_valid"] for r in rs])
        print(f"{s}: {len(rs)} windows  base={np.sum(lab == 1)} stress={np.sum(lab == 2)} "
              f"amuse={np.sum(lab == 3)}  hr_valid={hr.mean():.2f} hrv_valid={hrv.mean():.2f}", flush=True)
    keys = ["subject"] + [k for k in rows[0] if k != "subject"]
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: (int(v) if isinstance(v, (bool, np.bool_)) else v) for k, v in r.items()})
    print(f"wrote {len(rows)} rows -> {args.out}")


if __name__ == "__main__":
    main()
