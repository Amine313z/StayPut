/* global document, getComputedStyle */
/**
 * Inspect (.github/workflows/inspect.yml): the deployed demo in a real browser, as a creator sees
 * it. Says whether StayPut's fonts loaded (Satoshi for the numbers and titles, Geist for the UI:
 * no fallback rendering), whether the chart drew its data, and what the browser complained about;
 * keeps screenshots of the Dashboard (desktop, phone, the chart's tooltip). Fails when a font
 * or the chart is missing. Reads nothing private: the demo is answered in the browser.
 *
 *   node look.mjs https://stayput.example.workers.dev <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node look.mjs <StayPut URL> <out dir>');
mkdirSync(out, { recursive: true });

// The runner's Chrome; elsewhere, the browser CHROME_PATH names.
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
const problems = [];
const report = {};

async function open(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: 'en-US' });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  await page.goto(`${base}/demo`, { waitUntil: 'networkidle' });
  await page.getByText('Revenue saved this month').first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('.skeleton'), null, {
    timeout: 30_000,
  });
  // The numbers count, the rings and the chart draw: let them land.
  await page.waitForTimeout(2_500);
  return { context, page };
}

const desktop = await open({ width: 1440, height: 900 });
report.fonts = await desktop.page.evaluate(async () => {
  await document.fonts.ready;
  const faces = [...document.fonts].map((face) => ({
    family: face.family.replaceAll('"', ''),
    status: face.status,
  }));
  const loaded = (family) =>
    faces.some((face) => face.family === family && face.status === 'loaded');
  const hero = document.querySelector('.metric-lead');
  const body = getComputedStyle(document.body).fontFamily;
  return {
    satoshi: loaded('Satoshi') && document.fonts.check('500 56px Satoshi'),
    geist: loaded('Geist Variable') && document.fonts.check('400 14px "Geist Variable"'),
    hero: hero ? getComputedStyle(hero).fontFamily : null,
    body,
  };
});
report.chart = await desktop.page.evaluate(() => {
  const table = [...document.querySelectorAll('table')].find(
    (t) => t.querySelector('caption')?.textContent === 'Revenue saved vs at risk',
  );
  const rows = table ? [...table.querySelectorAll('tbody tr')] : [];
  const values = rows.map((row) => [...row.querySelectorAll('td')].map((td) => td.textContent));
  const lines = [...document.querySelectorAll('figure svg path[fill="none"]')];
  return {
    days: rows.length,
    nonZeroSaved: values.filter((v) => v[0] && !/^\$0$/.test(v[0])).length,
    atRiskDays: values.filter((v) => v[1] && v[1] !== '—').length,
    linesDrawn: lines.filter((path) => (path.getAttribute('d') ?? '').length > 20).length,
  };
});
report.hero = await desktop.page.evaluate(() =>
  [...document.querySelectorAll('dl dd')].slice(0, 3).map((dd) => dd.textContent),
);
await desktop.page.screenshot({ path: `${out}/dashboard-1440.png` });
await desktop.page.screenshot({ path: `${out}/dashboard-1440-full.png`, fullPage: true });
const chart = desktop.page.getByRole('group', { name: 'Revenue saved vs at risk' });
const box = await chart.boundingBox();
if (box) {
  await desktop.page.mouse.move(box.x + box.width * 0.72, box.y + box.height / 2);
  await desktop.page.waitForTimeout(400);
  await desktop.page.screenshot({
    path: `${out}/dashboard-chart-hover.png`,
    clip: { x: box.x - 90, y: box.y - 130, width: box.width + 120, height: box.height + 190 },
  });
}
await desktop.context.close();

const phone = await open({ width: 390, height: 844 });
await phone.page.screenshot({ path: `${out}/dashboard-390-full.png`, fullPage: true });
await phone.context.close();
await browser.close();

report.problems = problems;
const ok = report.fonts.satoshi && report.fonts.geist && report.chart.linesDrawn >= 2;
writeFileSync(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify(report, null, 2));
if (!ok) {
  console.error('A font did not load, or the chart drew nothing: see the report above.');
  process.exitCode = 1;
}
