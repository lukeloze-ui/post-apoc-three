// Usage: npm run shot -- '?view=fp' shots/name.png  [optional JS to run in the page before the shot]
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const [query = '', out = 'shots/shot.png', script] = process.argv.slice(2);
const outPath = resolve(out);
mkdirSync(dirname(outPath), { recursive: true });

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' });
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('no dev server address');
const url = `http://127.0.0.1:${address.port}/${query}`;

let code = 0;
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => console.log(`[page ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true, undefined, {
    timeout: 60_000,
  });
  if (script) await page.evaluate(script);
  await page.screenshot({ path: outPath });
  console.log(`saved ${outPath}`);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);
