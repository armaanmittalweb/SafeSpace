// Dispatches a user's file to the right parser. Runs inside the import worker (worker.ts);
// tests call it directly.
import { AppleHealthParser } from './apple';
import { e4Channel, parseE4, type E4Files } from './e4';
import { FitbitParser, fitbitFileKind } from './fitbit';
import { baseName, isZip, readZipTexts, streamText, streamZipText, type Progress } from './stream';
import type { ImportKind, ImportOptions, ImportResult } from './types';

export async function parseImport(kind: ImportKind, file: Blob & { name?: string }, onProgress?: Progress, opts: ImportOptions = {}): Promise<ImportResult> {
  const zip = await isZip(file);
  if (kind === 'import-apple') {
    const p = new AppleHealthParser();
    if (zip) {
      let found = false;
      await streamZipText(file, {
        // export.xml only; export_cda.xml (clinical documents) and routes are skipped.
        want: (n) => { const ok = baseName(n) === 'export.xml'; found ||= ok; return ok; },
        onText: (_n, text) => p.push(text),
      }, onProgress);
      if (!found) throw new Error('This zip has no export.xml. Use the export.zip that the Health app makes (tap your picture, then Export All Health Data).');
    } else {
      await streamText(file, (t) => p.push(t), onProgress);
    }
    return p.finish(opts);
  }
  if (kind === 'import-fitbit') {
    const p = new FitbitParser();
    if (zip) {
      await readZipTexts(file, (n) => fitbitFileKind(n) != null, (n, t) => p.addFile(n, t), onProgress);
    } else {
      p.addFile(file.name ?? '', await file.text());
      onProgress?.(1);
    }
    return p.finish(opts);
  }
  // Empatica E4
  if (!zip) throw new Error('Choose the session zip from E4 connect, not a single file.');
  const files: E4Files = {};
  await readZipTexts(file, (n) => e4Channel(n) != null, (n, t) => { files[e4Channel(n)!] = t; }, onProgress);
  const m = /(\d{9,11})_([A-Z0-9]{6})/.exec(file.name ?? '');
  return parseE4(files, { ...opts, device: m ? `Empatica E4 ${m[2]}` : 'Empatica E4' });
}
