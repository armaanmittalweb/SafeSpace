import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from collections import deque
import time
import math

# ----------- Signal Simulation Functions -----------

def simulate_hrv(t):  # RMSSD in seconds
    return 0.06 + 0.02 * math.sin(0.01 * t) + np.random.normal(0, 0.005)

def simulate_gsr(t):
    return 2 + 0.5 * math.sin(0.03 * t) + np.random.normal(0, 0.2)

def simulate_temp(t):
    return 36.8 + 0.2 * math.sin(0.005 * t) + np.random.normal(0, 0.05)

def simulate_pulse(t):
    return 75 + 5 * math.sin(0.07 * t) + np.random.normal(0, 1.5)

def simulate_spo2(t):
    return 97 + 0.5 * math.sin(0.01 * t) + np.random.normal(0, 0.2)

# ----------- Rolling Buffers -----------

ROLLING_SECONDS = 15
buffers = {
    "timestamps": deque(maxlen=ROLLING_SECONDS),
    "hrv": deque(maxlen=ROLLING_SECONDS),
    "gsr": deque(maxlen=ROLLING_SECONDS),
    "temp": deque(maxlen=ROLLING_SECONDS),
    "ppg": deque(maxlen=ROLLING_SECONDS),
    "spo2": deque(maxlen=ROLLING_SECONDS)
}

# ----------- Plot Setup -----------

fig, axs = plt.subplots(5, 1, figsize=(10, 10), sharex=True)
fig.suptitle("Real-Time Physiological Signals (Last 15 seconds)")

signals = ["hrv", "gsr", "temp", "ppg", "spo2"]
lines = {}

for ax, key in zip(axs, signals):
    ax.set_ylabel(key.upper())
    line, = ax.plot([], [], label=key)
    lines[key] = line
axs[-1].set_xlabel("Time (s)")

# ----------- Animation Update Function -----------

def update(frame):
    t = time.time()
    buffers["timestamps"].append(t)
    buffers["hrv"].append(simulate_hrv(t))
    buffers["gsr"].append(simulate_gsr(t))
    buffers["temp"].append(simulate_temp(t))
    buffers["ppg"].append(simulate_pulse(t))
    buffers["spo2"].append(simulate_spo2(t))

    t0 = buffers["timestamps"][0]
    times = [ts - t0 for ts in buffers["timestamps"]]

    for key in signals:
        lines[key].set_data(times, buffers[key])
        ax = axs[signals.index(key)]
        ax.relim()
        ax.autoscale_view()

    return list(lines.values())
# ----------- Exported Access Function -----------

def get_latest_buffers():
    return {
        "hrv": list(buffers["hrv"]),
        "gsr": list(buffers["gsr"]),
        "temp": list(buffers["temp"]),
        "ppg": list(buffers["ppg"]),
        "spo2": list(buffers["spo2"]),
    }

def start_sensor_streaming():
    import threading

    def stream_loop():
        while True:
            t = time.time()
            buffers["timestamps"].append(t)
            buffers["hrv"].append(simulate_hrv(t))
            buffers["gsr"].append(simulate_gsr(t))
            buffers["temp"].append(simulate_temp(t))
            buffers["ppg"].append(simulate_pulse(t))
            buffers["spo2"].append(simulate_spo2(t))
            time.sleep(1)

    thread = threading.Thread(target=stream_loop, daemon=True)
    thread.start()

# ----------- Launch Animation -----------

ani = FuncAnimation(fig, update, interval=1000)
plt.tight_layout()
plt.show()
