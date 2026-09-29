"""Extract the wrist (Empatica E4) signals from WESAD into one small .npz per subject.

Reads each ``WESAD/S<k>/S<k>.pkl`` straight out of ``WESAD.zip`` (streamed, one subject
at a time, nothing big is written to disk), keeps only the wrist channels and the label
resampled to each wrist rate, and writes ``<out>/S<k>.npz`` plus ``<out>/meta.json``.
It also stores the chest-ECG R-peak times, used only as a reference to check the wrist
heart-rate extraction (never as a model input).

Usage:
    python training/extract_wesad.py --zip ../datasets/WESAD.zip --out ../datasets/wesad_wrist
"""
import argparse
import json
import os
import pickle
import re
import time
import zipfile

import numpy as np

SUBJECTS = [f"S{k}" for k in list(range(2, 12)) + list(range(13, 18))]
LABEL_FS = 700
WRIST_FS = {"BVP": 64, "EDA": 4, "TEMP": 4, "ACC": 32}


def resample_label_nearest(label, fs, n):
    """Label at the centre of each wrist sample (nearest 700 Hz sample)."""
    t = (np.arange(n) + 0.5) / fs
    idx = np.minimum((t * LABEL_FS).astype(np.int64), len(label) - 1)
    return label[idx].astype(np.int8)


def resample_label_majority(label, fs, n):
    """Majority label over each wrist sample's 700 Hz span (used for the 4 Hz timeline)."""
    edges = np.minimum(np.round(np.arange(n + 1) * LABEL_FS / fs).astype(np.int64), len(label))
    out = np.zeros(n, dtype=np.int8)
    for i in range(n):
        seg = label[edges[i]:edges[i + 1]]
        if len(seg):
            out[i] = np.bincount(seg).argmax()
    return out


def ecg_rpeaks(ecg, fs=LABEL_FS):
    """R-peak times (s) from the chest ECG. Kept only to validate the wrist heart-rate
    extraction; the chest signal itself is not stored and is never a model input."""
    from scipy.signal import butter, find_peaks, sosfiltfilt
    x = sosfiltfilt(butter(3, [5, 20], btype="bandpass", fs=fs, output="sos"), ecg.astype(np.float64))
    # choose polarity with the larger extreme excursions
    if np.percentile(-x, 99.5) > np.percentile(x, 99.5):
        x = -x
    peaks = []
    blk = 10 * fs  # adaptive height threshold per 10 s block
    for s in range(0, len(x), blk):
        seg = x[s:s + blk]
        if len(seg) < fs:
            continue
        thr = 0.4 * np.percentile(seg, 99.5)
        p, _ = find_peaks(seg, height=thr, distance=int(0.3 * fs))
        peaks.append(p + s)
    peaks = np.unique(np.concatenate(peaks)) if peaks else np.array([], dtype=np.int64)
    # drop duplicates across block edges
    if len(peaks) > 1:
        keep = np.r_[True, np.diff(peaks) >= int(0.3 * fs)]
        peaks = peaks[keep]
    return (peaks / fs).astype(np.float64)


def parse_readme(text):
    meta = {}
    for key, name in [("Age", "age"), ("Height (cm)", "height_cm"), ("Weight (kg)", "weight_kg"),
                      ("Gender", "gender"), ("Dominant hand", "dominant_hand")]:
        m = re.search(re.escape(key) + r":\s*(.+)", text)
        if m:
            v = m.group(1).strip()
            meta[name] = float(v) if name in ("age", "height_cm", "weight_kg") else v.lower()
    for key, name in [("Did you drink coffee today?", "coffee_today"),
                      ("Did you do any sports today?", "sports_today"),
                      ("Are you a smoker?", "smoker"),
                      ("Do you feel ill today?", "ill_today")]:
        m = re.search(re.escape(key) + r"\s*(\w+)", text)
        if m:
            meta[name] = m.group(1).upper() == "YES"
    notes = text.split("### Additional notes ###")
    meta["notes"] = notes[1].strip() if len(notes) > 1 else ""
    return meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--subjects", nargs="*", default=SUBJECTS)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    meta_path = os.path.join(args.out, "meta.json")
    all_meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}

    with zipfile.ZipFile(args.zip) as zf:
        for s in args.subjects:
            t0 = time.time()
            readme = zf.read(f"WESAD/{s}/{s}_readme.txt").decode("utf-8", "replace")
            with zf.open(f"WESAD/{s}/{s}.pkl") as f:
                d = pickle.load(f, encoding="latin1")
            assert d["subject"] == s, d["subject"]
            w = d["signal"]["wrist"]
            label = np.asarray(d["label"]).astype(np.int64)
            rpeaks = ecg_rpeaks(np.asarray(d["signal"]["chest"]["ECG"])[:, 0])
            del d  # drop the chest signals (the bulk of the pickle) straight away
            out = {}
            for ch, fs in WRIST_FS.items():
                x = np.asarray(w[ch], dtype=np.float32)
                if x.shape[1] == 1:
                    x = x[:, 0]
                out[ch] = x
                dur_sig, dur_lab = len(x) / fs, len(label) / LABEL_FS
                assert abs(dur_sig - dur_lab) < 1.0, (s, ch, dur_sig, dur_lab)
            out["label_4hz"] = resample_label_majority(label, 4, len(out["EDA"]))
            out["label_32hz"] = resample_label_nearest(label, 32, len(out["ACC"]))
            out["label_64hz"] = resample_label_nearest(label, 64, len(out["BVP"]))
            out["ecg_rpeaks_s"] = rpeaks  # validation reference only
            np.savez_compressed(os.path.join(args.out, f"{s}.npz"), **out)
            m = parse_readme(readme)
            m["duration_s"] = len(label) / LABEL_FS
            m["label_seconds"] = {int(k): round(float(v) / LABEL_FS, 1)
                                  for k, v in zip(*np.unique(label, return_counts=True))}
            all_meta[s] = m
            json.dump(all_meta, open(meta_path, "w"), indent=1)
            print(f"{s}: {m['duration_s']:.0f}s, labels(s)={m['label_seconds']}, "
                  f"{time.time() - t0:.0f}s elapsed", flush=True)


if __name__ == "__main__":
    main()
