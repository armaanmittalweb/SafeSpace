import os
import pickle
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import classification_report
from joblib import dump
from pathlib import Path

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

def train_model(X, y, name):
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, stratify=y, random_state=42
    )
    model = LogisticRegression(max_iter=500, class_weight='balanced')
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    print(f"\n[{name}] Classification Report:")
    print(classification_report(y_test, preds))

    probs = model.predict_proba(X_test)[:, 1]
    scores = 2 * probs - 1
    print(f"[{name}] Example stress scores:", scores[:5])

    Path("models").mkdir(exist_ok=True)
    dump(model, f"models/{name}_stress_model.joblib")
    print(f"[{name}] Model saved → models/{name}_stress_model.joblib")

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

    train_model(X_gsr, y_gsr, "gsr")
    train_model(X_temp, y_temp, "temp")

if __name__ == "__main__":
    main()
