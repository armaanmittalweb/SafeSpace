"""Check the wrist (BVP) heart-rate / HRV extraction against the chest-ECG reference.

For every labelled window, HR and HRV are computed from the wrist BVP (the model input)
and from the chest-ECG R-peaks (reference only), and compared.

Usage:
    python training/validate_hr.py --data ../datasets/wesad_wrist [--subjects S2 S5]
"""
import argparse
import json
import os

import numpy as np

import features as F

SUBJECTS = [f"S{k}" for k in list(range(2, 12)) + list(range(13, 18))]


def ecg_window(rpeaks, t0):
    r = rpeaks[(rpeaks >= t0) & (rpeaks < t0 + F.WIN_S)]
    if len(r) < 4:
        return F.ibi_features(np.array([]), np.array([], dtype=bool))
    ibi = np.diff(r)
    return F.ibi_features(ibi, F.clean_ibis(ibi))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--subjects", nargs="*", default=SUBJECTS)
    ap.add_argument("--out", default=None, help="optional JSON summary path")
    args = ap.parse_args()
    summary = {}
    allrows = []
    for s in args.subjects:
        d = np.load(os.path.join(args.data, f"{s}.npz"))
        lab4, bvp, rp = d["label_4hz"], d["BVP"], d["ecg_rpeaks_s"]
        rows = []
        for s4 in F.window_starts(len(lab4)):
            lab, frac = F.window_label(lab4[s4:s4 + int(F.WIN_S * 4)])
            if frac < F.MIN_LABEL_FRAC or lab not in F.KEEP_LABELS:
                continue
            t0 = s4 / 4.0
            w = F.bvp_features(bvp[int(t0 * 64):int(t0 * 64) + int(F.WIN_S * 64)])
            e = ecg_window(rp, t0)
            rows.append((lab, w["hr_valid"], w["hr_mean"], e["hr_mean"], w["hrv_valid"], w["rmssd"],
                         e["rmssd"], w["sdnn"], e["sdnn"], w["beat_coverage"]))
        a = np.array(rows, dtype=float)
        allrows.append(a)
        res = {}
        for lab in (0, 1, 2, 3):
            m = np.ones(len(a), bool) if lab == 0 else a[:, 0] == lab
            hv = m & (a[:, 1] == 1) & np.isfinite(a[:, 3])
            rv = m & (a[:, 4] == 1) & np.isfinite(a[:, 6])
            res["all" if lab == 0 else F.COND_NAMES[lab]] = dict(
                n=int(m.sum()), hr_valid_frac=float(np.mean(a[m, 1])),
                hr_mae_bpm=float(np.mean(np.abs(a[hv, 2] - a[hv, 3]))) if hv.any() else None,
                hrv_valid_frac=float(np.mean(a[m, 4])),
                rmssd_mae_ms=float(np.mean(np.abs(a[rv, 5] - a[rv, 6]))) if rv.any() else None,
                ecg_rmssd_median_ms=float(np.nanmedian(a[m, 6])),
            )
        summary[s] = res
        r = res["all"]
        print(f"{s}: HR valid {r['hr_valid_frac']:.2f} MAE {r['hr_mae_bpm']:.1f} bpm | "
              f"HRV valid {r['hrv_valid_frac']:.2f} RMSSD MAE {r['rmssd_mae_ms'] or float('nan'):.1f} ms "
              f"(ECG median {r['ecg_rmssd_median_ms']:.0f}) | stress: HR valid "
              f"{res['stress']['hr_valid_frac']:.2f} HRV valid {res['stress']['hrv_valid_frac']:.2f}",
              flush=True)
    a = np.vstack(allrows)
    hv = (a[:, 1] == 1) & np.isfinite(a[:, 3])
    rv = (a[:, 4] == 1) & np.isfinite(a[:, 6])
    pooled = dict(
        windows=int(len(a)),
        hr_valid_frac=float(a[:, 1].mean()), hrv_valid_frac=float(a[:, 4].mean()),
        hr_mae_bpm=float(np.mean(np.abs(a[hv, 2] - a[hv, 3]))),
        hr_within_5bpm=float(np.mean(np.abs(a[hv, 2] - a[hv, 3]) <= 5)),
        hr_corr=float(np.corrcoef(a[hv, 2], a[hv, 3])[0, 1]),
        rmssd_mae_ms=float(np.mean(np.abs(a[rv, 5] - a[rv, 6]))),
        rmssd_corr=float(np.corrcoef(a[rv, 5], a[rv, 6])[0, 1]),
        sdnn_corr=float(np.corrcoef(a[rv, 7], a[rv, 8])[0, 1]),
        by_condition={F.COND_NAMES[l]: dict(hr_valid_frac=float(a[a[:, 0] == l, 1].mean()),
                                            hrv_valid_frac=float(a[a[:, 0] == l, 4].mean()))
                      for l in (1, 2, 3)},
    )
    summary["pooled"] = pooled
    print(json.dumps(pooled, indent=1))
    if args.out:
        json.dump(summary, open(args.out, "w"), indent=1)


if __name__ == "__main__":
    main()
