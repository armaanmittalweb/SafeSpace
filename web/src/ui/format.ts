const MINUS = '−';

export function fmt(x: number, digits = 2): string {
  const s = x.toFixed(digits);
  return s.startsWith('-') ? (Number(s) === 0 ? s.slice(1) : MINUS + s.slice(1)) : s;
}

export function fmtSigned(x: number, digits = 2): string {
  const s = fmt(x, digits);
  if (s.startsWith(MINUS)) return s;
  return Number(s) === 0 ? s : '+' + s;
}

/** Simulated minutes as mm:ss. */
export function clock(min: number): string {
  const total = Math.max(0, Math.round(min * 60));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
