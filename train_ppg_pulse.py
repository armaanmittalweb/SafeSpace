import os
import pickle
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path
from scipy.signal import find_peaks
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import classification_report
from joblib import dump

WESAD_DIR = "WESAD"
SUBJECTS = [s for s in range(2, 18) if s != 12]
PPG_SAMPLING_RATE = 64      
LABEL_SAMPLING_RATE = 700  


def load_subject(subject_id):
    path = Path(WESAD_DIR) / f"S{subject_id}" / f"S{subject_id}.pkl"
    with open(path, "rb") as f:
        return pickle.load(f, encoding="latin1")


def compute_rmssd(ibi_series):
    diff = np.diff(ibi_series)
    return np.sqrt(np.mean(diff**2)) if len(diff) > 1 else 0


def extract_ppg_rmssd_windows(ppg, labels, window_size=60, stride=30):
    peaks, _ = find_peaks(ppg, distance=PPG_SAMPLING_RATE * 0.6)
    ibi = np.diff(peaks) / PPG_SAMPLING_RATE

    rmssd_series = []
    rmssd_bvp_indices = []

    hrv_window = 20
    for i in range(0, len(ibi) - hrv_window, 5):
        window = ibi[i:i + hrv_window]
        rmssd = compute_rmssd(window)
        center_bvp_idx = peaks[i + hrv_window // 2]
        rmssd_series.append(rmssd)
        rmssd_bvp_indices.append(center_bvp_idx)

    rmssd_series = np.array(rmssd_series)
    rmssd_bvp_indices = np.array(rmssd_bvp_indices)

    scaler = StandardScaler()
    rmssd_z = scaler.fit_transform(rmssd_series.reshape(-1, 1)).flatten()

    def bvp_to_label_idx(bvp_idx):
        return int(bvp_idx * (LABEL_SAMPLING_RATE / PPG_SAMPLING_RATE))

    X, y = [], []
    for i in range(0, len(rmssd_z) - window_size, stride):
        window = rmssd_z[i:i + window_size]
        label_indices = rmssd_bvp_indices[i:i + window_size]
        mapped_labels = []

        for bvp_idx in label_indices:
            label_idx = bvp_to_label_idx(bvp_idx)
            if label_idx < len(labels):
                mapped_labels.append(labels[label_idx])

        if len(mapped_labels) == 0:
            continue

        binary = np.array([1 if lbl == 2 else 0 for lbl in mapped_labels])
        label = int(np.round(np.mean(binary)))
        X.append(window)
        y.append(label)

    return np.array(X), np.array(y)


def tanh_score_pipeline(X_train, X_test, y_train, model_probs_train, model_probs_test, center=0.5):
    train_mean = X_train.mean(axis=1).reshape(-1, 1)
    test_mean = X_test.mean(axis=1).reshape(-1, 1)

    z_scaler = StandardScaler()
    z_train = z_scaler.fit_transform(train_mean).flatten()
    z_test = z_scaler.transform(test_mean).flatten()

    reg = LinearRegression().fit(z_train.reshape(-1, 1), model_probs_train)
    alpha, beta = reg.coef_[0], reg.intercept_
    print(f"Learned α = {alpha:.4f}, β = {beta:.4f}")

    logits_train = alpha * z_train + beta
    logits_test = alpha * z_test + beta
    logits_centered = logits_test - center

    scale = 2.0 / np.percentile(np.abs(logits_train - center), 95)
    score = np.tanh(logits_centered * scale)

    return z_test, logits_test, score, alpha, beta, scale


def train_model(X, y, name="ppg", center=0.5):
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )

    model = LogisticRegression(max_iter=500, class_weight='balanced')
    model.fit(X_train, y_train)

    probs_train = model.predict_proba(X_train)[:, 1]
    probs_test = model.predict_proba(X_test)[:, 1]
    preds = model.predict(X_test)

    print(f"\n[{name.upper()}] Classification Report:")
    print(classification_report(y_test, preds))

    z_test, logits_test, score, alpha, beta, scale = tanh_score_pipeline(
        X_train, X_test, y_train, probs_train, probs_test, center
    )

    print(f"\n[{name.upper()}] Detailed Insight:")
    for i in range(min(10, len(score))):
        print(f"[{i:02}] z: {z_test[i]:.4f} | logit: {logits_test[i]:.4f} | score: {score[i]:.4f} | "
              f"True: {'Stress' if y_test[i] == 1 else 'Non-Stress'} | Pred: {'Stress' if preds[i] == 1 else 'Non-Stress'}")

    df = pd.DataFrame({
        "z-score": z_test,
        "Logit (αz+β)": logits_test,
        "Stress Score (tanh)": score,
        "True Label": y_test,
        "Prediction": preds,
        "True Interpretation": ["Stress" if l == 1 else "Non-Stress" for l in y_test],
        "Predicted Interpretation": ["Stress" if p == 1 else "Non-Stress" for p in preds]
    })

    Path("exports").mkdir(exist_ok=True)
    df.to_excel(f"exports/{name}_stress_scores.xlsx", index=False)
    print(f"[{name.upper()}] Score file saved → exports/{name}_stress_scores.xlsx")

    plt.hist(score[y_test == 0], bins=40, alpha=0.6, label="Non-Stress", density=True)
    plt.hist(score[y_test == 1], bins=40, alpha=0.6, label="Stress", density=True)
    plt.axvline(0, color='k', linestyle='--')
    plt.title(f"{name.upper()} Stress Score Distribution (tanh)")
    plt.xlabel("Stress Score [-1, +1]")
    plt.ylabel("Density")
    plt.legend()
    plt.grid(True)
    plt.tight_layout()
    plt.show()

    Path("models").mkdir(exist_ok=True)
    dump(model, f"models/{name}_stress_model.joblib")
    print(f"[{name.upper()}] Model saved → models/{name}_stress_model.joblib")


def main():
    all_X, all_y = [], []

    for sid in SUBJECTS:
        try:
            print(f"Loading S{sid}")
            data = load_subject(sid)
            ppg = data['signal']['wrist']['BVP'].flatten() 
            labels = data['label']

            X_win, y_win = extract_ppg_rmssd_windows(ppg, labels)
            all_X.append(X_win)
            all_y.append(y_win)
        except Exception as e:
            print(f"Skipping S{sid}: {e}")

    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    print(f"Final PPG dataset: {X.shape}, Labels: {np.bincount(y)}")

    train_model(X, y, name="ppg", center=0.5)


if __name__ == "__main__":
    main()
