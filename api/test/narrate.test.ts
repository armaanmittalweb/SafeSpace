import { describe, expect, it } from 'vitest'
import { acceptable, cleanFacts, narrate, SYSTEM_PROMPT } from '../src/narrate'
import { setup } from './helpers'

const FACTS = {
  fused: 0.42, bySignal: { hr: 0.6, hrv: 0.3 }, hr: 88, restingHr: 74, rmssd: 31, feeling: 4,
  tags: ['before exam'], activities: [{ id: 'stroop', change: 'slower than your calm runs' }],
}
const GOOD = 'Your heart rate was 14 bpm above your resting 74, and your heart-rate variability was lower than usual. That fits the tense feeling you reported before the exam. A slow walk or a few long breaths out may help it settle.'

const openAi = (text: string) => Response.json({ choices: [{ message: { content: text } }] })
const gemini = (text: string) => Response.json({ candidates: [{ content: { parts: [{ text }] } }] })

/** A fetch that answers per host and records what it was asked. */
function fakeFetch(answers: Record<string, () => Response | Promise<Response>>, calls: { url: string; body: any; headers: Headers }[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) })
    const host = new URL(url).hostname
    const answer = answers[host]
    if (!answer) throw new Error('unreachable ' + host)
    return answer()
  }) as typeof fetch
}

describe('POST /api/narrate', () => {
  it('503 unavailable when no provider key is set, without calling out', async () => {
    const calls: { url: string }[] = []
    const s = setup({}, fakeFetch({}, calls as never))
    const u = await s.signup()
    const res = await s.call('POST', '/api/narrate', { cookie: u.cookie, body: { facts: FACTS } })
    expect(res.status).toBe(503)
    expect(res.json.code).toBe('unavailable')
    expect(calls).toEqual([])
  })

  it('needs a session and valid facts', async () => {
    const s = setup({ GROQ_API_KEY: 'g' }, fakeFetch({ 'api.groq.com': () => openAi(GOOD) }))
    expect((await s.call('POST', '/api/narrate', { body: { facts: FACTS } })).status).toBe(401)
    const u = await s.signup()
    for (const bad of [{ ...FACTS, hr: 'fast' }, { ...FACTS, tags: ['<script>'] }, { ...FACTS, bySignal: { mood: 1 } }, { ...FACTS, activities: [{ id: 'chess', change: 'x' }] }, null]) {
      expect((await s.call('POST', '/api/narrate', { cookie: u.cookie, body: { facts: bad } })).status).toBe(400)
    }
  })

  it('falls through OpenRouter → Groq → Gemini and sends only the facts', async () => {
    const calls: { url: string; body: any; headers: Headers }[] = []
    const s = setup(
      { OPENROUTER_API_KEY: 'or', GROQ_API_KEY: 'gq', GEMINI_API_KEY: 'gm' },
      fakeFetch({
        'openrouter.ai': () => new Response('busy', { status: 429 }),
        'api.groq.com': () => openAi('As an AI language model, I cannot say.'),
        'generativelanguage.googleapis.com': () => gemini(GOOD),
      }, calls),
    )
    const u = await s.signup()
    const res = await s.call('POST', '/api/narrate', { cookie: u.cookie, body: { facts: { ...FACTS, extra: 'secret note' } } })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ text: GOOD, model: 'gemini:gemini-2.5-flash-lite' })
    expect(calls.map(c => new URL(c.url).hostname)).toEqual(['openrouter.ai', 'api.groq.com', 'generativelanguage.googleapis.com'])
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT })
    expect(calls[0].headers.get('authorization')).toBe('Bearer or')
    expect(calls[2].headers.get('x-goog-api-key')).toBe('gm')
    expect(JSON.stringify(calls)).not.toContain('secret note')
    expect(JSON.stringify(calls)).not.toContain(u.email)
  })

  it('503 when every provider fails, so the app uses its templates', async () => {
    const s = setup({ OPENROUTER_API_KEY: 'or', GROQ_API_KEY: 'gq' }, fakeFetch({ 'openrouter.ai': () => { throw new Error('down') }, 'api.groq.com': () => new Response('', { status: 500 }) }))
    const u = await s.signup()
    const res = await s.call('POST', '/api/narrate', { cookie: u.cookie, body: { facts: FACTS } })
    expect(res.status).toBe(503)
    expect(res.json.code).toBe('unavailable')
  })

  it('allows 10 notes per user per hour', async () => {
    const s = setup({ GROQ_API_KEY: 'g' }, fakeFetch({ 'api.groq.com': () => openAi(GOOD) }))
    const u = await s.signup()
    for (let i = 0; i < 10; i++) expect((await s.call('POST', '/api/narrate', { cookie: u.cookie, body: { facts: FACTS } })).status).toBe(200)
    const eleventh = await s.call('POST', '/api/narrate', { cookie: u.cookie, body: { facts: FACTS } })
    expect(eleventh.status).toBe(429)
    expect(eleventh.json.code).toBe('rate_limited')
    s.clock.t += 3_600_000
    expect((await s.call('POST', '/api/narrate', { cookie: u.cookie, body: { facts: FACTS } })).status).toBe(200)
  })
})

describe('narration rules', () => {
  it('gives up on a provider after the timeout and tries the next', async () => {
    const hang = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as typeof fetch
    let n = 0
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => (n++ === 0 ? hang(input, init) : openAi(GOOD))) as typeof fetch
    const out = await narrate(cleanFacts(FACTS)!, { OPENROUTER_API_KEY: 'a', GROQ_API_KEY: 'b' }, fetcher, 30)
    expect(out?.model).toBe('groq:llama-3.1-8b-instant')
  })

  it('accepts two or three plain sentences and rejects lists, markdown, AI talk and essays', () => {
    expect(acceptable(GOOD)).toBe(GOOD)
    expect(acceptable('  ' + GOOD + '\n')).toBe(GOOD)
    expect(acceptable('- Your heart rate was high.\n- Breathe.')).toBeNull()
    expect(acceptable('**Your** heart rate was high today, above your usual.')).toBeNull()
    expect(acceptable('I am an AI, but your heart rate was high today.')).toBeNull()
    expect(acceptable('Short.')).toBeNull()
    expect(acceptable('One. Two is here. Three is here. Four is here. Five is here.')).toBeNull()
    expect(acceptable(null)).toBeNull()
  })

  it('the system prompt keeps to the brief', () => {
    expect(SYSTEM_PROMPT).toMatch(/two or three plain sentences/i)
    expect(SYSTEM_PROMPT).toMatch(/never diagnose/i)
    expect(SYSTEM_PROMPT).toMatch(/at most one small practical tip/i)
    expect(SYSTEM_PROMPT).toMatch(/being an AI/i)
  })
})
