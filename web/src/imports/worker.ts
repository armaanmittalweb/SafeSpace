// The import worker: files are parsed off the main thread and never leave the device.
import { parseImport } from './parse';
import type { ImportKind, ImportOptions } from './types';

export type WorkerRequest = { kind: ImportKind; file: File; opts?: ImportOptions };
export type WorkerMessage =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: Awaited<ReturnType<typeof parseImport>> }
  | { type: 'error'; message: string };

const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    const result = await parseImport(e.data.kind, e.data.file, (fraction) => post({ type: 'progress', fraction }), e.data.opts);
    post({ type: 'done', result });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
