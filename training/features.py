"""Windowing and per-signal feature extraction for the WESAD wrist (E4) signals.

Every feature is computed from one 60 s window only (no information from outside the
window), so the same code can run on a live 60 s buffer in the browser.

Signals ("pens") and features
    hr    : hr_mean (bpm)                          <- BVP 64 Hz
    hrv   : rmssd (ms), sdnn (ms)                  <- same inter-beat intervals
            (pnn50 is computed and reported but is not a model input: with RMSSD and
            SDNN in the model its coefficient came out positive, i.e. backwards)
    eda   : eda_tonic (uS), eda_slope (uS/min),
            scr_count (peaks/min), scr_amp (uS)    <- EDA 4 Hz
    temp  : temp_mean (degC), temp_slope (degC/min) <- TEMP 4 Hz
    motion: acc_std (g)  -- not a stress pen, artifact/confound flag only
"""
import numpy as np
from scipy.signal import butter, find_peaks, sosfiltfilt

WIN_S = 60.0
STRIDE_S = 15.0
MIN_LABEL_FRAC = 0.8
KEEP_LABELS = (1, 2, 3)  # baseline, stress, amusement
COND_NAMES = {1: "baseline", 2: "stress", 3: "amusement"}

FS = {"BVP": 64, "EDA": 4, "TEMP": 4, "ACC": 32}

# IBI artifact rejection
IBI_MIN, IBI_MAX = 0.33, 1.5      # s  (180 .. 40 bpm)
IBI_MAX_REL_CHANGE = 0.25         # successive-change limit
IBI_MAX_REL_MEDIAN = 0.30         # distance from the window's median IBI
HRV_MIN_COVERAGE = 0.60           # clean beats / expected beats for HRV to be valid
HR_MIN_COVERAGE = 0.40            # looser requirement for the mean heart rate
SCR_MIN_AMP = 0.02                # uS, minimum phasic peak prominence counted as an SCR

SIGNALS = {
    "hr": ["hr_mean"],
    "hrv": ["rmssd", "sdnn"],
    "eda": ["eda_tonic", "eda_slope", "scr_count", "scr_amp"],
    "temp": ["temp_mean", "temp_slope"],
}
UNITS = {
    "hr_mean": "bpm", "rmssd": "ms", "sdnn": "ms", "pnn50": "%",
    "eda_tonic": "uS", "eda_slope": "uS/min", "scr_count": "peaks/min", "scr_amp": "uS",
    "temp_mean": "degC", "temp_slope": "degC/min", "acc_std": "g",
}
# Expected sign of each feature's effect on stress probability (physiology prior)
EXPECTED_SIGN = {
    "hr_mean": +1, "rmssd": -1, "sdnn": -1, "pnn50": -1,
    "eda_tonic": +1, "eda_slope": +1, "scr_count": +1, "scr_amp": +1,
    "temp_mean": -1, "temp_slope": -1,
}
# Floors for the per-subject calibration std (avoid dividing by ~0, e.g. zero SCRs at rest).
STD_FLOOR = {
    "hr_mean": 1.0, "rmssd": 3.0, "sdnn": 3.0, "pnn50": 2.0,
    "eda_tonic": 0.05, "eda_slope": 0.02, "scr_count": 0.5, "scr_amp": 0.01,
    "temp_mean": 0.05, "temp_slope": 0.02, "acc_std": 0.005,
}
ALL_FEATURES = [f for fs in SIGNALS.values() for f in fs] + ["pnn50"]  # pnn50: reported only

_BVP_SOS = butter(3, [0.7, 3.5], btype="bandpass", fs=FS["BVP"], output="sos")
_EDA_SMOOTH_SOS = butter(2, 1.0, btype="lowpass", fs=FS["EDA"], output="sos")
_EDA_TONIC_SOS = butter(2, 0.05, btype="lowpass", fs=FS["EDA"], output="sos")


def _slope_per_min(x, fs):
    t = np.arange(len(x)) / fs / 60.0
    return float(np.polyfit(t, x, 1)[0])


def clean_ibis(ibi):
    """Artifact rejection. Returns a boolean mask of clean IBIs.
    1) physiological range, 2) within 30% of the window median,
    3) for adjacent pairs changing by > 25%, drop the member farther from the median."""
    clean = (ibi >= IBI_MIN) & (ibi <= IBI_MAX)
    if clean.sum() < 3:
        return clean
    med = np.median(ibi[clean])
    clean &= np.abs(ibi - med) <= IBI_MAX_REL_MEDIAN * med
    dev = np.abs(ibi - med)
    for i in range(1, len(ibi)):
        if clean[i] and clean[i - 1] and abs(ibi[i] - ibi[i - 1]) > IBI_MAX_REL_CHANGE * ibi[i - 1]:
            clean[i if dev[i] >= dev[i - 1] else i - 1] = False
    return clean


def ibi_features(ibi, clean, win_s=WIN_S):
    """HR/HRV from IBIs (s) and their clean mask; shared by the BVP pipeline and the
    ECG reference check."""
    out = dict(hr_mean=np.nan, rmssd=np.nan, sdnn=np.nan, pnn50=np.nan,
               n_beats=0, beat_coverage=0.0, hr_valid=False, hrv_valid=False)
    n = int(clean.sum())
    if n < 3:
        return out
    good = ibi[clean]
    expected = win_s / np.median(good)
    coverage = n / expected
    out["n_beats"], out["beat_coverage"] = n, float(coverage)
    if coverage >= HR_MIN_COVERAGE:
        out["hr_mean"] = float(60.0 / good.mean())
        out["hr_valid"] = True
    if coverage >= HRV_MIN_COVERAGE:
        pair = clean[1:] & clean[:-1]          # successive differences between adjacent clean beats
        dd = np.diff(ibi)[pair]
        if len(dd) >= 10:
            out["rmssd"] = float(np.sqrt(np.mean(dd ** 2)) * 1000)
            out["sdnn"] = float(np.std(good, ddof=1) * 1000)
            out["pnn50"] = float(np.mean(np.abs(dd) > 0.05) * 100)
            out["hrv_valid"] = True
    return out


def bvp_beats(bvp):
    """Beat times (in samples, fractional) from one window of BVP (64 Hz).

    Systolic peaks are found with ``find_peaks`` on the 0.7-3.5 Hz band-passed signal
    (refractory distance 0.33 s, prominence >= 0.3 x IQR). Each beat is then timed at the
    steepest point of its upstroke (max first derivative within 0.25 s before the peak),
    refined by parabolic interpolation. Against the chest-ECG R-peaks this fiducial gave
    lower HR error and much lower RMSSD bias than the peak itself (see validate_hr.py and
    the README), and an adaptive refractory period based on the autocorrelation period
    caused half-rate errors, so it is not used.
    """
    fs = FS["BVP"]
    x = sosfiltfilt(_BVP_SOS, bvp.astype(np.float64))
    scale = np.subtract(*np.percentile(x, [75, 25]))
    if not np.isfinite(scale) or scale <= 0:
        return np.array([], dtype=float)
    peaks, _ = find_peaks(x, distance=int(IBI_MIN * fs), prominence=0.3 * scale)
    dx = np.gradient(x)
    back = int(0.25 * fs)
    t = []
    for p in peaks:
        a = max(0, p - back)
        i = a + int(np.argmax(dx[a:p + 1]))
        off = 0.0
        if 0 < i < len(dx) - 1:
            u, v, w = dx[i - 1], dx[i], dx[i + 1]
            den = u - 2 * v + w
            if den != 0:
                off = float(np.clip(0.5 * (u - w) / den, -0.5, 0.5))
        t.append(i + off)
    return np.array(t, dtype=float)


def bvp_features(bvp):
    """Heart rate and HRV from one window of BVP (64 Hz)."""
    peaks = bvp_beats(bvp)
    if len(peaks) < 4:
        return ibi_features(np.array([]), np.array([], dtype=bool))
    ibi = np.diff(peaks) / FS["BVP"]
    return ibi_features(ibi, clean_ibis(ibi))


def eda_features(eda):
    fs = FS["EDA"]
    x = sosfiltfilt(_EDA_SMOOTH_SOS, eda.astype(np.float64))
    tonic = sosfiltfilt(_EDA_TONIC_SOS, x)
    phasic = x - tonic
    peaks, props = find_peaks(phasic, prominence=SCR_MIN_AMP, distance=fs)
    return dict(
        eda_tonic=float(np.mean(tonic)),
        eda_slope=_slope_per_min(tonic, fs),
        scr_count=float(len(peaks)) * 60.0 / WIN_S,
        scr_amp=float(np.mean(props["prominences"])) if len(peaks) else 0.0,
    )


def temp_features(temp):
    fs = FS["TEMP"]
    x = temp.astype(np.float64)
    return dict(temp_mean=float(np.mean(x)), temp_slope=_slope_per_min(x, fs))


def acc_features(acc):
    mag = np.linalg.norm(acc.astype(np.float64), axis=1) / 64.0  # E4: 1/64 g per unit
    return dict(acc_std=float(np.std(mag)))


def window_starts(n_4hz):
    w, s = int(WIN_S * 4), int(STRIDE_S * 4)
    return np.arange(0, n_4hz - w + 1, s)


def window_label(lab):
    vals, cnt = np.unique(lab, return_counts=True)
    i = cnt.argmax()
    frac = cnt[i] / len(lab)
    return int(vals[i]), float(frac)


def subject_windows(d):
    """d: dict-like with BVP, EDA, TEMP, ACC, label_4hz. Returns list of row dicts."""
    rows = []
    lab4 = d["label_4hz"]
    for s4 in window_starts(len(lab4)):
        t0 = s4 / 4.0
        lab, frac = window_label(lab4[s4:s4 + int(WIN_S * 4)])
        if frac < MIN_LABEL_FRAC or lab not in KEEP_LABELS:
            continue
        seg = lambda ch: d[ch][int(round(t0 * FS[ch])):int(round(t0 * FS[ch])) + int(WIN_S * FS[ch])]
        r = dict(t_start=t0, label3=lab, label_frac=frac, stress=int(lab == 2))
        r.update(bvp_features(seg("BVP")))
        r.update(eda_features(seg("EDA")))
        r.update(temp_features(seg("TEMP")))
        r.update(acc_features(seg("ACC")))
        rows.append(r)
    return rows
