// One-off: renders the app icons and the social card into public/ (node e2e/icons.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const pub = (p) => fileURLToPath(new URL(`../public/${p}`, import.meta.url));
const font = (f) => readFileSync(new URL(`../src/fonts/${f}`, import.meta.url)).toString('base64');
const mark = (size, pad) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#14211c"/>
  <g transform="translate(${16 - 16 * (1 - pad)} ${16 - 16 * (1 - pad)}) scale(${1 - pad})">
    <path d="M4 16h24" stroke="#edf2ee" stroke-opacity=".3"/>
    <path d="M4 20 9 19l3-6 4 9 3-12 3 7 3-2h3" fill="none" stroke="#edf2ee" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
  </g></svg>`;
const b = await chromium.launch();
const p = await b.newPage();
for (const [name, size, pad] of [['icons/icon-192.png', 192, 0.05], ['icons/icon-512.png', 512, 0.05], ['icons/icon-maskable-512.png', 512, 0.3], ['icons/apple-touch-icon.png', 180, 0.12]]) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<body style="margin:0">${mark(size, pad)}</body>`);
  await p.screenshot({ path: pub(name) });
}
await p.setViewportSize({ width: 1200, height: 630 });
await p.setContent(`<style>
@font-face{font-family:IS;src:url(data:font/woff2;base64,${font('instrument-sans-latin-wght-normal.woff2')})}
@font-face{font-family:DM;src:url(data:font/woff2;base64,${font('dm-mono-latin-500-normal.woff2')})}
body{margin:0;width:1200px;height:630px;background:#edf2ee;color:#14211c;font-family:IS;display:flex;flex-direction:column;justify-content:space-between;padding:72px 80px;box-sizing:border-box}
h1{font-size:76px;line-height:1.02;letter-spacing:-.03em;font-weight:600;margin:0;max-width:900px}
.k{font-family:DM;font-size:22px;letter-spacing:.14em;text-transform:uppercase;color:#52605a}
.row{display:flex;align-items:center;gap:18px;font-size:30px;font-weight:650}
svg.t{position:absolute;right:80px;top:80px}
</style>
<div class="row">${mark(56, 0.05).replace('<svg', '<svg style="border-radius:12px"')}SafeSpace</div>
<h1>A stress check-in you can take with your phone.</h1>
<div class="k">60 seconds · your own baseline · encrypted on your device</div>`);
await p.screenshot({ path: pub('og.png') });
await b.close();
