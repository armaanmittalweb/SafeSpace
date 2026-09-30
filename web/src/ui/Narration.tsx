import { useEffect, useState } from 'preact/hooks';
import { rewriteNarration, narrateHookEnabled } from '../narrate/hook';
import type { Narration as N } from '../narrate/templates';
import type { ReadingSet } from '../model/score';

export function Narration({ n, readings, settled, inCal }: { n: N | null; readings: ReadingSet | null; settled: boolean; inCal: boolean }) {
  const [rewritten, setRewritten] = useState<{ key: string; summary: string; tip: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const key = n ? n.summary + n.tip : '';

  // Optional LLM rewrite: only when the recorder is paused, never per frame.
  useEffect(() => {
    if (!narrateHookEnabled || !settled || !n) return;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      setBusy(true);
      const scores = Object.fromEntries(Object.entries(readings ?? {}).map(([k, r]) => [k, r ? r.score : null]));
      const out = await rewriteNarration(n, scores, ctl.signal);
      setBusy(false);
      if (out) setRewritten({ key, ...out });
    }, 600);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [key, settled]);

  const use = rewritten && rewritten.key === key ? rewritten : null;
  if (inCal || !n) {
    return (
      <section class="narration empty" aria-labelledby="narr-h">
        <h2 id="narr-h" class="kicker">Narration</h2>
        <p class="summary">Sit still for five minutes.</p>
        <p class="tip-line">The first five minutes set your resting reference. Every score is measured in resting standard deviations from it, so nothing is said until it is done.</p>
      </section>
    );
  }
  return (
    <section class="narration" aria-labelledby="narr-h">
      <h2 id="narr-h" class="kicker">
        Narration <span class="source">{use ? 'rewritten by the narration service' : busy ? 'rewriting...' : 'template'}</span>
      </h2>
      <p class="summary">{use ? use.summary : n.summary}</p>
      <p class="tip-line"><span class="tip-mark">Tip</span> {use ? use.tip : n.tip}</p>
      {n.caveat && <p class="caveat">{n.caveat}</p>}
      {n.lines.length > 0 && (
        <ul class="lines" aria-label="Per signal">
          {n.lines.map((l) => <li key={l.signal}>{l.text}</li>)}
        </ul>
      )}
    </section>
  );
}
