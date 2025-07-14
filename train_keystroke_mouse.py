import os
import pandas as pd
import numpy as np
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LinearRegression
from sklearn.metrics import classification_report
from xgboost import XGBClassifier
from joblib import dump
import matplotlib.pyplot as plt

USER_PATHS = [
    "E:/SafeSpace/data/user 1",
    "E:/SafeSpace/data/user 2"
]

def load_and_fix_data(path):
    ks = pd.read_csv(Path(path) / "keystrokes.tsv", sep="\t")
    ks.columns = ks.columns.str.strip().str.lower().str.replace(" ", "_")
    ks.rename(columns={"relase_time": "release_time"}, inplace=True)
    ks["press_time"] = pd.to_datetime(ks["press_time"])
    ks["release_time"] = pd.to_datetime(ks["release_time"])

    ms = pd.read_csv(Path(path) / "mouse_mov_speeds.tsv", sep="\t")
    ms.columns = ms.columns.str.strip().str.lower().str.replace(" ", "_")
    ms.rename(columns={"time": "timestamp"}, inplace=True)
    ms["timestamp"] = pd.to_datetime(ms["timestamp"])

    uc = pd.read_csv(Path(path) / "usercondition.tsv", sep="\t")
    uc.columns = uc.columns.str.strip().str.lower().str.replace(" ", "_")
    uc["time"] = pd.to_datetime(uc["time"])
    uc["stress"] = uc["stress_val"].apply(lambda x: 1 if "stressed" in x.lower() else 0)

    return ks, ms, uc[["time", "stress"]]

def extract_features(ks, ms, labels, window_sec=300):
    results = []
    start = max(ks["press_time"].min(), ms["timestamp"].min())
    end = min(ks["press_time"].max(), ms["timestamp"].max())
    windows = pd.date_range(start=start, end=end, freq=f"{window_sec}S")

    for win_start in windows[:-1]:
        win_end = win_start + pd.Timedelta(seconds=window_sec)

        ks_win = ks[(ks["press_time"] >= win_start) & (ks["press_time"] < win_end)]
        ms_win = ms[(ms["timestamp"] >= win_start) & (ms["timestamp"] < win_end)]

        if len(ks_win) < 2 or len(ms_win) < 2:
            continue

        ikis = ks_win["press_time"].diff().dt.total_seconds().dropna()
        hold = (ks_win["release_time"] - ks_win["press_time"]).dt.total_seconds().dropna()

        avg_iki = ikis.mean()
        std_iki = ikis.std()
        avg_hold = hold.mean()

        avg_speed = ms_win["speed(ms)"].mean()
        std_speed = ms_win["speed(ms)"].std()

        nearest_idx = (labels["time"] - win_start).abs().idxmin()
        label = labels.loc[nearest_idx, "stress"]

        results.append([avg_iki, std_iki, avg_hold, avg_speed, std_speed, label])

    return pd.DataFrame(results, columns=["avg_iki", "std_iki", "avg_hold", "avg_speed", "std_speed", "stress"])


def train_model(df):
    df = df.dropna()  
    if df.empty:
        raise ValueError("All rows dropped due to NaNs. No data to train on.")

    print(f"Training on {len(df)} rows after dropping NaNs.")

    X = df.drop("stress", axis=1)
    y = df["stress"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, stratify=y, test_size=0.2, random_state=42)

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    model = XGBClassifier(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        scale_pos_weight=(len(y_train) - sum(y_train)) / sum(y_train),
        use_label_encoder=False, eval_metric="logloss"
    )
    model.fit(X_train_scaled, y_train)

    print("Classification Report:\n", classification_report(y_test, model.predict(X_test_scaled)))

    probs_train = model.predict_proba(X_train_scaled)[:, 1]
    probs_test = model.predict_proba(X_test_scaled)[:, 1]

    train_mean = X_train_scaled.mean(axis=1)
    test_mean = X_test_scaled.mean(axis=1)

    z_scaler = StandardScaler()
    z_train = z_scaler.fit_transform(train_mean.reshape(-1, 1)).flatten()
    z_test = z_scaler.transform(test_mean.reshape(-1, 1)).flatten()

    reg = LinearRegression().fit(z_train.reshape(-1, 1), probs_train)
    alpha, beta = reg.coef_[0], reg.intercept_
    print(f"Learned α = {alpha:.4f}, β = {beta:.4f}")

    logit_train = alpha * z_train + beta
    logit_test = alpha * z_test + beta
    center = 0.5
    logit_centered = logit_test - center
    scale = 2.0 / np.percentile(np.abs(logit_train - center), 95)
    scores = np.tanh(scale * logit_centered)

    print("\nSample Tanh Scores:")
    for i in range(min(10, len(scores))):
        print(f"[{i:02}] z: {z_test[i]:.4f} | logit: {logit_test[i]:.4f} | score: {scores[i]:.4f} | "
              f"True: {'Stress' if y_test.iloc[i] == 1 else 'Non-Stress'} | Pred: {'Stress' if model.predict(X_test_scaled[i].reshape(1, -1))[0] == 1 else 'Non-Stress'}")

    out_df = pd.DataFrame({
        "z-score": z_test,
        "Logit (αz+β)": logit_test,
        "Stress Score (tanh)": scores,
        "True Label": y_test,
        "Prediction": model.predict(X_test_scaled),
    })
    out_df["True Interpretation"] = out_df["True Label"].map({0: "Non-Stress", 1: "Stress"})
    out_df["Predicted Interpretation"] = out_df["Prediction"].map({0: "Non-Stress", 1: "Stress"})

    os.makedirs("exports", exist_ok=True)
    out_df.to_excel("exports/behavior_stress_scores.xlsx", index=False)
    print("Score file saved to exports/behavior_stress_scores.xlsx")

    plt.hist(scores[y_test == 0], bins=40, alpha=0.6, label="Non-Stress", density=True)
    plt.hist(scores[y_test == 1], bins=40, alpha=0.6, label="Stress", density=True)
    plt.axvline(0, color='k', linestyle='--')
    plt.title("Behavior Stress Score Distribution (tanh)")
    plt.xlabel("Stress Score [-1, +1]")
    plt.ylabel("Density")
    plt.legend()
    plt.grid(True)
    plt.tight_layout()
    plt.show()

    os.makedirs("models", exist_ok=True)
    dump((model, scaler), "models/behavior_stress_model.joblib")
    print("Model saved to models/behavior_stress_model.joblib")


def main():
    all_data = []

    for user_path in USER_PATHS:
        print(f"Processing data from: {user_path}")
        try:
            ks, ms, labels = load_and_fix_data(user_path)
            df = extract_features(ks, ms, labels).fillna(0)  
            print(f"  → {len(df)} windows from this user")
            all_data.append(df)
        except Exception as e:
            print(f"  ✗ Error processing {user_path}: {e}")

    full_df = pd.concat(all_data, ignore_index=True)
    print(f"Total data shape before dropna: {full_df.shape}")
    full_df = full_df.dropna()
    print(f"Total data shape after dropna: {full_df.shape}")
    print("Label distribution:\n", full_df["stress"].value_counts())

    train_model(full_df)


if __name__ == "__main__":
    main()
