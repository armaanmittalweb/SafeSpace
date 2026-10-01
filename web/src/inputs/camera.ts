// Phone camera as a pulse sensor: fingertip over the rear lens with the flash on (front camera or
// webcam as a rougher fallback). Only the mean colour of the centre of each frame is read; frames are
// never stored or sent anywhere.
import type { LiveInput } from '../contract/inputs';
import { pulseConnection, type FramePump } from '../pulse/live';
import type { Frame, MotionSample } from '../pulse/ppg';

const ROI = 32; // the centre of the frame is averaged at 32×32

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; captureTime?: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};
type TorchCaps = MediaTrackCapabilities & { torch?: boolean };
type DME = typeof DeviceMotionEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };

async function openStream(): Promise<{ stream: MediaStream; track: MediaStreamTrack; torch: boolean; facing: string }> {
  const base: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 60 } };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { ...base, facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    if ((e as DOMException).name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    else throw e;
  }
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings() as MediaTrackSettings & { facingMode?: string };
  let torch = false;
  const caps = (track.getCapabilities?.() ?? {}) as TorchCaps;
  if (caps.torch) {
    try {
      await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] });
      torch = true;
    } catch { /* some phones refuse; the reading will be rougher */ }
  }
  return { stream, track, torch, facing: settings.facingMode ?? '' };
}

function pumpFor(stream: MediaStream, track: MediaStreamTrack, torch: boolean, device: string): FramePump {
  return {
    device,
    torch,
    start(onFrame, onMotion, onEnded) {
      const video = document.createElement('video') as VideoWithRvfc;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('aria-hidden', 'true');
      // iOS only decodes frames for a video that is in the document.
      Object.assign(video.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
      document.body.appendChild(video);
      video.srcObject = stream;
      void video.play().catch(() => { /* retried on the first frame callback */ });
      const canvas = document.createElement('canvas');
      canvas.width = ROI; canvas.height = ROI;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      let stopped = false;
      let handle = 0;
      let lastMediaTime = -1;

      const grab = (tEpoch: number) => {
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        const s = Math.min(vw, vh) * 0.5;
        ctx.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, ROI, ROI);
        const d = ctx.getImageData(0, 0, ROI, ROI).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        const f: Frame = { t: tEpoch, r: r / n, g: g / n, b: b / n };
        onFrame(f);
      };
      const toEpoch = (perfNow: number) => performance.timeOrigin + perfNow;
      if (video.requestVideoFrameCallback) {
        const loop = (now: number, meta: { mediaTime: number; captureTime?: number }) => {
          if (stopped) return;
          grab(toEpoch(meta.captureTime ?? now));
          handle = video.requestVideoFrameCallback!(loop);
        };
        handle = video.requestVideoFrameCallback(loop);
      } else {
        const loop = (now: number) => {
          if (stopped) return;
          if (video.currentTime !== lastMediaTime) { lastMediaTime = video.currentTime; grab(toEpoch(now)); }
          handle = requestAnimationFrame(loop);
        };
        handle = requestAnimationFrame(loop);
      }

      const onDm = (e: DeviceMotionEvent) => {
        const a = e.acceleration;
        let mag: number | null = null;
        if (a && a.x != null && a.y != null && a.z != null) mag = Math.hypot(a.x, a.y, a.z);
        else {
          const g = e.accelerationIncludingGravity;
          if (g && g.x != null && g.y != null && g.z != null) mag = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
        }
        if (mag != null) onMotion({ t: Date.now(), a: mag } satisfies MotionSample);
      };
      addEventListener('devicemotion', onDm);
      track.addEventListener('ended', onEnded);

      return () => {
        stopped = true;
        if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle);
        removeEventListener('devicemotion', onDm);
        track.removeEventListener('ended', onEnded);
        if (torch) void track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] }).catch(() => {});
        for (const t of stream.getTracks()) t.stop();
        video.srcObject = null;
        video.remove();
      };
    },
  };
}

export const camera: LiveInput = {
  id: 'camera',
  kind: 'live',
  label: 'Phone camera',
  gives: ['hr', 'hrv'],
  async available() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return { ok: false, reason: 'This browser cannot use the camera. Try Chrome, Safari or Edge.' };
    }
    if (!isSecureContext) return { ok: false, reason: 'The camera only works on a secure (https) page.' };
    return { ok: true };
  },
  async connect() {
    // iOS asks for motion access separately, and only from a tap; a refusal just means no motion check.
    const dme = (typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : null) as DME | null;
    if (dme?.requestPermission) void dme.requestPermission().catch(() => 'denied');
    const { stream, track, torch, facing } = await openStream();
    const device = torch ? 'Rear camera with flash' : facing === 'user' ? 'Front camera' : facing === 'environment' ? 'Rear camera, no flash' : 'Camera';
    return pulseConnection(pumpFor(stream, track, torch, device));
  },
};
