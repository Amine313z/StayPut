/* global document */
/**
 * The App Store listing's five screenshots (docs/app-store.md, SPEC Phase 9.3), taken by Inspect
 * from the deployed demo in Chrome: the imaginary community « Atlas Trading Club », its data made
 * up in the browser, in StayPut's own fonts. 1920 × 1080 (a 1280 × 720 window at 1.5×), the
 * figures at rest (less motion asked for: no count-up caught halfway), without what only the demo
 * shows (its notice and its badge) nor the getting-started pill. Fails when a screen does not show
 * what it is taken for. Reads nothing private.
 *
 *   node store.mjs https://stayput.example.workers.dev <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node store.mjs <StayPut URL> <out dir>');
mkdirSync(out, { recursive: true });

/** What only the demo shows, and the setup pill: not part of the product a creator buys. */
const HIDDEN = '[data-demo-notice], [data-demo-badge], [data-getting-started]';

/** Each screenshot: its file, its screen, and what must be on it before it is taken. */
const SHOTS = [
  {
    file: '1-dashboard.png',
    path: '/demo',
    caption: 'Revenue saved, revenue at risk, and the one thing to do today',
    ready: (page) =>
      page
        .locator('[data-tour="hero-amount"]')
        .filter({ hasText: /\$[1-9]/ })
        .waitFor(),
  },
  {
    file: '2-members.png',
    path: '/demo/members',
    caption: 'Every member’s churn risk, the most likely to leave first',
    ready: (page) =>
      page
        .getByRole('table', { name: 'All members' })
        .locator('[role=rowgroup]:last-child > [role=row]')
        .nth(5)
        .waitFor(),
  },
  {
    file: '3-queue.png',
    path: '/demo/actions/queue',
    caption: 'Approve each message, or let StayPut act within your limits',
    ready: (page) => page.getByRole('button', { name: /^Approve all/ }).waitFor(),
  },
  {
    file: '4-failed-payments.png',
    path: '/demo/actions/queue/history',
    caption: 'Failed payments retried and recovered, each one counted',
    ready: (page) => page.locator('[data-outcome="recovered"]').first().waitFor(),
  },
  {
    file: '5-win-back.png',
    path: '/demo/actions/queue/alumni',
    caption: 'Win back former members with the free Alumni offer',
    ready: (page) =>
      page
        .locator('[data-alumni-figures]')
        .filter({ hasText: /\$[1-9]/ })
        .waitFor(),
  },
];

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1.5,
  reducedMotion: 'reduce',
  colorScheme: 'dark',
  locale: 'en-US',
  // The site's CSP (`style-src 'self'`) refuses the style that hides the demo's scaffolding: the
  // screenshots' browser alone ignores it; the site keeps its policy.
  bypassCSP: true,
});
const problems = [];
const report = [];
for (const shot of SHOTS) {
  const page = await context.newPage();
  const complaints = [];
  page.on('pageerror', (error) => complaints.push(error.message));
  try {
    await page.goto(new URL(shot.path, base).href, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: `${HIDDEN} { display: none !important; }` });
    await shot.ready(page);
    await page.evaluate(() => document.fonts.ready);
    // The page's own entrance (no motion: a single frame) and the fonts' last layout.
    await page.waitForTimeout(500);
    const fonts = await page.evaluate(() =>
      [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family),
    );
    const shown = await page
      .locator(HIDDEN)
      .evaluateAll((elements) =>
        elements.filter((element) => element.getBoundingClientRect().height > 0),
      );
    if (shown.length > 0) problems.push(`${shot.file}: the demo's own notice is still shown`);
    await page.screenshot({ path: `${out}/${shot.file}` });
    report.push({ file: shot.file, caption: shot.caption, fonts: [...new Set(fonts)] });
  } catch (error) {
    problems.push(`${shot.file}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
  }
  if (complaints.length > 0) problems.push(`${shot.file}: ${complaints.join('; ')}`);
  await page.close();
}
await browser.close();

writeFileSync(`${out}/store.json`, `${JSON.stringify({ shots: report, problems }, null, 2)}\n`);
console.info(JSON.stringify({ shots: report.map(({ file }) => file), problems }, null, 2));
if (problems.length > 0) process.exitCode = 1;
