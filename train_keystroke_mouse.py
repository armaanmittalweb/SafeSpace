import os
import pandas as pd
import numpy as np
from pathlib import Path
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import classification_report
from xgboost import XGBClassifier
from joblib import dump

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
    X = df.drop("stress", axis=1)
    y = df["stress"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, stratify=y, test_size=0.2, random_state=42)

    scaler = StandardScaler()
    X_train = scaler.fit_transform(X_train)
    X_test = scaler.transform(X_test)

    neg, pos = np.bincount(y_train)
    model = XGBClassifier(
        n_estimators=100, max_depth=3, learning_rate=0.1,
        scale_pos_weight=neg / pos, use_label_encoder=False, eval_metric="logloss"
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    print("Classification Report:\n", classification_report(y_test, preds))

    probs = model.predict_proba(X_test)[:, 1]
    scores = 2 * probs - 1
    print("Example stress scores ([-1, 1]):", scores[:5])

    os.makedirs("models", exist_ok=True)
    dump((model, scaler), "models/behavior_stress_model.joblib")
    print("Model saved to models/behavior_stress_model.joblib")

def main():
    all_data = []

    for user_path in USER_PATHS:
        print(f"Processing data from: {user_path}")
        try:
            ks, ms, labels = load_and_fix_data(user_path)
            df = extract_features(ks, ms, labels)
            print(f"  → {len(df)} windows from this user")
            all_data.append(df)
        except Exception as e:
            print(f"  ✗ Error processing {user_path}: {e}")

    full_df = pd.concat(all_data, ignore_index=True)
    print(f"Total data shape: {full_df.shape}")
    print("Label distribution:\n", full_df["stress"].value_counts())

    train_model(full_df)

if __name__ == "__main__":
    main()
