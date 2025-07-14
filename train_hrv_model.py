import os
import pickle
import numpy as np
import matplotlib.pyplot as plt
from scipy.signal import find_peaks
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LinearRegression
from joblib import dump
from xgboost import XGBClassifier
import pandas as pd


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

    peaks, _ = find_peaks(ecg, distance=sampling_rate * 0.6, height=np.mean(ecg))
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

    label_array = np.array([subject_data['label'][t] for t in rmssd_timestamps])
    mask = np.isin(label_array, [1, 2, 3])
    features = rmssd_series[mask].reshape(-1, 1)
    labels = label_array[mask]
    binary_labels = (labels == 2).astype(int)

    return features, binary_labels


def create_windows(data, labels, window_size=60, stride=30):
    X, y = [], []
    for i in range(0, len(data) - window_size, stride):
        window = data[i:i + window_size]
        label = int(np.round(np.mean(labels[i:i + window_size])))
        X.append(window.mean(axis=0))
        y.append(label)
    return np.array(X), np.array(y)


def train_model(X, y):
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    model = XGBClassifier(
        n_estimators=100,
        max_depth=3,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        scale_pos_weight=(len(y_train) - sum(y_train)) / sum(y_train),
        use_label_encoder=False,
        eval_metric="logloss"
    )
    model.fit(X_train_scaled, y_train)

    print("Evaluation on test set:")
    preds = model.predict(X_test_scaled)
    print(classification_report(y_test, preds))

    logits_train = model.predict_proba(X_train_scaled)[:, 1]
    z_scores = X_train_scaled.flatten()
    reg = LinearRegression().fit(z_scores.reshape(-1, 1), logits_train)
    alpha, beta = reg.coef_[0], reg.intercept_
    print(f"Learned scoring parameters: alpha = {alpha:.4f}, beta = {beta:.4f}")

    test_raw_vals = X_test.flatten()
    z = (test_raw_vals - scaler.mean_[0]) / scaler.scale_[0]
    logits_test = alpha * z + beta

    logits_centered = logits_test - 0.5

    scale = 2.0 / np.percentile(np.abs(alpha * z_scores + beta - 0.5), 95)

    score = np.tanh(logits_centered * scale)

    pred_labels = model.predict(X_test_scaled)

    print("\n=== Detailed HRV Insight Table ===")
    for i in range(len(test_raw_vals)):
        print(f"[{i:02}] HRV: {test_raw_vals[i]:.4f} | z: {z[i]:.4f} | Score: {score[i]:.4f} "
              f"| True: {'Stress' if y_test[i] == 1 else 'Non-Stress'} "
              f"| Pred: {'Stress' if pred_labels[i] == 1 else 'Non-Stress'}")

    score_table = pd.DataFrame({
        "HRV (RMSSD)": test_raw_vals,
        "z-score": z,
        "Logit (αz+β)": logits_test,
        "Stress Score (tanh)": score,
        "True Label": y_test,
        "Prediction": pred_labels,
        "True Interpretation": ["Stress" if l == 1 else "Non-Stress" for l in y_test],
        "Predicted Interpretation": ["Stress" if p == 1 else "Non-Stress" for p in pred_labels]
    })

    print("\n=== Preview of Score Table ===")
    print(score_table.head(10))

    os.makedirs("exports", exist_ok=True)
    score_table.to_excel("exports/hrv_stress_scores_detailed.xlsx", index=False)
    print("Detailed score log saved to 'exports/hrv_stress_scores_detailed.xlsx'.")

    # Plot score distributions
    plt.hist(score[y_test == 0], bins=40, alpha=0.6, label="Non-Stress", density=True)
    plt.hist(score[y_test == 1], bins=40, alpha=0.6, label="Stress", density=True)
    plt.axvline(0, color='k', linestyle='--', linewidth=1)
    plt.title("HRV Stress Score Distribution [-1, +1]")
    plt.xlabel("Stress Score")
    plt.ylabel("Density")
    plt.legend()
    plt.grid(True)
    plt.tight_layout()
    plt.show()

    return model, scaler, (alpha, beta)


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

    model, scaler, (alpha, beta) = train_model(X, y)

    os.makedirs("models", exist_ok=True)
    dump(model, "models/hrv_stress_xgb_model.joblib")
    dump(scaler, "models/hrv_stress_scaler.joblib")
    np.save("models/hrv_score_alpha_beta.npy", [alpha, beta])
    print("Model and scoring parameters saved.")


if __name__ == "__main__":
    main()
