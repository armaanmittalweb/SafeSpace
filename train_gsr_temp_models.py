import os
import pickle
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import classification_report
from joblib import dump

WESAD_DIR = "WESAD"
SUBJECTS = [s for s in range(2, 18) if s != 12]


def load_subject(subject_id):
    path = Path(WESAD_DIR) / f"S{subject_id}" / f"S{subject_id}.pkl"
    with open(path, "rb") as f:
        return pickle.load(f, encoding="latin1")


def extract_feature_windows(signal, labels, window_size=60, stride=30):
    mask = np.isin(labels, [1, 2, 3])
    signal = signal[mask]
    labels = labels[mask]
    binary_labels = (labels == 2).astype(int)

    scaler = StandardScaler()
    signal_z = scaler.fit_transform(signal.reshape(-1, 1)).flatten()

    X, y = [], []
    for i in range(0, len(signal_z) - window_size, stride):
        window = signal_z[i:i+window_size]
        label = int(np.round(np.mean(binary_labels[i:i+window_size])))
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


def train_model(X, y, name, center=0.5):
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
    all_gsr_X, all_gsr_y = [], []
    all_temp_X, all_temp_y = [], []

    for sid in SUBJECTS:
        try:
            data = load_subject(sid)
            print(f"Loaded S{sid}")

            gsr = data['signal']['chest']['EDA']
            temp = data['signal']['chest']['Temp']
            labels = data['label']

            X_gsr, y_gsr = extract_feature_windows(gsr, labels)
            X_temp, y_temp = extract_feature_windows(temp, labels)

            all_gsr_X.append(X_gsr)
            all_gsr_y.append(y_gsr)
            all_temp_X.append(X_temp)
            all_temp_y.append(y_temp)

        except Exception as e:
            print(f"Skipping S{sid}: {e}")

    X_gsr = np.vstack(all_gsr_X)
    y_gsr = np.concatenate(all_gsr_y)
    X_temp = np.vstack(all_temp_X)
    y_temp = np.concatenate(all_temp_y)

    print(f"\nGSR samples: {X_gsr.shape}, Labels: {np.bincount(y_gsr)}")
    print(f"Temp samples: {X_temp.shape}, Labels: {np.bincount(y_temp)}")

    train_model(X_gsr, y_gsr, "gsr", center=0.5)
    train_model(X_temp, y_temp, "temp", center=0.5)


if __name__ == "__main__":
    main()
