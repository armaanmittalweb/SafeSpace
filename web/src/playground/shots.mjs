// Screenshots and axe checks of every playground view (devices, activities, session) at
// 390x844 and 1440x900, light and dark. Starts its own Vite dev server.
// Usage: npm run shots:inputs  [ONLY=substring]  -> web/shots/inputs/ (gitignored)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const OUT = fileURLToPath(new URL('../../shots/inputs/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const server = await createServer({ root, server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const BASE = 'http://localhost:5199/src/playground/index.html';

const ACTS = ['typing', 'follow-dot', 'target-taps', 'steady-hand', 'tap-rhythm', 'stroop', 'beat-the-clock', 'paced-breathing'];
const VIEWS = [
  'devices-empty', 'devices-connected', 'devices-unavailable', 'devices-states', 'devices-import', 'picker',
  ...ACTS.flatMap((a) => [`${a}-start`, `${a}-run`, `${a}-done`]),
  'session-intro', 'session-rest', 'session-challenge', 'session-summary', 'session-summary-nodevice',
].filter((v) => !process.env.ONLY || v.includes(process.env.ONLY));

async function act(p, v) {
  const box = async (sel) => (await p.locator(sel).first().boundingBox());
  const svgPoint = async (sel) => {
    const st = await box('.ax-stage');
    const c = await p.locator(sel).first().evaluate((el) => ({ x: +el.getAttribute('cx'), y: +el.getAttribute('cy') }));
    return { x: st.x + (c.x / 100) * st.width, y: st.y + (c.y / 100) * st.height };
  };
  if (v === 'typing-run') {
    await p.locator('#ty-box').focus();
    await p.keyboard.type('The morning train was late again, so she', { delay: 25 });
    await p.keyboard.type(' rw', { delay: 25 });
  } else if (v === 'follow-dot-run') {
    let pt = await svgPoint('.fd-dot');
    await p.mouse.move(pt.x, pt.y);
    for (let i = 0; i < 40; i++) {
      await p.waitForTimeout(50);
      pt = await svgPoint('.fd-dot');
      await p.mouse.move(pt.x + 10 * Math.sin(i / 3), pt.y + 8, { steps: 2 });
    }
  } else if (v === 'target-taps-run') {
    const st = await box('.ax-stage');
    await p.mouse.click(st.x + st.width / 2, st.y + st.height / 2);
    for (let i = 0; i < 4; i++) {
      const t = await svgPoint('.tt-outer');
      await p.mouse.move(t.x, t.y, { steps: 8 });
      await p.mouse.click(t.x + 2, t.y + 1);
    }
    await p.mouse.move(st.x + st.width * 0.3, st.y + st.height * 0.4, { steps: 5 });
  } else if (v === 'stroop-run' || v === 'session-challenge') {
    await p.waitForTimeout(900);
    await p.keyboard.press('r');
    await p.waitForTimeout(700);
  } else if (v === 'beat-the-clock-run') {
    await p.keyboard.type('1');
    await p.keyboard.type('4');
  } else if (v === 'paced-breathing-run') {
    await p.waitForTimeout(5200);
  } else if (v === 'steady-hand-run') {
    await p.evaluate(() => {
      let i = 0;
      setInterval(() => {
        i++;
        const a = { x: 0.05 * Math.sin(i * 0.9), y: 0.04 * Math.cos(i * 0.9), z: 0.01 };
        window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: a, accelerationIncludingGravity: { x: 0.6 + a.x, y: -0.4 + a.y, z: 9.7 }, interval: 16 }));
      }, 16);
    });
    await p.waitForTimeout(1200);
  } else if (v === 'tap-rhythm-run') {
    await p.waitForTimeout(3700);
    for (let i = 0; i < 3; i++) { await p.keyboard.press(' '); await p.waitForTimeout(740); }
  } else if (v === 'devices-connected' || v === 'session-rest') {
    await p.waitForTimeout(2500);
  } else if (v === 'devices-empty' || v === 'devices-unavailable') {
    await p.waitForTimeout(200);
  }
}

const browser = await chromium.launch();
const report = { axe: {}, console: [] };
const combos = [['mobile', 390, 844], ['desktop', 1440, 900]];
for (const v of VIEWS) {
  for (const [tag, w, h] of combos) {
    for (const dark of [false, true]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: tag === 'mobile' ? 2 : 1, hasTouch: false });
      const p = await ctx.newPage();
      p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${v} ${tag}: ${m.text()}`); });
      p.on('pageerror', (e) => report.console.push(`${v} ${tag}: pageerror ${e.message}`));
      await p.goto(`${BASE}?v=${v}`);
      await p.waitForSelector('#pg-main');
      await p.evaluate(() => document.fonts.ready);
      await act(p, v);
      await p.waitForTimeout(250);
      const name = `${v}-${tag}-${dark ? 'dark' : 'light'}`;
      await p.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
      if (!dark || tag === 'mobile') {
        const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).disableRules(['region']).analyze();
        if (r.violations.length) report.axe[name] = r.violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, help: x.help, targets: x.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
      }
      await ctx.close();
    }
  }
}
await browser.close();
await server.close();
writeFileSync(`${OUT}report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ views: VIEWS.length, axeViolations: Object.keys(report.axe).length ? report.axe : 'none', console: report.console.slice(0, 30) }, null, 2));
