// Theme per device: 'system' follows the OS; 'light' and 'dark' (the night panel) pin it.
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'ss-theme';

export function readTheme(): ThemePref {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
export function applyTheme(p: ThemePref = readTheme()) {
  const root = document.documentElement;
  if (p === 'system') delete root.dataset.theme; else root.dataset.theme = p;
  const dark = p === 'dark' || (p === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b1210' : '#edf2ee');
}
export function setTheme(p: ThemePref) {
  try { if (p === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch { /* private mode */ }
  applyTheme(p);
}
