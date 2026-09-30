// Optional hook for a future LLM rewrite service. Nothing here runs unless the build sets
// VITE_NARRATE_URL; without it the app shows the template sentences only. The service is
// expected to accept POST {summary, tip, scores} and return {summary, tip} as JSON.
import type { Narration } from './templates';

const URL_ = (import.meta.env.VITE_NARRATE_URL as string | undefined) || '';
export const narrateHookEnabled = URL_.length > 0;

export async function rewriteNarration(
  n: Narration,
  scores: Record<string, number | null>,
  signal: AbortSignal,
): Promise<{ summary: string; tip: string } | null> {
  if (!narrateHookEnabled) return null;
  const timeout = AbortSignal.timeout(4000);
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: n.summary, tip: n.tip, scores }),
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { summary?: unknown; tip?: unknown };
    const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length < 400;
    return ok(j.summary) && ok(j.tip) ? { summary: j.summary, tip: j.tip } : null;
  } catch {
    return null;
  }
}
