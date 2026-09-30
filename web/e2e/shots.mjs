// Screenshots, axe checks and a postMessage round trip against `npm run preview`
// (which serves the vercel.json headers, CSP included). Usage: npm run build && npm run
// preview, then in another shell: npm run shots. Output goes to e2e/shots/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = process.env.BASE ?? 'http://localhost:5175';
const OUT = new URL('./shots/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const file = (n) => fileURLToPath(new URL(n, OUT));

// Chrome's Local Network Access check would block a public origin (the fake Lab host) from framing localhost.
const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] });
const report = { axe: {}, console: [], messages: [] };

async function page(name, { w, h, dark = false, reduced = false }) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light', reducedMotion: reduced ? 'reduce' : 'no-preference', deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${name}: ${m.text()}`); });
  p.on('pageerror', (e) => report.console.push(`${name}: pageerror ${e.message}`));
  return p;
}
async function axe(name, p, include) {
  let b = new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']);
  if (include) b = b.include(include);
  const r = await b.analyze();
  report.axe[name] = r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}
const settle = (p) => p.waitForTimeout(400);

for (const [tag, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
  // 1. default view, mid-session (public speaking)
  let p = await page(`${tag}-mid`, { w, h });
  await p.goto(`${BASE}/?at=15.5`);
  await p.waitForSelector('.recorder svg');
  await settle(p);
  await p.screenshot({ path: file(`${tag}-1-mid-session.png`) });
  await p.screenshot({ path: file(`${tag}-1-mid-session-full.png`), fullPage: true });
  await axe(`${tag}-mid`, p);

  // 2. walking with the heart-rate pen pulled
  await p.goto(`${BASE}/?at=31`);
  await p.waitForSelector('.recorder svg');
  await p.getByRole('switch', { name: 'Heart rate in the fused score' }).click();
  await settle(p);
  await p.screenshot({ path: file(`${tag}-2-pulled-hr.png`) });
  await axe(`${tag}-pulled`, p);

  // 3. what-if editing
  await p.getByRole('button', { name: 'What if...' }).click();
  await p.getByRole('slider', { name: /Tonic level/ }).first().fill('3');
  await settle(p);
  await p.locator('.readout').screenshot({ path: file(`${tag}-3-what-if.png`) });
  await axe(`${tag}-what-if`, p);

  // 4. model notes
  await p.locator('#model-notes').scrollIntoViewIfNeeded();
  await settle(p);
  await p.locator('#model-notes').screenshot({ path: file(`${tag}-4-model-notes.png`) });
  await p.locator('#scenario').screenshot({ path: file(`${tag}-4b-scenario.png`) });
  await p.context().close();

  // 5. dark theme
  p = await page(`${tag}-dark`, { w, h, dark: true });
  await p.goto(`${BASE}/?at=15.5`);
  await p.waitForSelector('.recorder svg');
  await settle(p);
  await p.screenshot({ path: file(`${tag}-5-dark.png`) });
  await axe(`${tag}-dark`, p);
  await p.context().close();

  // 6. calibration (empty state) and reduced motion (whole session drawn at once)
  p = await page(`${tag}-cal`, { w, h });
  await p.goto(`${BASE}/?at=2.5`);
  await settle(p);
  await p.screenshot({ path: file(`${tag}-6-calibrating.png`) });
  await axe(`${tag}-cal`, p);
  await p.context().close();
  p = await page(`${tag}-reduced`, { w, h, reduced: true });
  await p.goto(`${BASE}/`);
  await settle(p);
  await p.screenshot({ path: file(`${tag}-7-reduced-motion.png`) });
  await p.context().close();

  // 8. /embed inside a host page on the allowed origin; exercises the postMessage bridge
  p = await page(`${tag}-embed`, { w, h });
  const HOST = 'https://www.amittal.dev/lab-test';
  await p.route(HOST, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><body style="margin:0;background:#dfe6e0">
      <iframe id="f" src="${BASE}/embed" title="SafeSpace recorder" style="border:0;width:100%;height:420px;display:block"></iframe>
      <script>
        window.got = [];
        addEventListener('message', (e) => { if (e.origin === '${BASE}') { window.got.push(e.data); if (e.data.type === 'height') document.getElementById('f').style.height = e.data.px + 'px'; } });
      </script></body>`,
  }));
  await p.goto(HOST);
  const frame = p.frameLocator('#f');
  await frame.locator('.recorder svg').waitFor();
  await p.waitForTimeout(500);
  await p.evaluate(() => document.getElementById('f').contentWindow.postMessage({ type: 'command', name: 'pull', signal: 'hr' }, 'http://localhost:5175'));
  await p.waitForTimeout(300);
  await p.screenshot({ path: file(`${tag}-8-embed.png`) });
  report.messages.push({ tag, got: await p.evaluate(() => window.got) });
  const f = p.frames().find((x) => x.url().includes('/embed'));
  report.messages.push({ tag, pressedAfterPull: await f.evaluate(() => [...document.querySelectorAll('.pull')].map((b) => b.textContent + '=' + b.getAttribute('aria-pressed')).join(' ')) });
  await p.context().close();

  // direct /embed: axe, and a message from a disallowed origin must be ignored
  p = await page(`${tag}-embed-direct`, { w, h });
  await p.goto(`${BASE}/embed`);
  await p.waitForSelector('.recorder svg');
  await axe(`${tag}-embed`, p);
  await p.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'command', name: 'pull', signal: 'eda' }, origin: 'https://evil.example' })));
  await p.waitForTimeout(100);
  report.messages.push({ tag, edaPressedAfterEvilPull: await p.locator('.pull', { hasText: 'EDA' }).getAttribute('aria-pressed') });
  await p.context().close();
}

await browser.close();
const summary = {
  axe: Object.fromEntries(Object.entries(report.axe).map(([k, v]) => [k, v.length ? v : 'no violations'])),
  console: report.console,
  messages: report.messages.map((m) => m.got ? { tag: m.tag, types: m.got.map((x) => x.type + (x.type === 'stage' ? `:${x.i}:${x.name}:${x.ok}:${x.ms}ms` : x.type === 'height' ? `:${x.px}` : '')) } : m),
};
writeFileSync(file('report.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
