import os
import pickle
import numpy as np
import matplotlib.pyplot as plt
from scipy.signal import find_peaks
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
from sklearn.preprocessing import StandardScaler
from joblib import dump
from xgboost import XGBClassifier


def load_wesad_subject(subject_id, data_dir="./WESAD"):
    path = os.path.join(data_dir, f'S{subject_id}', f'S{subject_id}.pkl')
    if not os.path.exists(path):
        raise FileNotFoundError(f"File not found: {path}")
    with open(path, 'rb') as f:
        data = pickle.load(f, encoding='latin1')
    return data


def compute_rmssd(ibi_series):
    diff = np.diff(ibi_series)
    return np.sqrt(np.mean(diff ** 2)) if len(diff) > 1 else 0

def extract_hrv_features_labels(subject_data, sampling_rate=700):
    ecg = subject_data['signal']['chest']['ECG'][:, 0]
    labels = subject_data['label']


    peaks, _ = find_peaks(ecg, distance=sampling_rate*0.6, height=np.mean(ecg))
    ibi = np.diff(peaks) / sampling_rate  

    rmssd_series = []
    rmssd_timestamps = []

    window_size = 20 
    stride = 5

    for i in range(0, len(ibi) - window_size, stride):
        window = ibi[i:i + window_size]
        rmssd = compute_rmssd(window)
        center_time = peaks[i + window_size // 2]
        rmssd_series.append(rmssd)
        rmssd_timestamps.append(center_time)

    rmssd_series = np.array(rmssd_series)
    rmssd_timestamps = np.array(rmssd_timestamps)

    scaler = StandardScaler()
    rmssd_series = scaler.fit_transform(rmssd_series.reshape(-1, 1)).flatten()

    label_array = np.array([subject_data['label'][t] for t in rmssd_timestamps])
    mask = np.isin(label_array, [1, 2, 3])
    features = rmssd_series[mask]
    labels = label_array[mask]
    binary_labels = (labels == 2).astype(int)

    return features, binary_labels

def create_windows(data, labels, window_size=60, stride=30):
    X, y = [], []
    for i in range(0, len(data) - window_size, stride):
        window = data[i:i + window_size]
        label = int(np.round(np.mean(labels[i:i + window_size])))
        X.append(window)
        y.append(label)
    return np.array(X), np.array(y)


def train_model(X, y):
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    neg, pos = np.bincount(y_train)
    scale_pos_weight = neg / pos
    print(f"Class balance: non-stress={neg}, stress={pos}, scale_pos_weight={scale_pos_weight:.2f}")

    model = XGBClassifier(
        n_estimators=100,
        max_depth=3,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=scale_pos_weight,
        use_label_encoder=False,
        eval_metric="logloss"
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    print("Evaluation on test set:")
    print(classification_report(y_test, preds))

    scores = predict_stress_score(model, X_test)
    print("Example stress scores ([-1, 1]):", scores[:10])
    plot_score_distribution(scores, y_test)

    return model

def predict_stress_score(model, X):
    probs = model.predict_proba(X)[:, 1]
    scores = 2 * probs - 1
    return scores


def plot_score_distribution(scores, labels):
    plt.hist(scores[labels == 0], bins=50, alpha=0.5, label="Non-Stress", density=True)
    plt.hist(scores[labels == 1], bins=50, alpha=0.5, label="Stress", density=True)
    plt.legend()
    plt.title("Stress Score Distribution [-1, 1] (HRV)")
    plt.xlabel("Stress Score")
    plt.ylabel("Density")
    plt.grid(True)
    plt.show()


def main():
    subjects = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17]
    all_X, all_y = [], []

    for sid in subjects:
        try:
            print(f"Loading subject {sid}...")
            data = load_wesad_subject(sid)
            hrv, labels = extract_hrv_features_labels(data)
            X_win, y_win = create_windows(hrv, labels)
            all_X.append(X_win)
            all_y.append(y_win)
        except Exception as e:
            print(f"Skipping subject {sid}: {e}")

    if not all_X:
        raise RuntimeError("No HRV data found. Check data extraction.")

    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    print(f"Training data shape: {X.shape}, Label distribution: {np.bincount(y)}")

    model = train_model(X, y)

    os.makedirs("models", exist_ok=True)
    dump(model, "models/hrv_stress_xgb_model.joblib")
    print("Model saved to models/hrv_stress_xgb_model.joblib")

if __name__ == "__main__":
    main()
