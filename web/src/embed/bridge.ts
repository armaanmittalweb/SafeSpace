// postMessage bridge for the portfolio Lab. Both directions are pinned to the allowed
// origins: incoming messages from anywhere else are ignored, and outgoing messages are
// addressed to each allowed origin explicitly (the browser drops any that do not match
// the parent), never to '*'.
import { SIGNALS, type Signal } from '../model/score';

export const ALLOWED_ORIGINS = ['https://www.amittal.dev', 'http://localhost:5173'];

export type Outgoing =
  | { type: 'ready' }
  | { type: 'height'; px: number }
  | { type: 'stage'; i: number; name: string; ms: number; ok: boolean };

export type Command =
  | { type: 'command'; name: 'play' | 'refit' | 'reset' }
  | { type: 'command'; name: 'pull'; signal: Signal };

export type Incoming = { type: 'theme'; tokens: Record<string, string> } | Command;

/** The parent's origin if it is known to be allowed: from ancestorOrigins, the referrer,
 * or the first valid message it sent. */
let parentOrigin: string | null = (() => {
  const anc = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0];
  let ref: string | null = null;
  try { ref = document.referrer ? new URL(document.referrer).origin : null; } catch { /* no referrer */ }
  return [anc, ref].find((o): o is string => !!o && ALLOWED_ORIGINS.includes(o)) ?? null;
})();

export function post(msg: Outgoing) {
  if (window.parent === window) return;
  const targets = parentOrigin ? [parentOrigin] : ALLOWED_ORIGINS;
  for (const origin of targets) {
    try { window.parent.postMessage(msg, origin); } catch { /* not this origin */ }
  }
}

export function parseIncoming(e: MessageEvent): Incoming | null {
  if (!ALLOWED_ORIGINS.includes(e.origin)) return null;
  if (window.parent !== window && e.source !== window.parent) return null;
  if (window.parent !== window) parentOrigin = e.origin;
  const d = e.data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  if (d.type === 'theme' && d.tokens && typeof d.tokens === 'object') {
    return { type: 'theme', tokens: d.tokens as Record<string, string> };
  }
  if (d.type === 'command') {
    if (d.name === 'play' || d.name === 'refit' || d.name === 'reset') return { type: 'command', name: d.name };
    if (d.name === 'pull' && SIGNALS.includes(d.signal as Signal)) return { type: 'command', name: 'pull', signal: d.signal as Signal };
  }
  return null;
}

// Theme tokens the host may set, and the CSS custom property each one drives.
const TOKEN_VARS: Record<string, string> = {
  bg: '--bg', paper: '--paper', ink: '--ink', ink2: '--ink-2', muted: '--muted', line: '--line', rule: '--rule',
  grid: '--grid', gridMajor: '--grid-major', calm: '--calm', stress: '--stress', calmInk: '--calm-ink',
  stressInk: '--stress-ink', focus: '--focus', sans: '--sans', mono: '--mono',
};
const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/+-]+\)|oklch\([\d\s.,%/+-]+\)|transparent)$/i;
const FONT = /^[\w\s,'"-]{1,200}$/;

export function applyTheme(tokens: Record<string, string>) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) {
    const key = k.replace(/^--/, '').replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    if (key === 'scheme' && (v === 'light' || v === 'dark')) { root.dataset.theme = v; continue; }
    const cssVar = TOKEN_VARS[key];
    if (!cssVar || typeof v !== 'string') continue;
    const ok = key === 'sans' || key === 'mono' ? FONT.test(v) : COLOR.test(v.trim());
    if (ok) root.style.setProperty(cssVar, v.trim());
  }
}
