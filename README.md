## 🧠 **Per-Feature Explainable Multimodal Stress Detection and Narrative Feedback System**

### 📘 Overview

This project implements a real-time, multimodal stress inference system that integrates physiological and behavioral signals with explainable AI and LLM-based natural language feedback. The system operates entirely on local hardware, respects privacy constraints, and is optimized for edge deployment with no reliance on the cloud.

By modeling each modality independently and generating human-readable explanations via a local instruction-tuned language model (Mistral-7B-Instruct), this work enables emotionally intelligent and interpretable stress-aware systems suitable for health monitoring, digital wellness, and ambient computing.

---

## 🎯 Objective

> To build a **real-time, per-feature explainable stress inference pipeline** using signals such as HRV, GSR, temperature, and user behavioral data (keyboard and mouse), and translate the quantified stress predictions into concise, user-friendly **natural language summaries** using a local **open-source LLM**.

---

## 🔍 Motivation

Traditional stress detection systems are often:

* **Black-box** (difficult to interpret)
* **Monolithic** (all signals fused early)
* **Cloud-reliant** (not privacy-respecting)

This project addresses all three by:

* Training **per-signal models** for explainability
* Producing **normalized stress scores** in the range `[-1, +1]`
* Using a **local LLM** to narrate the feedback

---

## 🧪 System Architecture

```
                ┌────────────────────┐
                │   Physiological    │
                │ (HRV, GSR, Temp)   │
                └────────┬───────────┘
                         │
                ┌────────▼───────────┐
                │  Per-Feature ML    │
                │  Logistic/XGBoost  │
                └────────┬───────────┘
                         │
                ┌────────▼────────────┐
                │  Stress Scores [-1,1]│
                └────────┬────────────┘
                         │
         ┌───────────────▼────────────────┐
         │   Open Source LLM Narrator     │
         │ (Mistral-7B-Instruct, offline) │
         └────────────────────────────────┘
                         │
               ┌─────────▼──────────┐
               │  Natural Language  │
               │    Explanation     │
               └────────────────────┘
```

---

## 🧬 Features & Modalities

| Modality   | Signal            | Model Type          | Explanation Method          |
| ---------- | ----------------- | ------------------- | --------------------------- |
| HRV        | RMSSD (ECG)       | XGBoost             | Probability → Score \[-1,1] |
| GSR        | Skin Conduct.     | Logistic Regression | Probability → Score         |
| Temp       | Skin Temp         | Logistic Regression | Probability → Score         |
| Behavior   | Keystroke + Mouse | XGBoost             | Feature Vector + Scaler     |
| LLM Output | All scores        | Mistral-7B-Instruct | Narrative + Emoji Tag       |

---

## 🧠 Natural Language Feedback Prompt

```txt
You are an empathetic health assistant. Based on the scores below, describe the user's stress level, assign it to an emotional category (🔵 calm, 🟢 neutral, 🟡 mild stress, 🔴 high stress), and suggest a specific coping strategy.

Stress scores (range: –1 = low stress to +1 = high stress):
- HRV: -0.89
- GSR: -0.16
- Temp: +0.47
- Behavior:  0.00

Output exactly 2 sentences: one summarizing the emotional state, one with a coping tip.
```

---

## 🖥️ Real-Time Execution Flow

```bash
python live_stress_monitor.py
```

* Captures simulated HRV, GSR, Temp every 60 seconds
* Monitors real keystrokes + mouse movement using `pynput`
* Uses pretrained per-feature models in `models/`
* Passes scores to Mistral-7B via `transformers.pipeline`
* Outputs:

  * Stress Scores
  * AI Feedback with emojis and coping advice

---

## 🧰 Installation

```bash
pip install -r requirements.txt
```

```txt
transformers
accelerate
safetensors
joblib
scikit-learn
pynput
python-dotenv
huggingface_hub
```

Create a `.env` file with:

```
HF_TOKEN=hf_your_access_token_here
```

---

## 🧠 Example Output

```
🧪 Stress Scores: {'hrv': -0.889, 'gsr': -0.161, 'temp': 0.467, 'behavior': 0}

🧠 AI Feedback:
🔴 The user's physiological stress signals are significantly elevated, especially heart rate variability.
Try 4-7-8 breathing for 3 minutes to quickly stabilize nervous system response.
```

---

## 🔐 Privacy & Deployment

* ✅ Edge-Only: No cloud processing required
* ✅ Sensor-agnostic: Simulated or real inputs
* ✅ Runs on RTX 3070 Ti (or CPU with fallback)
* ✅ Fully offline LLM (after download)

---

## 🧪 Potential Extensions

* SHAP-based per-feature visual explanations
* Real hardware input (MAX30100, GSR sensor, Temp, ESP32)
* Streamlit-based dashboard
* Integration with mental health journaling apps

---

## 📜 Citation

If using this architecture or codebase for academic or industry work:

```
@misc{safe-stress-ai,
  title={Per-Feature Explainable Multimodal Stress Detection and Narrative Feedback System},
  author={Armaan Mittal},
  year={2025},
  howpublished={\url{https://github.com/armaanmittalweb/SafeSpace}},
  note={Edge-deployable, interpretable, LLM-narrated stress inference}
}
```
