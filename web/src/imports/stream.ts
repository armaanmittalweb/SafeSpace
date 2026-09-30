// Streaming reads of a user's file, inside the import worker. Nothing is uploaded; the
// raw file is read once, chunk by chunk, and only per-window Measurements come out.
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';

export type Progress = (fraction: number) => void;

async function eachChunk(blob: Blob, onChunk: (c: Uint8Array) => void, onProgress?: Progress): Promise<void> {
  const reader = blob.stream().getReader();
  let read = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    onChunk(value);
    if (onProgress && (read - lastReport > blob.size / 200 || read === blob.size)) {
      lastReport = read;
      onProgress(Math.min(read / Math.max(blob.size, 1), 1));
    }
  }
}

export const isZip = async (blob: Blob) => {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
};

/** Streams a plain text file to onText in decoded pieces. */
export async function streamText(blob: Blob, onText: (s: string) => void, onProgress?: Progress): Promise<void> {
  const dec = new TextDecoder();
  await eachChunk(blob, (c) => onText(dec.decode(c, { stream: true })), onProgress);
  const tail = dec.decode();
  if (tail) onText(tail);
}

export interface ZipEntryHandler {
  /** Return true to read this entry (by path inside the zip). */
  want(name: string): boolean;
  /** Decoded text of a wanted entry, in pieces; `final` is true on the last piece. */
  onText(name: string, text: string, final: boolean): void;
}

/**
 * Streams a zip, inflating only the wanted entries and decoding them as UTF-8 text.
 * Entries arrive in archive order.
 */
export async function streamZipText(blob: Blob, h: ZipEntryHandler, onProgress?: Progress): Promise<string[]> {
  const seen: string[] = [];
  let failure: Error | null = null;
  const unzip = new Unzip((file: UnzipFile) => {
    seen.push(file.name);
    if (!h.want(file.name)) return;
    const dec = new TextDecoder();
    file.ondata = (err, data, final) => {
      if (err) { failure = err; return; }
      const text = dec.decode(data, { stream: !final });
      h.onText(file.name, text, final);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  await eachChunk(blob, (c) => { if (!failure) unzip.push(c, false); }, onProgress);
  if (!failure) unzip.push(new Uint8Array(0), true);
  if (failure) throw new Error(`The zip file could not be read: ${(failure as Error).message}`);
  return seen;
}

/** Collects whole wanted entries as strings (for small files such as CSVs and daily JSONs). */
export async function readZipTexts(blob: Blob, want: (name: string) => boolean, onEntry: (name: string, text: string) => void, onProgress?: Progress): Promise<string[]> {
  const parts = new Map<string, string[]>();
  return streamZipText(blob, {
    want,
    onText(name, text, final) {
      let p = parts.get(name);
      if (!p) parts.set(name, (p = []));
      p.push(text);
      if (final) { parts.delete(name); onEntry(name, p.join('')); }
    },
  }, onProgress);
}

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
