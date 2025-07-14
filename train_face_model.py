"""
Rule-based facial stress detector
Geometry (MediaPipe) + Dominant Emotion (DeepFace)
-------------------------------------------------
• Run   python stress_cv_emotion.py
• Press 'c'   → 30-s calm calibration
• Press ESC   → quit
"""
import cv2, time, collections, numpy as np, threading, os
from deepface import DeepFace
import mediapipe as mp
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
mp_face = mp.solutions.face_mesh
mesh     = mp_face.FaceMesh(static_image_mode=False, max_num_faces=1)
LMS = {"LEU":159,"LED":145,"REU":386,"RED":374,"LBROW":70,"NOSE":1}
def p(lm,i,w,h): pt=lm[i]; return np.array((pt.x*w,pt.y*h))
def dist(a,b):  return np.linalg.norm(a-b)

emotion_lock = threading.Lock()
dominant_emotion, last_em_time = "unknown", 0
stress_emotions = {"angry","fear","disgust","sad"}
def emotion_worker(frame):
    global dominant_emotion, last_em_time
    try:
        res = DeepFace.analyze(frame, actions=["emotion"], enforce_detection=False)
        with emotion_lock:
            dominant_emotion = res[0]["dominant_emotion"]
            last_em_time = time.time()
    except: pass

baseline = {"eye":None,"brow":None,"blink":15}
blink_hist = collections.deque(maxlen=120) 
blink_ts   = []
EAR_BLINK  = 8           
state, consec = "UNCAL", 0
label, color = "CALIBRATE (press c)", (255,255,0)

cap = cv2.VideoCapture(0)
print("Press  c  to calibrate 30 s calm face,  ESC quit")

while True:
    ok, frame = cap.read()
    if not ok: break
    h,w = frame.shape[:2]
    results = mesh.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))

    if results.multi_face_landmarks:
        lm = results.multi_face_landmarks[0].landmark
        LEU, LED = p(lm,LMS["LEU"],w,h), p(lm,LMS["LED"],w,h)
        REU, RED = p(lm,LMS["REU"],w,h), p(lm,LMS["RED"],w,h)
        eye_ctr  = (LEU+LED)/2
        brow     = p(lm,LMS["LBROW"],w,h)
        nose     = p(lm,LMS["NOSE"],w,h)

        eye_open = (dist(LEU,LED)+dist(REU,RED))/2
        brow_gap = dist(brow, eye_ctr)

        blink_hist.append(eye_open)
        if len(blink_hist)==blink_hist.maxlen and blink_hist[-2]<EAR_BLINK<=blink_hist[-1]:
            blink_ts.append(time.time())

        key=cv2.waitKey(1)
        if key==ord('c') and state=="UNCAL":
            print("[CAL] Collecting 30 s calm baseline…")
            samples=[]
            start=time.time()
            while time.time()-start<30:
                ok2,f2=cap.read()
                if not ok2: break
                res2=mesh.process(cv2.cvtColor(f2,cv2.COLOR_BGR2RGB))
                if res2.multi_face_landmarks:
                    lm2=res2.multi_face_landmarks[0].landmark
                    e=(dist(p(lm2,LMS["LEU"],w,h),p(lm2,LMS["LED"],w,h))+dist(p(lm2,LMS["REU"],w,h),p(lm2,LMS["RED"],w,h)))/2
                    ctr=(p(lm2,LMS["LEU"],w,h)+p(lm2,LMS["LED"],w,h))/2
                    b=dist(p(lm2,LMS["LBROW"],w,h), ctr)
                    samples.append((e,b))
                cv2.imshow("Stress+Emotion",f2); cv2.waitKey(1)
            if samples:
                baseline["eye"]=np.mean([s[0] for s in samples])
                baseline["brow"]=np.mean([s[1] for s in samples])
                state="READY";  label="CALM"; color=(0,255,0)
                print("[CAL] Done.")
            continue

        if time.time()-last_em_time > 1:
            threading.Thread(target=emotion_worker,args=(frame.copy(),),daemon=True).start()

        if state=="READY":
            eye_drop  =(baseline["eye"]-eye_open)/baseline["eye"]
            brow_drop =(baseline["brow"]-brow_gap)/baseline["brow"]

            blink_ts=[t for t in blink_ts if time.time()-t<30]
            blink_rate=len(blink_ts)*2  
            blink_rise=(blink_rate-baseline["blink"])/baseline["blink"]

            with emotion_lock:
                em=dominant_emotion
            em_flag=1 if em in stress_emotions else 0

            stress_score=0.35*eye_drop+0.35*brow_drop+0.15*max(0,blink_rise)+0.15*em_flag
            stressed_now=stress_score>0.45

            consec=consec+1 if stressed_now else max(0,consec-1)
            if consec>=15:
                label, color="STRESSED",(0,0,255)
            elif consec==0:
                label, color="CALM",(0,255,0)
            txt=f"EyeΔ {eye_drop:+.2f} BrowΔ {brow_drop:+.2f} BlinkΔ {blink_rise:+.2f} {em}"
            cv2.putText(frame,txt,(10,h-20),cv2.FONT_HERSHEY_SIMPLEX,0.5,(200,200,200),1)
    cv2.putText(frame,label,(10,40),cv2.FONT_HERSHEY_SIMPLEX,1.0,color,3)
    cv2.imshow("Stress+Emotion",frame)
    if cv2.waitKey(1)&0xFF==27: break

cap.release(); cv2.destroyAllWindows()
