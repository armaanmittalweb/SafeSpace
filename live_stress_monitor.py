import os
import time
import random
import numpy as np
import geocoder
from datetime import datetime
from joblib import load
from pynput import keyboard, mouse
from dotenv import load_dotenv
from transformers import AutoTokenizer, AutoModelForCausalLM
from sklearn.preprocessing import StandardScaler
import torch
import platform

load_dotenv()
HF_TOKEN = os.getenv("HF_TOKEN")
if not HF_TOKEN:
    raise ValueError("Please set HF_TOKEN in a .env file or environment variable.")

def load_model_with_params(name, model_file, alpha_beta_file=None, center=0.5):
    model = load(f"models/{model_file}")
    scaler = model[1] if isinstance(model, tuple) else None
    model = model[0] if isinstance(model, tuple) else model

    alpha, beta, scale = 1.0, 0.0, 1.0
    if alpha_beta_file and os.path.exists(f"models/{alpha_beta_file}"):
        params = np.load(f"models/{alpha_beta_file}")
        if isinstance(params, np.lib.npyio.NpzFile):  # .npz
            alpha = params["alpha"].item()
            beta = params["beta"].item()
            scale = params["scale"].item() if "scale" in params else 1.0
            center = params["center"].item() if "center" in params else center
        else:
            alpha, beta = params

    return {
        "model": model,
        "scaler": scaler,
        "alpha": alpha,
        "beta": beta,
        "scale": scale,
        "center": center
    }

models = {
    "hrv": load_model_with_params("hrv", "hrv_stress_xgb_model.joblib", "hrv_score_alpha_beta.npy"),
    "gsr": load_model_with_params("gsr", "gsr_stress_model.joblib"),
    "temp": load_model_with_params("temp", "temp_stress_model.joblib"),
    "ppg": load_model_with_params("ppg", "ppg_stress_model.joblib"),
    "spo2": load_model_with_params("spo2", "spo2_stress_model.joblib", "spo2_score_params.npz"),
    "behavior": load_model_with_params("behavior", "behavior_stress_model.joblib"),
}

keystroke_times = []
mouse_movements = []

def on_press(key):
    keystroke_times.append(datetime.now())

def on_move(x, y):
    mouse_movements.append((x, y, datetime.now()))

keyboard_listener = keyboard.Listener(on_press=on_press)
mouse_listener = mouse.Listener(on_move=on_move)

def get_simulated_window(length=60):
    return np.random.normal(loc=0.0, scale=1.0, size=(1, length))

def compute_score(x, model_info):
    x_mean = x.mean(axis=1).reshape(-1, 1)
    z = StandardScaler().fit_transform(x_mean).flatten()
    logit = model_info["alpha"] * z + model_info["beta"]
    centered = logit - model_info["center"]
    return float(np.tanh(model_info["scale"] * centered)[0])

print("🔁 Loading Gemma-2B-Instruct...")
model_name = "google/gemma-2b-it"

tokenizer = AutoTokenizer.from_pretrained(model_name, token=HF_TOKEN)
tokenizer.pad_token = tokenizer.eos_token

llm_model = AutoModelForCausalLM.from_pretrained(
    model_name,
    token=HF_TOKEN,
    torch_dtype=torch.float16,
    device_map="auto"
)
print("✅ Gemma 2B Instruct Loaded.")

def predict_stress_scores():
    scores = {}
    for name in ["hrv", "gsr", "temp", "ppg", "spo2"]:
        x = get_simulated_window()
        scores[name] = round(compute_score(x, models[name]), 3)

    if len(keystroke_times) < 2 or len(mouse_movements) < 2:
        scores["behavior"] = 0.0
    else:
        ikis = np.diff([t.timestamp() for t in keystroke_times[-10:]])
        avg_iki = np.mean(ikis)
        std_iki = np.std(ikis)
        avg_hold = random.uniform(0.1, 0.3)
        vel = np.mean([random.uniform(0.5, 2.5) for _ in range(10)])
        jerk = np.std([random.uniform(0.1, 1.0) for _ in range(10)])
        feat = np.array([[avg_iki, std_iki, avg_hold, vel, jerk]])
        behavior = models["behavior"]
        feat = behavior["scaler"].transform(feat)
        scores["behavior"] = round(compute_score(feat, behavior), 3)

    return scores

def get_user_context(behavior_score):
    now = datetime.now()
    time_of_day = now.strftime("%I:%M %p")
    day = now.strftime("%A")
    location = "unknown"
    try:
        g = geocoder.ip("me")
        if g.ok and g.city:
            location = f"{g.city}, {g.country}"
    except Exception:
        location = platform.node()

    behavior_state = (
        "highly active" if behavior_score > 0.5 else
        "neutral" if -0.5 <= behavior_score <= 0.5 else
        "very idle"
    )
    return f"The user is currently in {location}, on a {day} at {time_of_day}." #. Based on their behavior, they appear {behavior_state}."

def generate_feedback(scores):
    context = get_user_context(scores["behavior"])
    print(f"{context}")
    prompt = (
        f"{context}\n\n"
        "Each score is in the range [-1, +1] where:\n"
        "negative value = no stress\n"
        "Closer to 0 = we can ignore it we will not consider these values in our evaluation.\n"
        "postitve value = high stress\n\n"
        "Remember these are normalized scores where and not to be considered actual physiological measurements.\n"
        "Use these rules to interpret scores:\n"
        "Score < -0.4 → 'no stress'\n"
        # "-0.4 to 0.4 → 'uncertain'\n"
        "Score > 0.4 → 'high stress'\n\n"
        "Output in this exact format:\n"
        "Summary: <1 sentence summary>\n"
        "Coping Tip: <1 sentence coping tip>\n\n"
        f"Scores:\n"
        f"- HRV: {scores['hrv']}\n"
        f"- GSR: {scores['gsr']}\n"
        f"- Temp: {scores['temp']}\n"
        f"- PPG: {scores['ppg']}\n"
        f"- SpO₂: {scores['spo2']}\n"
        f"- Behavior: {scores['behavior']}\n\n"
        "Begin:"
    )

    encoded = tokenizer(prompt, return_tensors="pt", padding=True).to(llm_model.device)
    with torch.no_grad():
        output_ids = llm_model.generate(
            input_ids=encoded["input_ids"],
            attention_mask=encoded["attention_mask"],
            max_new_tokens=150,
            do_sample=True,
            temperature=0.7,
            pad_token_id=tokenizer.eos_token_id
        )
    full_output = tokenizer.decode(output_ids[0], skip_special_tokens=True)
    return full_output.split("Begin:")[-1].strip()

def run_monitor(interval=15):
    print("▶️ Real-time stress monitoring started.\nPress Ctrl+C to stop.\n")
    keyboard_listener.start()
    mouse_listener.start()
    try:
        while True:
            start = time.time()
            scores = predict_stress_scores()
            score_time = time.time() - start
            start_feedback = time.time()
            feedback = generate_feedback(scores)
            feedback_time = time.time() - start_feedback
            total_time = time.time() - start
            print(f"\n🧪 Stress Scores: {scores}")
            print(f"⏱️ Time — Scores: {score_time:.2f}s | Feedback: {feedback_time:.2f}s | Total: {total_time:.2f}s")
            print("\n🧠 AI Feedback:\n" + feedback)
            print("—" * 60)
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n🛑 Monitoring stopped.")
        keyboard_listener.stop()
        mouse_listener.stop()

if __name__ == "__main__":
    run_monitor()
