import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
from joblib import dump

def generate_fake_au_data(n_samples=1000):
    np.random.seed(42)
    # AU features: [AU1, AU4, AU6, AU12, AU14, AU17]
    calm = np.random.normal(loc=0.2, scale=0.1, size=(n_samples 
    stress = np.random.normal(loc=0.6, scale=0.15, size=(n_samples 
    X = np.vstack([calm, stress])
    y = np.array([0] * (n_samples 
    return X, y

X, y = generate_fake_au_data()
scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

X_train, X_test, y_train, y_test = train_test_split(X_scaled, y, stratify=y, random_state=42)

model = LogisticRegression(class_weight="balanced", max_iter=300)
model.fit(X_train, y_train)

print("Classification report:")
print(classification_report(y_test, model.predict(X_test)))

probs = model.predict_proba(X_test)[:, 1]
scores = 2 * probs - 1
print("Sample stress scores ([-1, 1]):", scores[:10])

dump(model, "models/facial_stress_model.joblib")
dump(scaler, "models/facial_stress_scaler.joblib")
