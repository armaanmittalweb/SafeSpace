export { fmt, fmtSigned } from '../ui/format';

const DAY = 864e5;
export const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

export const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);
/** Monday-first week start. */
export const startOfWeek = (t: number) => { const s = startOfDay(t); const wd = (new Date(s).getDay() + 6) % 7; return s - wd * DAY; };
export const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };

export const time = (t: number) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const dayMonth = (t: number) => { const d = new Date(t); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`; };
/** "Wed 30 Sep, 18:20" */
export const stamp = (t: number) => `${DAYS_SHORT[new Date(t).getDay()]} ${dayMonth(t)}, ${time(t)}`;
/** "Wednesday 30 September" */
export const longDate = (t: number) => { const d = new Date(t); return `${DAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

/** "Today", "Yesterday", "Monday", "12 Sep" */
export function relDay(t: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(t)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DAYS_LONG[new Date(t).getDay()];
  return dayMonth(t);
}
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const r = relDay(t, now);
  return r === 'Today' || r === 'Yesterday' ? r.toLowerCase() : `on ${r}`;
}
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
