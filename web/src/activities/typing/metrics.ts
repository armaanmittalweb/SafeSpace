// Typing check: timing only. The recorder is fed key-down/up events and the input box's
// value after each change; it keeps timestamps, lengths and right/wrong flags, never the
// characters or key codes. Key codes are used for a moment to pair a key-down with its
// key-up (hold time) and are dropped when the key is released.
import { finite, mean, median, round, sd } from '../stats';

export const PASSAGES = [
  'The morning train was late again, so she read the timetable twice and then watched the rain run along the window. Nobody seemed to mind the wait very much.',
  'A small bakery on the corner opens at six. By seven the queue reaches the door, and the owner still greets every person by name while the bread cools.',
  'He planted the tomatoes in a sunny row beside the fence, watered them each evening, and wrote the date of the first flower in a notebook by the door.',
  'The library keeps a map of the old town on the wall near the stairs. Visitors often stop to find their own street and the shops that used to stand there.',
  'After the meeting they walked down to the river, where the path follows the water for a mile before turning back towards the bridge and the car park.',
];

/** Gaps longer than this between typed characters count as pauses, not typing rhythm. */
export const PAUSE_MS = 2000;

interface Insert { t: number; correct: boolean }

export class TypingRecorder {
  private readonly target: string;
  private downs = new Map<string, number>(); // code -> down time, only while the key is held
  private holds: number[] = [];
  private lastUp: number | null = null;
  private flights: number[] = [];
  private inserts: Insert[] = [];
  private deletions = 0;
  private prevLen = 0;
  private correctLen = 0;
  private firstAt: number | null = null;
  private lastAt: number | null = null;
  keyEvents = 0;

  constructor(passage: string) { this.target = passage; }

  keyDown(code: string, t: number): void {
    this.keyEvents++;
    if (this.downs.has(code)) return; // auto-repeat
    this.downs.set(code, t);
    if (this.lastUp != null && t - this.lastUp < PAUSE_MS && t >= this.lastUp) this.flights.push(t - this.lastUp);
  }

  keyUp(code: string, t: number): void {
    const d = this.downs.get(code);
    this.downs.delete(code);
    if (d != null && t - d < 1500) this.holds.push(t - d);
    this.lastUp = t;
  }

  /**
   * The box's value after an input event. Only the length change and whether each new
   * character matches the passage at its position are kept; `value` itself is not stored.
   */
  input(value: string, t: number): void {
    this.firstAt ??= t;
    this.lastAt = t;
    const len = value.length;
    if (len < this.prevLen) {
      this.deletions += 1;
    } else {
      for (let i = this.prevLen; i < len; i++) this.inserts.push({ t, correct: value[i] === this.target[i] });
    }
    this.prevLen = len;
    let c = 0;
    while (c < len && value[c] === this.target[c]) c++;
    this.correctLen = c;
  }

  /** True once the passage has been typed correctly to the end. */
  get finished(): boolean { return this.correctLen >= this.target.length; }
  /** Share of the passage typed correctly so far, 0..1. */
  get progress(): number { return this.correctLen / this.target.length; }
  get correctPrefix(): number { return this.correctLen; }

  result(): Record<string, number> {
    const times = this.inserts.map((x) => x.t);
    const gaps: number[] = [];
    let pauses = 0;
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g <= 0) continue; // several characters in one input event (autocomplete, paste)
      if (g > PAUSE_MS) pauses++; else gaps.push(g);
    }
    const typed = this.inserts.length;
    const wrong = this.inserts.filter((x) => !x.correct).length;
    const activeMin = this.firstAt != null && this.lastAt != null ? (this.lastAt - this.firstAt) / 60000 : 0;
    const gm = mean(gaps);
    return finite({
      wpm: activeMin > 0 ? round(this.correctLen / 5 / activeMin, 1) : NaN,
      holdMeanMs: round(mean(this.holds)),
      holdSdMs: round(sd(this.holds)),
      flightMeanMs: round(mean(this.flights)),
      flightSdMs: round(sd(this.flights)),
      interKeyMeanMs: round(gm),
      interKeySdMs: round(sd(gaps)),
      interKeyCv: round(sd(gaps) / gm, 3),
      interKeyMedianMs: round(median(gaps)),
      errorRate: typed ? round(wrong / typed, 3) : NaN,
      corrections: this.deletions,
      pauses,
      charsTyped: typed,
      progress: round(this.progress, 3),
    });
  }
}
