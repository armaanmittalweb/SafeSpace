// `npm run shots`: builds the screenshot build (vite --mode shots: fake camera, local stand-in vault),
// serves it with the production headers (CSP included), and photographs every screen at 390×844 and
// 1440×900 in day and night, running axe on each. Output: web/shots/ (gitignored), plus report.json.
// ONLY=name1,name2 limits the scenarios; VARIANTS=phone-light,… limits the variants; NOBUILD=1 skips the build.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const OUT = fileURLToPath(new URL('../shots/', import.meta.url));
const PORT = 5176;
const BASE = `http://localhost:${PORT}`;
mkdirSync(OUT, { recursive: true });
const win = process.platform === 'win32';
const npx = win ? 'npx.cmd' : 'npx';

if (!process.env.NOBUILD) {
  const b = spawnSync(npx, ['vite', 'build', '--mode', 'shots'], { cwd: WEB, stdio: 'inherit', shell: win });
  if (b.status !== 0) process.exit(1);
}
const server = spawn(npx, ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: WEB, stdio: 'ignore', shell: win });
const cleanup = () => { try { if (win) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']); else server.kill(); } catch { /* gone */ } };
process.on('exit', cleanup);
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

const only = process.env.ONLY?.split(',');
const onlyV = process.env.VARIANTS?.split(',');
const browser = await chromium.launch();
const report = { axe: {}, console: [] };
const wait = (p, ms = 350) => p.waitForTimeout(ms);

async function axe(name, p) {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  report.axe[name] = r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
}

const F = 'fake=1&dur=8';
const startCamera = async (p) => { await p.click('button.option:has-text("Phone camera")'); await p.click('button:has-text("Start the 60-second")'); };
const scenarios = [
  ['landing', async (p, shot) => { await p.goto(`${BASE}/?${F}&seed=out`); await p.waitForSelector('.landing'); await wait(p, 1100); await shot('landing'); await shot('landing-full', { full: true }); }],
  ['signup', async (p, shot) => {
    await p.goto(`${BASE}/signup?${F}&seed=out`); await p.waitForSelector('form'); await shot('signup');
    await p.fill('input[type=email]', 'asha@example.com'); await p.fill('input[autocomplete=new-password]', 'correct horse battery');
    await p.click('button:has-text("Create account")'); await p.waitForSelector('#w1'); await wait(p); await shot('welcome-1');
    await p.click('button:has-text("Continue")'); await p.waitForSelector('.key-box'); await wait(p); await shot('welcome-2-recovery-key');
    await p.check('.check input'); await p.click('.recovery .btn.primary'); await p.waitForSelector('#w3'); await wait(p); await shot('welcome-3');
  }],
  ['signin', async (p, shot) => {
    await p.goto(`${BASE}/signin?${F}&seed=out`); await p.waitForSelector('form'); await shot('signin');
    await p.fill('input[type=email]', 'nobody@example.com'); await p.fill('input[type=password]', 'wrong password');
    await p.click('button:has-text("Sign in")'); await p.waitForSelector('.error'); await shot('signin-error');
  }],
  ['recover', async (p, shot) => { await p.goto(`${BASE}/recover?${F}&seed=out`); await p.waitForSelector('form'); await shot('recover'); }],
  ['locked', async (p, shot) => { await p.goto(`${BASE}/?${F}&seed=locked`); await p.waitForSelector('form'); await shot('unlock'); }],
  ['today', async (p, shot) => {
    await p.goto(`${BASE}/?${F}&seed=sample`); await p.waitForSelector('.today'); await wait(p, 1100); await shot('today'); await shot('today-full', { full: true });
    await p.goto(`${BASE}/?${F}&seed=new`); await p.waitForSelector('.today'); await wait(p); await shot('today-first-run');
    await p.goto(`${BASE}/?${F}&seed=base1`); await p.waitForSelector('.today'); await wait(p); await shot('today-baseline-1');
    await p.goto(`${BASE}/?${F}&seed=sample&offline=1`); await p.waitForSelector('.today'); await wait(p, 1100); await shot('today-offline');
  }],
  ['checkin', async (p, shot) => {
    await p.goto(`${BASE}/check-in?fake=1&dur=20&seed=sample`); await p.waitForSelector('.option-list'); await wait(p); await shot('checkin-1-choose');
    await p.click('button.option:has-text("Phone camera")'); await p.waitForSelector('.prepare'); await wait(p); await shot('checkin-2-prepare');
    await p.click('button:has-text("Start the 60-second")'); await p.waitForSelector('.measuring'); await wait(p, 2500); await shot('checkin-3-getting-ready');
    await p.waitForSelector('.flow-title:has-text("Measuring")', { timeout: 20000 }); await wait(p, 5000); await shot('checkin-3-measuring');
    await p.waitForSelector('.feel-list', { timeout: 40000 }); await wait(p); await shot('checkin-4-feeling');
    await p.click('.feel:has-text("Tense") >> nth=0'); await p.waitForSelector('.tag-add'); await p.click('.chip:has-text("deadline")'); await wait(p); await shot('checkin-5-tags');
    await p.click('button:has-text("See the result")'); await p.waitForSelector('.result'); await wait(p, 1100); await shot('checkin-6-result'); await shot('checkin-6-result-full', { full: true });
    await p.click('button:has-text("Save check-in")'); await p.waitForSelector('.today'); await wait(p, 300); await shot('checkin-7-saved');
  }],
  ['guest', async (p, shot) => {
    await p.goto(`${BASE}/check-in?${F}&seed=out`); await p.waitForSelector('.option-list'); await wait(p); await shot('guest-choose');
    await startCamera(p);
    await p.waitForSelector('.feel-list', { timeout: 30000 }); await p.click('.feel:has-text("Calm") >> nth=0'); await p.click('button:has-text("See the result")');
    await p.waitForSelector('.result'); await wait(p, 1100); await shot('guest-result'); await shot('guest-result-full', { full: true });
  }],
  ['states', async (p, shot) => {
    await p.goto(`${BASE}/check-in?fake=denied&seed=sample`); await startCamera(p);
    await p.waitForSelector('.state'); await wait(p); await shot('checkin-camera-denied');
    await p.goto(`${BASE}/check-in?fake=poor&dur=8&seed=sample`); await startCamera(p);
    await p.waitForSelector('.measuring'); await wait(p, 13000); await shot('checkin-measuring-poor');
    await p.waitForSelector('.state', { timeout: 30000 }); await wait(p); await shot('checkin-poor-signal');
    await p.goto(`${BASE}/baseline?${F}&seed=base1`); await p.waitForSelector('.prepare'); await wait(p); await shot('baseline-prepare');
    await p.click('button:has-text("Start the 60-second")'); await p.waitForSelector('.baseline-figs', { timeout: 30000 }); await wait(p); await shot('baseline-done');
  }],
  ['history', async (p, shot) => {
    await p.goto(`${BASE}/history?${F}&seed=sample`); await p.waitForSelector('.history'); await wait(p); await shot('history'); await shot('history-full', { full: true });
    await p.click('.filter .chip:has-text("before exam")'); await wait(p); await shot('history-tag-filter');
    await p.click('.hrow >> nth=0'); await p.waitForSelector('.result'); await wait(p, 1100); await shot('history-detail'); await shot('history-detail-full', { full: true });
    await p.goto(`${BASE}/history?${F}&seed=new`); await p.waitForSelector('.empty'); await shot('history-empty');
  }],
  ['activities', async (p, shot) => { await p.goto(`${BASE}/activities?${F}&seed=sample`); await p.waitForSelector('.job-grid'); await wait(p); await shot('activities'); await shot('activities-full', { full: true }); }],
  ['devices', async (p, shot) => { await p.goto(`${BASE}/devices?${F}&seed=sample`); await p.waitForSelector('.dev-row'); await wait(p, 600); await shot('devices'); await shot('devices-full', { full: true }); }],
  ['settings', async (p, shot) => { await p.goto(`${BASE}/settings?${F}&seed=sample`); await p.waitForSelector('.settings'); await wait(p, 600); await shot('settings'); await shot('settings-full', { full: true }); }],
  ['misc', async (p, shot) => {
    await p.goto(`${BASE}/nope?${F}&seed=sample`); await p.waitForSelector('.not-found'); await shot('404');
    await p.goto(`${BASE}/lab/pulse?${F}&seed=out`); await p.click('button:has-text("Start the camera")'); await wait(p, 15000); await shot('lab-pulse'); await shot('lab-pulse-full', { full: true });
    await p.goto(`${BASE}/how-it-works?${F}&seed=out`); await p.waitForSelector('.recorder svg'); await wait(p, 800); await shot('how-it-works');
    await p.goto(`${BASE}/embed`); await p.waitForSelector('.recorder svg'); await wait(p, 500); await shot('embed');
  }],
];

const variants = [
  { name: 'phone-light', w: 390, h: 844, dark: false, dpr: 2 },
  { name: 'phone-dark', w: 390, h: 844, dark: true, dpr: 2 },
  { name: 'desk-light', w: 1440, h: 900, dark: false, dpr: 1 },
  { name: 'desk-dark', w: 1440, h: 900, dark: true, dpr: 1 },
].filter((v) => !onlyV || onlyV.includes(v.name));

await Promise.all(variants.map(async (v) => {
  for (const [name, run] of scenarios) {
    if (only && !only.includes(name)) continue;
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, colorScheme: v.dark ? 'dark' : 'light', deviceScaleFactor: v.dpr, acceptDownloads: true });
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${v.name} ${name}: ${m.text()}`); });
    p.on('pageerror', (e) => report.console.push(`${v.name} ${name}: pageerror ${e.message}`));
    const shot = async (label, o = {}) => {
      await p.screenshot({ path: `${OUT}${label}.${v.name}.png`, fullPage: !!o.full });
      if (!o.full) await axe(`${label}.${v.name}`, p);
    };
    try { await run(p, shot); } catch (e) {
      report.console.push(`${v.name} ${name}: FAILED ${e.message.split('\n')[0]}`);
      await p.screenshot({ path: `${OUT}FAILED-${name}.${v.name}.png` }).catch(() => {});
    }
    await ctx.close();
  }
}));

await browser.close();
const bad = Object.entries(report.axe).filter(([, v]) => v.length);
const summary = { screens: Object.keys(report.axe).length, withViolations: bad.length, axe: Object.fromEntries(bad), console: report.console };
writeFileSync(`${OUT}report.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
cleanup();
process.exit(0);
