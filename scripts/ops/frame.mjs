/* global document */
/**
 * Inspect (.github/workflows/inspect.yml), production: the creator's dashboard as Whop's frame
 * loads it, through the app's origin on Whop (its relay, `<id>.apps.whop.com`), next to the
 * Worker's own address. Says, for each: the page's HTTP answer, whether StayPut's loading screen
 * went away (the script ran), what the page then says, which files failed and what the browser
 * complained about; keeps a screenshot of each. Signed in nobody: the API answers « sign in »,
 * so nothing private shows. A loading screen still there after 20 seconds fails the step.
 *
 *   node frame.mjs <app origin on Whop> <Worker URL> <companyId> <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [origin, worker, companyId, out] = process.argv.slice(2);
if (!origin || !worker || !companyId || !out) {
  throw new Error('usage: node frame.mjs <origin> <worker> <companyId> <out dir>');
}
mkdirSync(out, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
const report = {};
let failed = false;

for (const [name, base] of [
  ['whop-relay', origin],
  ['worker', worker],
]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const entry = { url: `${base}/dashboard/${companyId}`, console: [], failedFiles: [] };
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      entry.console.push(`${message.type()}: ${message.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (error) => entry.console.push(`pageerror: ${String(error).slice(0, 300)}`));
  page.on('requestfailed', (request) =>
    entry.failedFiles.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) {
      entry.failedFiles.push(`${new URL(response.url()).pathname}: HTTP ${response.status()}`);
    }
  });
  try {
    const response = await page.goto(entry.url, { waitUntil: 'load', timeout: 30_000 });
    entry.status = response?.status() ?? null;
    entry.contentType = response?.headers()['content-type'] ?? null;
    entry.csp = response?.headers()['content-security-policy'] ?? null;
    const started = Date.now();
    entry.bootGone = await page
      .waitForFunction(() => !document.getElementById('boot'), null, { timeout: 20_000 })
      .then(
        () => true,
        () => false,
      );
    entry.bootGoneAfterMs = entry.bootGone ? Date.now() - started : null;
    entry.scripts = await page.evaluate(() =>
      Array.from(document.scripts).map((s) => s.src || `inline:${s.textContent.length}`),
    );
    entry.text = (await page.evaluate(() => document.body.innerText)).slice(0, 400);
  } catch (error) {
    entry.error = String(error).slice(0, 300);
  }
  await page.screenshot({ path: `${out}/${name}.png` }).catch(() => {});
  if (!entry.bootGone) failed = true;
  report[name] = entry;
  await page.close();
}

writeFileSync(`${out}/frame.json`, JSON.stringify(report, null, 2));
console.info(JSON.stringify(report, null, 2));
await browser.close();
process.exit(failed ? 1 : 0);
