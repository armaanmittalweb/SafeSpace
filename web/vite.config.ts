import { readFileSync } from 'node:fs';
import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

// Apply the production security headers from vercel.json to `vite preview`, so the
// Playwright run checks the app under the same CSP it will ship with.
type Rule = { source: string; headers: { key: string; value: string }[] };
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as { headers: Rule[] };
const appHeaders = Object.fromEntries(
  (vercel.headers.find((r) => r.source.includes('(?!embed)'))?.headers ?? []).map((h) => [h.key, h.value]),
);

export default defineConfig({
  plugins: [preact()],
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true, headers: appHeaders },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { include: ['tests/**/*.test.ts'] },
});
