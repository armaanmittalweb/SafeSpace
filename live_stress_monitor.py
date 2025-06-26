import os
import time
import random
import numpy as np
from datetime import datetime
from joblib import load
from pynput import keyboard, mouse
from pathlib import Path
from dotenv import load_dotenv
from huggingface_hub import login
from transformers import AutoTokenizer, AutoModelForCausalLM, pipeline


load_dotenv()
HF_TOKEN = os.getenv("HF_TOKEN")
if not HF_TOKEN:
    raise ValueError("Please set HF_TOKEN in a .env file or environment variable.")
login(token=HF_TOKEN)


models = {
    "hrv": load("models/hrv_stress_xgb_model.joblib"),
    "gsr": load("models/gsr_stress_model.joblib"),
    "temp": load("models/temp_stress_model.joblib"),
    "behavior": load("models/behavior_stress_model.joblib") 
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


print("🔁 Loading Mistral-7B-Instruct-v0.1...")
model_name = "mistralai/Mistral-7B-Instruct-v0.1"

tokenizer = AutoTokenizer.from_pretrained(model_name, token=HF_TOKEN)

model = AutoModelForCausalLM.from_pretrained(
    model_name,
    token=HF_TOKEN,
    device_map="auto",
    torch_dtype="auto",
    offload_folder="offload"
)

llm = pipeline("text-generation", model=model, tokenizer=tokenizer)
print("✅ LLM Ready!")

def predict_stress_scores():
    hrv_feat = get_simulated_window()
    gsr_feat = get_simulated_window()
    temp_feat = get_simulated_window()

    hrv_score = 2 * models["hrv"].predict_proba(hrv_feat)[0][1] - 1
    gsr_score = 2 * models["gsr"].predict_proba(gsr_feat)[0][1] - 1
    temp_score = 2 * models["temp"].predict_proba(temp_feat)[0][1] - 1

    if len(keystroke_times) < 2 or len(mouse_movements) < 2:
        behavior_score = 0
    else:
        ikis = np.diff([t.timestamp() for t in keystroke_times[-10:]])
        avg_iki = np.mean(ikis)
        std_iki = np.std(ikis)
        avg_hold = random.uniform(0.1, 0.3)
        vel = np.mean([random.uniform(0.5, 2.5) for _ in range(10)])
        jerk = np.std([random.uniform(0.1, 1.0) for _ in range(10)])
        feat = np.array([[avg_iki, std_iki, avg_hold, vel, jerk]])
        scaler = models["behavior"][1]
        model = models["behavior"][0]
        assert feat.shape[1] == scaler.n_features_in_, f"Expected {scaler.n_features_in_} features, got {feat.shape[1]}"
        feat = scaler.transform(feat)
        behavior_score = 2 * model.predict_proba(feat)[0][1] - 1

    return {
        "hrv": round(hrv_score, 3),
        "gsr": round(gsr_score, 3),
        "temp": round(temp_score, 3),
        "behavior": round(behavior_score, 3)
    }

def generate_feedback(scores):
    prompt = (
        f"You are an empathetic health assistant. Based on the scores below, describe the user's stress level, assign it to an emotional category "
        f"(🔵 calm, 🟢 neutral, 🟡 mild stress, 🔴 high stress), and suggest a specific coping strategy.\n\n"
        f"Stress scores (range: –1 = low stress to +1 = high stress):\n"
        f"- HRV: {scores['hrv']}\n"
        f"- GSR: {scores['gsr']}\n"
        f"- Temp: {scores['temp']}\n"
        f"- Behavior: {scores['behavior']}\n\n"
        "Output exactly 2 sentences: one summarizing the emotional state, one with a coping tip."
    )
    output = llm(prompt, max_new_tokens=100, do_sample=True, temperature=0.8)[0]["generated_text"]
    generated = output.strip()
    return generated.split(prompt)[-1].strip() if prompt in generated else generated


def run_monitor(interval=60):
    print("▶️ Real-time stress monitoring started.\nPress Ctrl+C to stop.\n")
    keyboard_listener.start()
    mouse_listener.start()

    try:
        while True:
            scores = predict_stress_scores()
            print(f"\n🧪 Stress Scores: {scores}")
            feedback = generate_feedback(scores)
            print("\n🧠 AI Feedback:\n" + feedback)
            print("—" * 60)
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n🛑 Monitoring stopped.")
        keyboard_listener.stop()
        mouse_listener.stop()


if __name__ == "__main__":
    run_monitor(interval=60)
