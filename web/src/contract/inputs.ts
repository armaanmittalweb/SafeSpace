// The input interface: providers register in web/src/inputs/registry.ts; the app consumes them.
import type { InputSource, Measurement, Quality, Signal } from './records';

// Re-exported so modules written against the inputs agent's first copy of this file
// (which held the record shapes too) keep compiling against this one.
export type { BeatSeries, FeatureName, InputSource, Measurement, Quality, Signal, ActivityId, ActivityResult, StressSession, PersonalModel } from './records';
export type { ActivityDef, ActivityProps } from './activities';

export type Availability = { ok: true } | { ok: false; reason: string };

export interface InputProvider {
  id: InputSource;
  /** "Heart-rate strap or watch" */
  label: string;
  /** what it can measure */
  gives: Signal[];
  /** e.g. "Safari on iPhone has no Bluetooth. Use the camera or import a file." */
  available(): Promise<Availability>;
}

export interface Beat { t: number; rr: number | null; hr: number }

export interface LiveConnection {
  device: string;
  onBeat(cb: (beat: Beat) => void): () => void;
  onQuality(cb: (q: Quality, why: string | null) => void): () => void;
  measure(durationS: number, signal?: AbortSignal): Promise<Measurement>;
  disconnect(): Promise<void>;
  /** Amendment (app agent): optional waveform for the live trace, one value per sample, t = epoch ms.
   * The camera sends its filtered pulse wave; a strap without raw data leaves this out. */
  onSample?(cb: (s: { t: number; v: number }) => void): () => void;
  /** Amendment (app agent): battery percentage if the device reports it. */
  battery?(): Promise<number | null>;
  /** Amendment (app agent): fires once if the device goes away on its own (strap out of range, camera track ended). */
  onDisconnect?(cb: () => void): () => void;
}

export interface LiveInput extends InputProvider {
  /** must be called from a click (Web Bluetooth and camera both need a gesture) */
  connect(): Promise<LiveConnection>;
}

export interface FileInput extends InputProvider {
  /** ".zip,.xml" */
  accept: string;
  /** parsed in a Web Worker, never uploaded */
  parse(file: File, onProgress?: (fraction: number) => void): Promise<{ measurements: Measurement[]; summary: string }>;
}

/** web/src/inputs/registry.ts exports `INPUTS: (LiveInput | FileInput)[]` (amendment, app agent). */
export type AnyInput = LiveInput | FileInput;
export const isLive = (p: AnyInput): p is LiveInput => 'connect' in p;
export const isFile = (p: AnyInput): p is FileInput => 'parse' in p;

/** Errors thrown by connect(): `name` tells the app which designed state to show. */
export type InputErrorName = 'NotAllowedError' | 'NotFoundError' | 'NotSupportedError' | 'AbortError' | 'NetworkError';
