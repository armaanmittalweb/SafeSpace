// A small history router: paths are real URLs (so they can be shared and indexed), links are plain <a>.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

const subs = new Set<() => void>();
const current = () => location.pathname.replace(/\/+$/, '') || '/';

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  window.scrollTo(0, 0);
  for (const cb of subs) cb();
}
if (typeof window !== 'undefined') addEventListener('popstate', () => { for (const cb of subs) cb(); });

export function usePath(): string {
  const [p, setP] = useState(current);
  useEffect(() => {
    const cb = () => setP(current());
    subs.add(cb);
    return () => { subs.delete(cb); };
  }, []);
  return p;
}

type AProps = JSX.HTMLAttributes<HTMLAnchorElement> & { href: string; children?: ComponentChildren };
export function Link({ href, onClick, ...rest }: AProps) {
  return (
    <a href={href} {...rest} onClick={(e) => {
      onClick?.(e as never);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || /^https?:/.test(href)) return;
      e.preventDefault();
      navigate(href);
    }} />
  );
}

const INDEXABLE = new Set(['/', '/how-it-works']);
/** Title and robots per route; app-only routes are noindex. */
export function useMeta(title: string, path: string) {
  useEffect(() => {
    document.title = title;
    let m = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!INDEXABLE.has(path)) {
      if (!m) { m = document.createElement('meta'); m.name = 'robots'; document.head.appendChild(m); }
      m.content = 'noindex';
    } else m?.remove();
  }, [title, path]);
}
