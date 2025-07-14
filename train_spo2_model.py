import os
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import classification_report
from joblib import dump
import matplotlib.pyplot as plt

# Configuration
CSV_DIR = Path("bidmc-ppg-and-respiration-dataset-1.0.0/bidmc-ppg-and-respiration-dataset-1.0.0/bidmc_csv")
WINDOW = 60      # seconds
STRIDE = 30
THRESH = 94      # SpO2 < 94 = stressed (proxy label)

def extract_features_from_spo2(spo2_series):
    features = []
    labels = []
    for i in range(0, len(spo2_series) - WINDOW, STRIDE):
        win = spo2_series[i:i+WINDOW]
        if win.isnull().any():
            continue
        mean = win.mean()
        std = win.std()
        dip_pct = np.mean(win < THRESH)
        label = int(mean < THRESH)
        features.append([mean, std, dip_pct])
        labels.append(label)
    return np.array(features), np.array(labels)

def tanh_score_pipeline(X_train, X_test, y_train, probs_train, probs_test, center=0.5):
    z_scaler = StandardScaler()
    z_train = z_scaler.fit_transform(X_train.mean(axis=1).reshape(-1, 1)).flatten()
    z_test = z_scaler.transform(X_test.mean(axis=1).reshape(-1, 1)).flatten()

    reg = LinearRegression().fit(z_train.reshape(-1, 1), probs_train)
    alpha, beta = reg.coef_[0], reg.intercept_

    logit_train = alpha * z_train + beta
    logit_test = alpha * z_test + beta
    scale = 2.0 / np.percentile(np.abs(logit_train - center), 95)
    score = np.tanh(scale * (logit_test - center))

    return score, alpha, beta, scale, z_test, logit_test

def train_spo2_model():
    all_X, all_y = [], []

    for file in CSV_DIR.glob("*_Numerics.csv"):
        try:
            print(f"📂 Reading {file.name}")
            df = pd.read_csv(file)
            df.columns = df.columns.str.strip()

            if "SpO2" not in df.columns:
                print(f"⚠️ Skipping {file.name} — 'SpO2' column not found.")
                continue

            spo2 = df["SpO2"].dropna().reset_index(drop=True)
            print(f"→ SpO2 samples: {len(spo2)}")

            if len(spo2) < WINDOW:
                print(f"⚠️ Too few SpO2 readings: {len(spo2)}")
                continue

            X, y = extract_features_from_spo2(spo2)
            if len(X) == 0:
                print(f"⚠️ No valid windows extracted from {file.name}")
                continue

            all_X.append(X)
            all_y.append(y)
            print(f"✅ Loaded {file.name} — {len(X)} windows")

        except Exception as e:
            print(f"✗ Failed on {file.name}: {e}")


    if not all_X:
        raise RuntimeError("No valid data found.")

    X = np.vstack(all_X)
    y = np.concatenate(all_y)

    print(f"\n✅ Combined data: {X.shape}, Label distribution: {np.bincount(y)}")

    X_train, X_test, y_train, y_test = train_test_split(X, y, stratify=y, test_size=0.2, random_state=42)
    model = LogisticRegression(max_iter=500, class_weight="balanced")
    model.fit(X_train, y_train)

    probs_train = model.predict_proba(X_train)[:, 1]
    probs_test = model.predict_proba(X_test)[:, 1]
    preds = model.predict(X_test)

    print("\n📊 Classification Report:")
    print(classification_report(y_test, preds))

    scores, alpha, beta, scale, z_test, logit_test = tanh_score_pipeline(
        X_train, X_test, y_train, probs_train, probs_test
    )

    # Save model and scoring params
    Path("models").mkdir(exist_ok=True)
    dump(model, "models/spo2_stress_model.joblib")
    np.savez("models/spo2_score_params.npz", alpha=alpha, beta=beta, scale=scale, center=0.5)
    print("💾 Model + scoring params saved to models/")

    # Export scores
    Path("exports").mkdir(exist_ok=True)
    out_df = pd.DataFrame({
        "z-score": z_test,
        "logit": logit_test,
        "tanh_score": scores,
        "true_label": y_test,
        "predicted": preds
    })
    out_df.to_excel("exports/spo2_stress_scores.xlsx", index=False)
    print("📄 Scores exported to exports/spo2_stress_scores.xlsx")

    # Plot histogram
    plt.hist(scores[y_test == 0], bins=40, alpha=0.6, label="Non-Stress", density=True)
    plt.hist(scores[y_test == 1], bins=40, alpha=0.6, label="Stress", density=True)
    plt.axvline(0, color="k", linestyle="--")
    plt.title("SpO₂ Tanh Stress Score Distribution")
    plt.xlabel("Score [-1, +1]")
    plt.ylabel("Density")
    plt.legend()
    plt.tight_layout()
    plt.grid(True)
    plt.show()

if __name__ == "__main__":
    train_spo2_model()
