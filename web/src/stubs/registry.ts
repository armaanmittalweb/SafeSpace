// STUB for web/src/inputs/registry.ts (inputs agent): the providers the contract lists, with honest
// availability, so the Devices tab and the check-in's input choice can be built. Connecting or importing
// says the feature is not in this build. The camera is the real one.
import type { AnyInput, FileInput, LiveInput } from '../contract/inputs';
import type { InputSource, Signal } from '../contract/records';
import { camera } from '../inputs/camera';

function bluetoothReason(): string | null {
  const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { bluetooth?: unknown }) : null;
  if (nav && nav.bluetooth) return null;
  const ua = nav?.userAgent ?? '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'Safari on iPhone has no Bluetooth. Use the camera or import a file.';
  if (/Firefox\//.test(ua)) return 'Firefox has no Web Bluetooth. Use Chrome or Edge, or the camera.';
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari has no Web Bluetooth. Use Chrome or Edge, or the camera.';
  return 'This browser has no Web Bluetooth. Use Chrome or Edge, or the camera.';
}
const notYet = () => Promise.reject(new DOMException('Not in this build yet.', 'NotSupportedError'));

function live(id: InputSource, label: string, gives: Signal[]): LiveInput {
  return {
    id, kind: 'live', label, gives,
    async available() { const r = bluetoothReason(); return r ? { ok: false, reason: r } : { ok: true }; },
    connect: notYet,
  };
}
function file(id: InputSource, label: string, gives: Signal[], accept: string): FileInput {
  return { id, kind: 'file', label, gives, accept, async available() { return { ok: true }; }, parse: notYet };
}

export const INPUTS: AnyInput[] = [
  live('ble-hr', 'Heart-rate strap or watch', ['hr', 'hrv']),
  live('polar-h10', 'Polar H10 chest strap', ['hr', 'hrv']),
  camera,
  file('import-apple', 'Apple Health export', ['hr', 'hrv'], '.zip,.xml'),
  file('import-fitbit', 'Fitbit export', ['hr', 'hrv'], '.zip,.json'),
  file('import-e4', 'Empatica E4 session', ['hr', 'hrv', 'eda', 'temp'], '.zip'),
];
