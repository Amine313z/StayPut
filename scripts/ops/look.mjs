/* global document, getComputedStyle */
/**
 * Inspect (.github/workflows/inspect.yml): the deployed demo in a real browser, as a creator sees
 * it. Says whether StayPut's fonts loaded (Satoshi for the numbers and titles, Geist for the UI:
 * no fallback rendering), which font every figure and text is drawn in, whether the amounts carry
 * their cents and the demo opened in English, whether the chart drew its data, and what the
 * browser complained about; keeps screenshots of the Dashboard (desktop, phone, the chart's
 * tooltip). Fails when any of these is wrong. Reads nothing private: the demo is answered in the
 * browser.
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
  // The font each element is drawn in: the first family of its computed font-family, the one
  // the browser uses once the file is loaded (checked above, so never a fallback).
  const first = (element) =>
    getComputedStyle(element).fontFamily.split(',')[0].replaceAll('"', '').trim();
  const sample = (selector) => [...document.querySelectorAll(selector)].slice(0, 4).map(first);
  // Every number of the app in Satoshi (brief v4 §7): the hero amount, the amounts beside it,
  // the figures of the lists and the strip, the chart's axis; every text in Geist.
  const numbers = {
    heroAmount: sample('.metric-lead'),
    secondaryAmounts: sample('.metric-hero'),
    figures: sample('.metric'),
    axis: sample('.num'),
  };
  const text = {
    body: [first(document.body)],
    labels: sample('.label-text'),
    menu: sample('nav a'),
  };
  const allNumbers = Object.values(numbers).flat();
  const allText = Object.values(text).flat();
  return {
    satoshi:
      loaded('Satoshi') &&
      ['500 14px Satoshi', '600 28px Satoshi', '700 48px Satoshi'].every((font) =>
        document.fonts.check(font),
      ),
    geist:
      loaded('Geist Variable') &&
      ['400 14px "Geist Variable"', '500 12px "Geist Variable"'].every((font) =>
        document.fonts.check(font),
      ),
    numbersInSatoshi: allNumbers.length > 0 && allNumbers.every((family) => family === 'Satoshi'),
    textInGeist: allText.length > 0 && allText.every((family) => family === 'Geist Variable'),
    numbers,
    text,
    language: document.documentElement.lang,
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
    nonZeroSaved: values.filter((v) => v[0] && !/^\$0(\.00)?$/.test(v[0])).length,
    atRiskDays: values.filter((v) => v[1] && v[1] !== '—').length,
    linesDrawn: lines.filter((path) => (path.getAttribute('d') ?? '').length > 20).length,
  };
});
report.hero = await desktop.page.evaluate(() =>
  [...document.querySelectorAll('dl dd')].slice(0, 3).map((dd) => dd.textContent),
);
// Amounts as Whop writes them (brief v4 §7): the symbol and the cents, « $247.00 ».
report.amountsWithCents = report.hero.slice(0, 2).every((text) => /^\$[\d,]+\.\d{2}$/.test(text));
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
const ok =
  report.fonts.satoshi &&
  report.fonts.geist &&
  report.fonts.numbersInSatoshi &&
  report.fonts.textInGeist &&
  report.fonts.language === 'en' &&
  report.amountsWithCents &&
  report.chart.linesDrawn >= 2;
writeFileSync(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify(report, null, 2));
if (!ok) {
  console.error(
    'A font did not load or a figure is not in Satoshi, an amount lacks its cents, the demo is not in English, or the chart drew nothing: see the report above.',
  );
  process.exitCode = 1;
}
