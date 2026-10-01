// File-import providers. Each parse() runs in a Web Worker; the file is read locally and
// only per-window Measurements (and a daily list) come back.
import type { FileInput } from '../contract';
import type { WorkerMessage, WorkerRequest } from './worker';
import type { ImportKind, ImportOptions, ImportResult } from './types';

export type { DailyContext, ImportResult } from './types';

export function parseInWorker(kind: ImportKind, file: File, onProgress?: (f: number) => void, opts?: ImportOptions): Promise<ImportResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'safespace-import' });
    w.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress?.(m.fraction);
      else {
        w.terminate();
        if (m.type === 'done') resolve(m.result);
        else reject(new Error(m.message));
      }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The file could not be read.')); };
    w.postMessage({ kind, file, opts } satisfies WorkerRequest);
  });
}

const workers = async () => (typeof Worker === 'undefined'
  ? { ok: false as const, reason: 'This browser cannot read files in the background. Update it and try again.' }
  : { ok: true as const });

export interface FileInputInfo extends FileInput {
  /** Where to get the file, one sentence. */
  how: string;
  /** Short list of what comes in, for the Devices panel. */
  brings: string;
}

export const appleHealth: FileInputInfo = {
  kind: 'file', id: 'import-apple', label: 'Apple Health', gives: ['hr', 'hrv'], accept: '.zip,.xml',
  how: 'In the Health app, tap your picture, then Export All Health Data. Choose the export.zip here.',
  brings: 'Heart rate, HRV (SDNN), resting heart rate',
  available: workers,
  parse: (file, onProgress) => parseInWorker('import-apple', file, onProgress),
};
export const fitbit: FileInputInfo = {
  kind: 'file', id: 'import-fitbit', label: 'Fitbit', gives: ['hr', 'hrv'], accept: '.zip,.json,.csv',
  how: 'Download your Fitbit data from Google Takeout (select Fitbit) and choose the zip here.',
  brings: 'Heart rate, overnight HRV, resting heart rate',
  available: workers,
  parse: (file, onProgress) => parseInWorker('import-fitbit', file, onProgress),
};
export const empaticaE4: FileInputInfo = {
  kind: 'file', id: 'import-e4', label: 'Empatica E4', gives: ['hr', 'hrv', 'eda', 'temp'], accept: '.zip',
  how: 'Download a session from E4 connect and choose the zip here.',
  brings: 'All four signals: heart rate, HRV, skin conductance and temperature',
  available: workers,
  parse: (file, onProgress) => parseInWorker('import-e4', file, onProgress),
};

export const FILE_INPUTS: FileInputInfo[] = [appleHealth, fitbit, empaticaE4];
