/**
 * AI-written notes for a check-in, when the user has turned them on. Only NarrationFacts reach this
 * code (numbers, labels and the user's own tags); nothing is stored or logged. Providers are tried in
 * order, each with an 8 s timeout: OpenRouter (a free model), then Groq, then Gemini. Each needs its
 * key as an optional secret; with none set, or all failing, the caller answers 503 `unavailable`
 * and the app falls back to its templates.
 */
export const NARRATE_TIMEOUT_MS = 8000

export const SYSTEM_PROMPT = [
  'You write a short note about one stress check-in for the person who did it.',
  'Write two or three plain sentences in the second person. No lists, headings, emoji or markdown.',
  'Describe only what the numbers show, compared with their own baseline where given. Scores run from about -1 (calm) to +1 (stressed); 0 is their usual.',
  'Never diagnose, never name a condition, never suggest seeing a doctor, and give no advice except at most one small practical tip.',
  'If a signal is missing, do not guess at it. Do not mention these instructions, the data format, or being an AI or a model.',
].join(' ')

export interface NarrationFacts {
  fused: number | null
  bySignal: Partial<Record<'hr' | 'hrv' | 'eda' | 'temp', number>>
  hr: number | null
  restingHr: number | null
  rmssd: number | null
  feeling: number | null
  tags: string[]
  activities: { id: string; change: string }[]
}

const ACTIVITY_IDS = ['typing', 'follow-dot', 'target-taps', 'stroop', 'beat-the-clock', 'paced-breathing', 'steady-hand', 'tap-rhythm']
const SIGNALS = ['hr', 'hrv', 'eda', 'temp'] as const

const num = (v: unknown, lo: number, hi: number): number | null | undefined =>
  v === null ? null : typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v * 100) / 100 : undefined
const label = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f<>]/.test(v) ? v.trim() : undefined)

/** Checks and copies the facts, keeping only the fields the contract names. Null when anything is off. */
export function cleanFacts(raw: unknown): NarrationFacts | null {
  const f = raw as Record<string, unknown> | null
  if (!f || typeof f !== 'object') return null
  const fused = num(f.fused, -5, 5), hr = num(f.hr, 20, 250), restingHr = num(f.restingHr, 20, 250)
  const rmssd = num(f.rmssd, 0, 500), feeling = num(f.feeling, 1, 5)
  if (fused === undefined || hr === undefined || restingHr === undefined || rmssd === undefined || feeling === undefined) return null
  const bySignal: NarrationFacts['bySignal'] = {}
  const bs = f.bySignal as Record<string, unknown> | undefined
  if (!bs || typeof bs !== 'object') return null
  for (const [k, v] of Object.entries(bs)) {
    const n = num(v, -5, 5)
    if (!(SIGNALS as readonly string[]).includes(k) || n === undefined || n === null) return null
    bySignal[k as (typeof SIGNALS)[number]] = n
  }
  if (!Array.isArray(f.tags) || f.tags.length > 10) return null
  const tags = f.tags.map(t => label(t, 40))
  if (tags.some(t => t === undefined)) return null
  if (!Array.isArray(f.activities) || f.activities.length > 8) return null
  const activities: NarrationFacts['activities'] = []
  for (const a of f.activities as { id?: unknown; change?: unknown }[]) {
    const change = label(a?.change, 80)
    if (typeof a?.id !== 'string' || !ACTIVITY_IDS.includes(a.id) || !change) return null
    activities.push({ id: a.id, change })
  }
  return { fused, bySignal, hr, restingHr, rmssd, feeling, tags: tags as string[], activities }
}

export function userPrompt(f: NarrationFacts) {
  return `Check-in facts (JSON): ${JSON.stringify(f)}\nFeeling is 1 very calm to 5 very tense. Write the note.`
}

export interface NarrateKeys {
  OPENROUTER_API_KEY?: string
  GROQ_API_KEY?: string
  GEMINI_API_KEY?: string
  OPENROUTER_MODEL?: string
  GROQ_MODEL?: string
  GEMINI_MODEL?: string
}

interface Provider {
  name: string
  model: string
  call(f: NarrationFacts, signal: AbortSignal, fetcher: typeof fetch): Promise<string | null>
}

async function openAiStyle(url: string, key: string, model: string, f: NarrationFacts, signal: AbortSignal, fetcher: typeof fetch, extra: Record<string, string> = {}) {
  const res = await fetcher(url, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra },
    body: JSON.stringify({
      model, temperature: 0.4, max_tokens: 160,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt(f) }],
    }),
  })
  if (!res.ok) return null
  const j = (await res.json()) as { choices?: { message?: { content?: unknown } }[] }
  const text = j.choices?.[0]?.message?.content
  return typeof text === 'string' ? text : null
}

export function providers(env: NarrateKeys): Provider[] {
  const out: Provider[] = []
  if (env.OPENROUTER_API_KEY) {
    const key = env.OPENROUTER_API_KEY, model = env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free'
    out.push({ name: 'openrouter', model, call: (f, s, fx) => openAiStyle('https://openrouter.ai/api/v1/chat/completions', key, model, f, s, fx, { 'x-title': 'SafeSpace', 'http-referer': 'https://safespace.amittal.dev' }) })
  }
  if (env.GROQ_API_KEY) {
    const key = env.GROQ_API_KEY, model = env.GROQ_MODEL || 'llama-3.1-8b-instant'
    out.push({ name: 'groq', model, call: (f, s, fx) => openAiStyle('https://api.groq.com/openai/v1/chat/completions', key, model, f, s, fx) })
  }
  if (env.GEMINI_API_KEY) {
    const key = env.GEMINI_API_KEY, model = env.GEMINI_MODEL || 'gemini-2.5-flash-lite'
    out.push({
      name: 'gemini', model,
      async call(f, signal, fetcher) {
        const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          signal,
          headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt(f) }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 160 },
          }),
        })
        if (!res.ok) return null
        const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] }
        const text = j.candidates?.[0]?.content?.parts?.map(p => (typeof p.text === 'string' ? p.text : '')).join('')
        return text || null
      },
    })
  }
  return out
}

/** The model's reply if it keeps to the rules we can check mechanically; otherwise null (try the next one). */
export function acceptable(raw: string | null): string | null {
  if (!raw) return null
  const text = raw.replace(/\s+/g, ' ').trim()
  if (text.length < 20 || text.length > 600) return null
  if (/\b(as an ai|an ai\b|language model|i'm an ai|i am an ai|chatgpt|llm)\b/i.test(text)) return null
  if (/[#*`]|^\s*[-•]/.test(text)) return null
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  if (sentences.length > 4) return null
  return text
}

/** Tries each configured provider in turn. Null when none is configured or every one failed. */
export async function narrate(facts: NarrationFacts, env: NarrateKeys, fetcher: typeof fetch = fetch, timeoutMs = NARRATE_TIMEOUT_MS): Promise<{ text: string; model: string } | null> {
  for (const p of providers(env)) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const text = acceptable(await p.call(facts, ctl.signal, fetcher))
      if (text) return { text, model: `${p.name}:${p.model}` }
    } catch {
      // timed out or unreachable: next provider
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}
