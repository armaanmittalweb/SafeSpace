// Every input SafeSpace can take, in display order (contract: INPUTS: (LiveInput | FileInput)[]).
//
// The camera provider is written by the app agent in ./camera.ts. It is picked up here with
// an eager import.meta.glob, so this file compiles and runs whether or not camera.ts exists
// yet: camera.ts should export a LiveInput whose id is 'camera' (any export name). Until it
// does, a placeholder takes its slot and says the camera is not available.
import type { AnyInput, FileInput, InputSource, LiveInput } from '../contract';
import { empaticaE4, fitbit, appleHealth, FILE_INPUTS } from '../imports';
import { bleHr, polarH10 } from './ble-hr';

const found = import.meta.glob<Record<string, unknown>>('./camera.ts', { eager: true });

function findCamera(): LiveInput | null {
  for (const mod of Object.values(found)) {
    for (const v of Object.values(mod)) {
      const x = v as Partial<LiveInput> | null;
      if (x && typeof x === 'object' && x.id === 'camera' && typeof x.connect === 'function') return x as LiveInput;
    }
  }
  return null;
}

export const cameraPlaceholder: LiveInput = {
  kind: 'live', id: 'camera', label: 'Phone camera', gives: ['hr', 'hrv'],
  available: async () => ({ ok: false, reason: 'The camera reading is not part of this build yet.' }),
  connect: async () => { throw new DOMException('The camera reading is not part of this build yet.', 'NotSupportedError'); },
};

let camera: LiveInput = findCamera() ?? cameraPlaceholder;

/** Lets camera.ts (or a test) register itself explicitly instead of relying on the glob. */
export function registerCamera(p: LiveInput) {
  camera = p;
  const i = INPUTS.findIndex((x) => x.id === 'camera');
  if (i >= 0) INPUTS[i] = p;
}

/**
 * Bluetooth first (the most accurate), then the camera, then file imports. The Polar H10
 * is not listed separately: connecting any strap named "Polar H10" through bleHr turns on
 * its extras (chest motion, ECG) automatically. polarH10 is exported for a filtered chooser.
 */
export const INPUTS: AnyInput[] = [bleHr, camera, appleHealth, fitbit, empaticaE4];

export const LIVE_INPUTS = (): LiveInput[] => INPUTS.filter((x): x is LiveInput => x.kind === 'live');
export const FILE_INPUTS_LIST: FileInput[] = FILE_INPUTS;
export const inputById = (id: InputSource): AnyInput | undefined => INPUTS.find((x) => x.id === id) ?? (id === 'polar-h10' ? polarH10 : undefined);

export { bleHr, polarH10 };
