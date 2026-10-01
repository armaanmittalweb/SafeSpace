# Writes eda-reference.json from training/features.py. Run from the repo root with numpy + scipy:
#   python web/tests/fixtures/eda_reference.py
import json, sys
import numpy as np
sys.path.insert(0, 'training')
import features as F
from scipy.signal import butter
rng = np.random.default_rng(7)
out = {"butter_1hz": butter(2, 1.0, fs=4, output='sos').tolist(), "butter_005hz": butter(2, 0.05, fs=4, output='sos').tolist(), "cases": []}
t = np.arange(240) / 4.0
for k in range(4):
    base = 0.6 + 0.3 * k + 0.004 * k * t
    scr = np.zeros_like(t)
    for c in rng.uniform(3, 57, size=2 + 2 * k):
        a = rng.uniform(0.02, 0.2)
        m = t >= c
        scr[m] += a * (np.exp(-(t[m] - c) / 4) - np.exp(-(t[m] - c) / 0.75))
    eda = base + scr + rng.normal(0, 0.004, size=t.size)
    temp = 33.2 + 0.2 * k - 0.002 * t + rng.normal(0, 0.01, size=t.size)
    acc = np.stack([rng.normal(0, 3 + 4 * k, 1920), rng.normal(0, 3, 1920), 64 + rng.normal(0, 2 + k, 1920)], axis=1).round()
    r = {"eda": eda.round(6).tolist(), "temp": temp.round(4).tolist(), "acc": acc.astype(int).flatten().tolist()}
    e = F.eda_features(np.array(r["eda"]))
    tf = F.temp_features(np.array(r["temp"]))
    af = F.acc_features(np.array(r["acc"]).reshape(-1, 3))
    r["expected"] = {**e, **tf, **af}
    out["cases"].append(r)
json.dump(out, open('web/tests/fixtures/eda-reference.json', 'w'))
print([c["expected"] for c in out["cases"]])
