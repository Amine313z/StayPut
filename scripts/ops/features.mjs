/* global document */
/**
 * StayPut's features in 4K (3840 × 2160), for the founder's product pages and posts: the deployed
 * demo (the imaginary « Atlas Trading Club », its data made up in the browser) in Chrome, in
 * StayPut's own fonts, a 1440 × 810 window at 8/3. The figures at rest (less motion asked for),
 * without what only the demo shows (its notice and its badge) nor the getting-started pill, as the
 * App Store screenshots (store.mjs). Fails when a screen does not show what it is taken for, or
 * when Satoshi did not load. Reads nothing private.
 *
 *   node features.mjs https://stayput.example.workers.dev <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node features.mjs <StayPut URL> <out dir>');
mkdirSync(out, { recursive: true });

/** What only the demo shows, and the setup pill: not part of the product a creator buys. */
const HIDDEN = '[data-demo-notice], [data-demo-badge], [data-getting-started]';

/** A page done loading: its title, and no skeleton nor « Loading… » left. */
const loaded = async (page) => {
  await page.getByRole('heading', { level: 1 }).first().waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.skeleton') && !document.body.textContent?.includes('Loading…'),
  );
};

/** Each feature: its file, its screen, what to do there, and what must be on it. */
const SHOTS = [
  {
    file: '01-dashboard.png',
    path: '/demo',
    caption: 'Revenue saved, revenue at risk, and the one thing to do today',
    ready: (page) =>
      page
        .locator('[data-tour="hero-amount"]')
        .filter({ hasText: /\$[1-9]/ })
        .waitFor(),
  },
  {
    file: '02-members-risk.png',
    path: '/demo/members',
    caption: 'Every member’s churn risk, the most likely to leave first',
    ready: (page) =>
      page
        .getByRole('table', { name: 'All members' })
        .locator('[role=rowgroup]:last-child > [role=row]')
        .nth(8)
        .waitFor(),
  },
  {
    file: '03-member-detail.png',
    path: '/demo/members',
    caption: 'Why a member is leaving, and the action to take, in one click',
    ready: async (page) => {
      await page.getByRole('button', { name: /^Open Hunter Blake/ }).click();
      await page.getByRole('dialog', { name: 'Hunter Blake' }).getByText('Why').waitFor();
    },
  },
  {
    file: '04-automation-rules.png',
    path: '/demo/actions',
    caption: 'Automations that run within your limits',
    ready: (page) => page.getByText('Payment retries').first().waitFor(),
  },
  {
    file: '05-approval-queue.png',
    path: '/demo/actions/queue',
    caption: 'Approve each message, or let StayPut act on its own',
    ready: (page) => page.getByRole('button', { name: /^Approve all/ }).waitFor(),
  },
  {
    file: '06-saves-history.png',
    path: '/demo/actions/queue/history',
    caption: 'Every save with its proof: payments recovered, members back',
    ready: (page) => page.locator('[data-outcome="recovered"]').first().waitFor(),
  },
  {
    file: '07-win-back.png',
    path: '/demo/actions/queue/alumni',
    caption: 'Win back former members with the free Alumni offer',
    ready: (page) =>
      page
        .locator('[data-alumni-figures]')
        .filter({ hasText: /\$[1-9]/ })
        .waitFor(),
  },
  {
    file: '08-revenue-forecast.png',
    path: '/demo/insights',
    caption: 'The revenue you keep by acting, over the next 90 days',
    ready: (page) => page.getByText('Kept by acting').first().waitFor(),
  },
  {
    file: '09-lessons.png',
    path: '/demo/insights/lessons',
    caption: 'Where members stall, and what makes them leave',
    ready: (page) => page.getByText('Where members stall').waitFor(),
  },
  {
    file: '10-cohorts.png',
    path: '/demo/insights/cohorts',
    caption: 'Retention by month of arrival, the weak months flagged',
    ready: (page) => page.getByText('Retention by month of arrival').waitFor(),
  },
  {
    file: '11-monday-report.png',
    path: '/demo/insights/reports',
    caption: 'A Monday report: members saved, money saved, the week’s priority',
    ready: (page) => page.getByText('Members saved').first().waitFor(),
  },
  {
    file: '12-discord.png',
    path: '/demo/sources/discord',
    caption: 'Discord and Telegram activity in every risk score',
    ready: (page) => page.getByText('Messages per day').first().waitFor(),
  },
  {
    file: '13-guardrails.png',
    path: '/demo/settings/actions',
    caption: 'Guardrails: manual or automatic, test mode, quiet hours',
    ready: (page) => page.getByText('Actions and guardrails').waitFor(),
  },
];

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
const context = await browser.newContext({
  viewport: { width: 1440, height: 810 },
  deviceScaleFactor: 8 / 3,
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
    await loaded(page);
    await shot.ready(page);
    await page.evaluate(() => document.fonts.ready);
    // The page's own entrance (no motion: a single frame) and the fonts' last layout.
    await page.waitForTimeout(700);
    const fonts = await page.evaluate(() =>
      [...document.fonts].filter((font) => font.status === 'loaded').map((font) => font.family),
    );
    if (!fonts.some((family) => family.replaceAll(/["']/g, '') === 'Satoshi')) {
      problems.push(`${shot.file}: Satoshi did not load`);
    }
    await page.screenshot({ path: `${out}/${shot.file}` });
    report.push({ file: shot.file, caption: shot.caption });
  } catch (error) {
    problems.push(`${shot.file}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
  }
  if (complaints.length > 0) problems.push(`${shot.file}: ${complaints.join('; ')}`);
  await page.close();
}
await browser.close();

writeFileSync(`${out}/features.json`, `${JSON.stringify({ shots: report, problems }, null, 2)}\n`);
console.info(JSON.stringify({ shots: report.map(({ file }) => file), problems }, null, 2));
if (problems.length > 0) process.exitCode = 1;
