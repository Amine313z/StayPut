/* global document, getComputedStyle, window */
/**
 * Inspect (.github/workflows/inspect.yml): the deployed demo in a real browser, as a creator sees
 * it. Says whether StayPut's fonts loaded (Satoshi for the numbers and titles, Geist for the UI:
 * no fallback rendering), which font every figure and text is drawn in, whether the amounts carry
 * their cents and the demo opened in English, whether the chart drew its data and ends on the
 * balance's amount (brief v4 §13), who comes first in « Needs attention », whether every block of
 * Integrations › Activity is past « Loading… » within 5 seconds (§9.6), whether the guide shows
 * its five cards and pictures, the tour and every « Show me » light their place wholly with the
 * tooltip beside it, never over it, the tour ending where it began (fix prompt v4.1, block 1),
 * and the welcome has its four steps (§10), whether Members is a one-line-a-row table whose
 * columns sort, whose chips stay on top and whose rows open a 420 px drawer (§9.3), and what the
 * browser complained about; keeps screenshots of the Dashboard (desktop, the balance, phone, the
 * chart's tooltip), of the Activity tab, of the guide, of each step of the tour and each « Show
 * me », of the welcome, and of Members and a member's drawer (desktop and phone). Fails when any
 * of these is wrong. Reads nothing private: the demo is answered in the browser.
 *
 *   node look.mjs https://stayput.example.workers.dev <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: node look.mjs <StayPut URL> <out dir>');
mkdirSync(out, { recursive: true });

// The runner's Chrome; elsewhere, the browser CHROME_PATH names. With the scrollbars a desktop
// shows (headless Chrome hides them): the page's room is what a creator on Windows gets.
const browser = await chromium.launch({
  ignoreDefaultArgs: ['--hide-scrollbars'],
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: 'chrome' }),
});
const problems = [];
const report = {};

/** The tour's places, in its order, and each « Show me »'s, in the guide's (apps/web/src/guide.ts). */
const TOUR_PLACES = [
  'hero-amount',
  'priority-action',
  'risk-ring',
  'rule-payment-retry',
  'connect-discord',
];
const CARD_PLACES = [
  'attention-row',
  'rule-payment-retry',
  'hero-amount',
  'limits',
  'connect-discord',
];

/**
 * Once the light has landed on a place (its tooltip shown, the halo's glide over): whether the
 * place is on the page, wholly inside the cut-out, and clear of the tooltip.
 */
async function lightOn(page, place, counter = null) {
  await page.waitForFunction(
    (counter) => {
      const tip = document.querySelector('[data-spot="tip"][data-side]');
      return (
        tip !== null &&
        getComputedStyle(tip).opacity === '1' &&
        (counter === null || (tip.textContent ?? '').includes(counter))
      );
    },
    counter,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(700);
  return page.evaluate((name) => {
    const boxOf = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    const target = boxOf(
      [...document.querySelectorAll(`[data-tour="${name}"]`)].find((element) => {
        const r = element.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }),
    );
    const cut = boxOf(document.querySelector('[data-spot="cut"]'));
    const tip = document.querySelector('[data-spot="tip"]');
    const tipBox = boxOf(tip);
    const inside =
      target !== null &&
      cut !== null &&
      target.x >= cut.x - 0.5 &&
      target.y >= cut.y - 0.5 &&
      target.x + target.width <= cut.x + cut.width + 0.5 &&
      target.y + target.height <= cut.y + cut.height + 0.5;
    const covers =
      target !== null &&
      tipBox !== null &&
      tipBox.x < target.x + target.width &&
      target.x < tipBox.x + tipBox.width &&
      tipBox.y < target.y + target.height &&
      target.y < tipBox.y + tipBox.height;
    return {
      place: name,
      found: target !== null,
      inside,
      clear: tipBox !== null && !covers,
      side: tip?.getAttribute('data-side') ?? null,
      title: tip?.querySelector('h2')?.textContent ?? null,
    };
  }, place);
}

const wellLit = (light) => light.found && light.inside && light.clear;

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
  await page.getByText('Revenue saved · This month').first().waitFor({ timeout: 30_000 });
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
    atRiskDays: values.filter((v) => v[2] && v[2] !== '—').length,
    linesDrawn: lines.filter((path) => (path.getAttribute('d') ?? '').length > 20).length,
  };
});
report.hero = await desktop.page.evaluate(() =>
  [...document.querySelectorAll('dl dd')].slice(0, 3).map((dd) => dd.textContent),
);
// Amounts as Whop writes them (brief v4 §7): the symbol and the cents, « $247.00 ».
report.amountsWithCents = report.hero.slice(0, 2).every((text) => /^\$[\d,]+\.\d{2}$/.test(text));
// The balance (brief v4 §8, §13, fix prompt v4.1 block 2): the month's amount is where the
// chart's month ends today; the period's money only climbs; « Oct 1 » marks where the month
// starts; the difference with last month under it, 7D / 30D / 90D; the most urgent member first.
const balance = desktop.page.getByRole('region', { name: 'Your money this month' });
report.balance = await balance.evaluate((section) => {
  const rows = [...section.querySelectorAll('table tbody tr')];
  const cents = (text) => Math.round(Number((text ?? '').replace(/[^\d.]/g, '')) * 100);
  const inPeriod = rows.map((row) => cents(row.querySelectorAll('td')[0]?.textContent));
  const today = new Date();
  return {
    amount: section.querySelector('dd')?.textContent ?? null,
    chartEnds: rows.at(-1)?.querySelectorAll('td')[1]?.textContent ?? null,
    periodClimbs: inPeriod.length > 0 && inPeriod.every((v, i) => i === 0 || v >= inPeriod[i - 1]),
    monthMark: section.querySelector('[data-chart="month-start"]')?.textContent ?? null,
    // Shown over 30 days unless today is the 31st (the 1st is then 30 days back).
    monthStart:
      today.getDate() <= 30
        ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
            new Date(today.getFullYear(), today.getMonth(), 1),
          )
        : null,
    delta:
      [...section.querySelectorAll('p')]
        .find((p) => / vs last month/.test(p.textContent ?? ''))
        ?.querySelector('button')?.textContent ?? null,
    periods: [...section.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent),
  };
});
report.firstNeedingAttention = await desktop.page.evaluate(() => {
  const title = [...document.querySelectorAll('h2')].find(
    (h) => h.textContent === 'Needs attention',
  );
  return title?.closest('section')?.querySelector('li a')?.textContent ?? null;
});
await desktop.page.screenshot({ path: `${out}/dashboard-1440.png` });
await desktop.page.screenshot({ path: `${out}/dashboard-1440-full.png`, fullPage: true });
// « Needs attention » (fix prompt v4.1, block 3): a « › » at rest, the actions when hovered.
const attentionList = desktop.page.locator('[data-tour="attention"]');
const attentionRow = attentionList.getByRole('listitem').nth(1);
const actionsOpacity = () =>
  attentionRow
    .locator('[data-row-actions]')
    .evaluate((element) => getComputedStyle(element).opacity);
await desktop.page.mouse.move(0, 0);
await desktop.page.waitForTimeout(300);
report.attentionRow = { atRest: await actionsOpacity() };
await attentionRow.hover();
await desktop.page.waitForTimeout(400);
report.attentionRow.hovered = await actionsOpacity();
await attentionList.screenshot({ path: `${out}/dashboard-attention-hover.png` });
await desktop.page.mouse.move(0, 0);
await balance.screenshot({ path: `${out}/dashboard-balance.png` });
const chart = desktop.page.getByRole('group', { name: 'Revenue saved vs at risk' });
const box = await chart.boundingBox();
if (box) {
  const clip = { x: box.x - 90, y: box.y - 130, width: box.width + 120, height: box.height + 190 };
  await desktop.page.mouse.move(box.x + box.width * 0.72, box.y + box.height / 2);
  await desktop.page.waitForTimeout(400);
  await desktop.page.screenshot({ path: `${out}/dashboard-chart-hover.png`, clip });
  // The month's first day: its point stands at the end of the day the mark starts.
  const mark = await desktop.page.locator('[data-chart="month-start"]').boundingBox();
  if (mark) {
    await desktop.page.mouse.move(mark.x + box.width / 30, box.y + box.height / 2);
    await desktop.page.waitForTimeout(400);
    await desktop.page.screenshot({ path: `${out}/dashboard-chart-month-start.png`, clip });
  }
  await desktop.page.mouse.move(0, 0);
  // The other periods: the same money added up from their own first day.
  for (const days of ['7D', '90D', '30D']) {
    await balance.getByRole('radio', { name: days }).click();
    await desktop.page.waitForTimeout(1_000);
    if (days !== '30D') await balance.screenshot({ path: `${out}/dashboard-balance-${days}.png` });
  }
}
// Integrations › Activity: no block may still say « Loading… » after 5 seconds (brief v4 §9.6).
await desktop.page.goto(`${base}/demo/sources/activity`, { waitUntil: 'domcontentloaded' });
await desktop.page.waitForTimeout(5_000);
report.activity = {
  loadingAfter5s: await desktop.page.getByText('Loading…').count(),
  slow: await desktop.page.getByText('This is taking longer than usual.').count(),
  // Each platform's members' part (fix prompt v4.1, block 4): what their 30 days add up to.
  byMembers: await desktop.page.evaluate(() =>
    [...document.querySelectorAll('[data-by-members]')].map((line) => line.textContent),
  ),
};
await desktop.page.screenshot({ path: `${out}/integrations-activity.png`, fullPage: true });

// The guide (brief v4 §10): a 420 px panel, five cards with their pictures, four shortcuts.
await desktop.page.goto(`${base}/demo`, { waitUntil: 'domcontentloaded' });
await desktop.page.getByText('Revenue saved · This month').first().waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(2_500);
await desktop.page.getByRole('button', { name: 'Guide' }).click();
const guide = desktop.page.getByRole('dialog', { name: 'How StayPut works' });
await guide.waitFor();
await desktop.page.waitForTimeout(1_800);
report.guide = await guide.evaluate((panel) => ({
  width: Math.round(panel.getBoundingClientRect().width),
  cards: [...panel.querySelectorAll('li h3')].map((title) => title.textContent),
  pictures: panel.querySelectorAll('[data-loop]').length,
  playing: panel.querySelectorAll('[data-loop="play"]').length,
  showMe: [...panel.querySelectorAll('button')].filter((b) => b.textContent === 'Show me').length,
}));
await desktop.page.screenshot({ path: `${out}/guide-1440.png` });
await guide.evaluate((panel) => panel.querySelector('.overflow-y-auto')?.scrollTo(0, 99_999));
await desktop.page.waitForTimeout(1_500);
await desktop.page.screenshot({ path: `${out}/guide-1440-end.png` });

// The tour (fix prompt v4.1, block 1): five places, the last two on their own pages, each
// wholly inside the cut-out with its tooltip beside it; Done brings back the dashboard.
await guide.getByRole('button', { name: 'Replay the tour' }).click();
report.tour = [];
for (const [index, place] of TOUR_PLACES.entries()) {
  report.tour.push(await lightOn(desktop.page, place, `${index + 1} of 5`));
  await desktop.page.screenshot({ path: `${out}/tour-${index + 1}.png` });
  // Next, and Done on the last place.
  await desktop.page.locator('[data-spot="tip"] [data-autofocus]').click();
}
await desktop.page.locator('[data-spot="tip"]').waitFor({ state: 'detached' });
await desktop.page.waitForTimeout(800);
report.tourEnd = await desktop.page.evaluate(() => ({
  path: window.location.pathname,
  scrollY: Math.round(window.scrollY),
}));

// Each « Show me »: its place on its page, in the same light, with what it is for.
report.showMe = [];
for (const [index, place] of CARD_PLACES.entries()) {
  await desktop.page.getByRole('button', { name: 'Guide', exact: true }).click();
  await desktop.page
    .getByRole('dialog', { name: 'How StayPut works' })
    .getByRole('button', { name: 'Show me' })
    .nth(index)
    .click();
  report.showMe.push(await lightOn(desktop.page, place));
  await desktop.page.screenshot({ path: `${out}/showme-${index + 1}.png` });
  // « Got it ».
  await desktop.page.locator('[data-spot="tip"] [data-autofocus]').click();
  await desktop.page.locator('[data-spot="tip"]').waitFor({ state: 'detached' });
}

// The welcome, four steps (`?welcome`: the demo never opens it by itself).
await desktop.page.goto(`${base}/demo?welcome`, { waitUntil: 'domcontentloaded' });
const welcome = desktop.page.getByRole('dialog').first();
await welcome.waitFor({ timeout: 30_000 });
report.welcome = [];
for (let step = 1; step <= 4; step += 1) {
  await desktop.page.waitForTimeout(step === 4 ? 2_000 : 900);
  report.welcome.push(await welcome.getByRole('heading').first().textContent());
  await desktop.page.screenshot({ path: `${out}/welcome-${step}.png` });
  if (step === 3) await welcome.getByRole('radio', { name: /^Automatic/ }).check({ force: true });
  if (step < 4) {
    await welcome.getByRole('button', { name: step === 1 ? 'Get started' : 'Next' }).click();
  }
}

// Members (§9.3): the table, its sticky chips, a chip, a column's order, a member's drawer.
await desktop.page.goto(`${base}/demo/members`, { waitUntil: 'domcontentloaded' });
const members = desktop.page.getByRole('table', { name: 'All members' });
await members.waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(1_500);
const rowsOf = () =>
  desktop.page.evaluate(() =>
    [...document.querySelectorAll('[role=table] [role=rowgroup]:last-child > [role=row]')].map(
      (row) => [...row.querySelectorAll('[role=cell]')].map((cell) => cell.textContent.trim()),
    ),
  );
report.members = await desktop.page.evaluate(() => {
  const rows = [
    ...document.querySelectorAll('[role=table] [role=rowgroup]:last-child > [role=row]'),
  ];
  return {
    columns: [...document.querySelectorAll('[role=columnheader]')]
      .map((header) => header.textContent.trim())
      .filter(Boolean),
    rows: rows.length,
    first: rows[0]?.querySelector('[role=cell] button')?.textContent ?? null,
    heights: rows.slice(0, 10).map((row) => Math.round(row.getBoundingClientRect().height)),
    cutHeaders: [...document.querySelectorAll('[role=columnheader] button span')].filter(
      (span) => span.scrollWidth > span.clientWidth,
    ).length,
    // A state is white words: red only as a small dot (brief v4 §6).
    redWords: rows.filter((row) => {
      const status = row.querySelectorAll('[role=cell]')[2];
      return status && getComputedStyle(status).color === 'rgb(255, 92, 92)';
    }).length,
    urgentDots: document.querySelectorAll('[role=table] [class*="bg-urgent"]').length,
  };
});
// One story (fix prompt v4.1, block 4): a pause, a year's end, a member gone, each on its row.
report.story = await desktop.page.evaluate(() => {
  const cells = (name) =>
    [
      ...([...document.querySelectorAll('[role=table] [role=rowgroup]:last-child > [role=row]')]
        .find((row) => row.textContent.includes(name))
        ?.querySelectorAll('[role=cell]') ?? []),
    ].map((cell) => cell.textContent.trim());
  return {
    juliette: cells('Juliette Caron'),
    hugo: cells('Hugo Bernard'),
    kevin: cells('Kevin Nguyen'),
    sarah: cells('Sarah Cohen'),
    paul: cells('Paul Henry'),
  };
});
await desktop.page.screenshot({ path: `${out}/members-1440.png` });
await desktop.page.mouse.wheel(0, 900);
await desktop.page.waitForTimeout(700);
report.members.chipsTop = await desktop.page.evaluate(() =>
  Math.round(
    document
      .querySelector('[role=group][aria-label="Show"]')
      .closest('.sticky')
      .getBoundingClientRect().top,
  ),
);
await desktop.page.screenshot({ path: `${out}/members-1440-scrolled.png` });
await desktop.page.mouse.wheel(0, -5_000);
// The search, typed fast (fix prompt v4.1, block 3): every key kept, Hugo Bernard alone.
const searchField = desktop.page.getByRole('searchbox', { name: 'Search a member' });
await searchField.pressSequentially('hugo', { delay: 30 });
await desktop.page.waitForTimeout(600);
report.members.search = {
  value: await searchField.inputValue(),
  rows: (await rowsOf()).map((cells) => cells[0] ?? ''),
  address: new URL(desktop.page.url()).searchParams.get('q'),
};
await desktop.page.screenshot({ path: `${out}/members-1440-search.png` });
await searchField.fill('');
await desktop.page.waitForTimeout(600);
await desktop.page.getByRole('button', { name: /^High/ }).click();
await desktop.page.waitForTimeout(800);
report.members.high = (await rowsOf()).length;
await desktop.page.screenshot({ path: `${out}/members-1440-high.png` });
await desktop.page.getByRole('button', { name: /^All/ }).click();
await desktop.page.waitForTimeout(800);
await members.getByRole('columnheader', { name: 'MRR' }).getByRole('button').click();
await desktop.page.waitForTimeout(500);
const amounts = (await rowsOf()).map((cells) =>
  /^\$/.test(cells[3] ?? '') ? Number(cells[3].replace(/[^\d.]/g, '')) : -1,
);
report.members.byMrr = amounts.slice(0, 5);
report.members.sortedByMrr = amounts.every(
  (amount, index) => index === 0 || amount === -1 || amount <= amounts[index - 1],
);
await members.getByRole('row').nth(1).click();
const drawer = desktop.page.getByRole('dialog');
await drawer.waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(1_800);
report.members.drawer = await drawer.evaluate((dialog) => ({
  width: Math.round(dialog.getBoundingClientRect().width),
  left: Math.round(dialog.getBoundingClientRect().left),
  right: Math.round(dialog.getBoundingClientRect().right),
  window: window.innerWidth,
  pageLocked: document.documentElement.hasAttribute('data-scroll-lock'),
  sections: [...dialog.querySelectorAll('section h3')].map((title) => title.textContent),
  scoreDrawn: Boolean(dialog.querySelector('figure svg[role=img] path')),
  doNotContact: dialog.querySelector('[role=switch]')?.getAttribute('aria-checked') ?? null,
}));
await desktop.page.screenshot({ path: `${out}/members-drawer-1440.png` });
await desktop.page.evaluate(() =>
  document.querySelector('dialog[open] .overflow-y-auto').scrollTo(0, 99_999),
);
await desktop.page.waitForTimeout(800);
await desktop.page.screenshot({ path: `${out}/members-drawer-1440-end.png` });
await drawer.getByRole('button', { name: 'Close' }).click();
// Juliette's drawer: paused, and until when (fix prompt v4.1, block 4).
await desktop.page.waitForTimeout(600);
await members.getByRole('row').filter({ hasText: 'Juliette Caron' }).click();
const paused = desktop.page.getByRole('dialog', { name: 'Juliette Caron' });
await paused.waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(1_800);
report.story.julietteDrawer = await paused.evaluate((dialog) =>
  [...dialog.querySelectorAll('p')]
    .map((line) => line.textContent)
    .filter((text) => /paused|resumes/i.test(text)),
);
await desktop.page.screenshot({ path: `${out}/members-drawer-paused-1440.png` });
await paused.getByRole('button', { name: 'Close' }).click();

// Automations (fix prompt v4.1, block 7; brief v4 §9.4): two tabs, the rules with a switch each,
// the mode, the limits, a preview tagged EN or FR; every rule off, three ready-made ones.
await desktop.page.goto(`${base}/demo/actions`, { waitUntil: 'domcontentloaded' });
await desktop.page.locator('[data-rule]').nth(4).waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(800);
const checkIn = desktop.page.locator('[data-rule="check_in"]');
await checkIn.getByRole('button', { name: /^Preview message/ }).click();
await desktop.page.waitForTimeout(500);
report.automations = await desktop.page.evaluate(() => ({
  tabs: [...document.querySelectorAll('nav[aria-label="Automations tabs"] a')].map(
    (a) => a.textContent,
  ),
  rules: document.querySelectorAll('[data-rule]').length,
  switches: document.querySelectorAll('[data-rule] [role="switch"]').length,
  on: document.querySelectorAll('[data-rule] [role="switch"][aria-checked="true"]').length,
  mode: document.querySelector('[role="radiogroup"] [aria-checked="true"]')?.textContent ?? null,
  limits: [...document.querySelectorAll('[data-limits] dd')].map((dd) => dd.textContent),
  tags: [...document.querySelectorAll('[data-lang-tag] [aria-hidden="true"]')].map(
    (tag) => tag.textContent,
  ),
  preview: document.querySelector('[data-rule="check_in"] [lang] p')?.textContent ?? null,
  primaries: document.querySelectorAll('.button-primary').length,
}));
await desktop.page.screenshot({ path: `${out}/automations-rules-1440.png` });
// Every rule off: the empty state, then its one button turns the three on. The last switch
// leaves with its card: the empty state takes the rules' place.
for (const rule of ['payment_retry', 'payment_notice', 'exit_survey', 'check_in']) {
  await desktop.page.locator(`[data-rule="${rule}"] [role="switch"]`).click();
  await desktop.page.waitForSelector(`[data-rule="${rule}"] [role="switch"]:not([aria-busy])`, {
    timeout: 10_000,
  });
}
await desktop.page.locator('[data-rule="welcome"] [role="switch"]').click();
const turnOn = desktop.page.getByRole('button', { name: 'Turn on these 3 rules' });
await turnOn.waitFor({ timeout: 10_000 });
await desktop.page.waitForTimeout(500);
report.automations.empty = await desktop.page.evaluate(() => ({
  ready: [...document.querySelectorAll('[data-ready]')].map((li) => li.getAttribute('data-ready')),
  primaries: document.querySelectorAll('.button-primary').length,
}));
report.automations.empty.title = await desktop.page.getByText('No rule is on').count();
await desktop.page.screenshot({ path: `${out}/automations-empty-1440.png` });
await turnOn.click();
await desktop.page.locator('[data-rule]').nth(4).waitFor({ timeout: 10_000 });
await desktop.page.waitForSelector('[data-rule="exit_survey"] [aria-checked="true"]', {
  timeout: 10_000,
});
report.automations.turnedOn = await desktop.page.evaluate(() =>
  [...document.querySelectorAll('[data-rule]')]
    .filter(
      (rule) => rule.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true',
    )
    .map((rule) => rule.getAttribute('data-rule')),
);
// The queue: its filters, one primary button, each row's « Approve » a ghost.
await desktop.page.goto(`${base}/demo/actions/queue`, { waitUntil: 'domcontentloaded' });
await desktop.page.getByRole('button', { name: /^Approve all/ }).waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(800);
report.automations.queue = await desktop.page.evaluate(() => ({
  filters: [...document.querySelectorAll('nav[aria-label="Show"] a')].map((a) => a.textContent),
  primaries: [...document.querySelectorAll('.button-primary')].map((b) => b.textContent),
  rowButtons: [...document.querySelectorAll('li button')]
    .filter((b) => b.textContent === 'Approve')
    .map((b) => b.classList.contains('button-ghost')),
}));
await desktop.page.screenshot({ path: `${out}/automations-queue-1440.png` });

// Analytics (fix prompt v4.1, block 7; brief v4 §9.5): the 90-day forecast and its « and if »
// slider, why members leave as a donut, 30 days of activity as bars; the cohorts' curves over
// their table, the flagged month edged in turquoise; the lessons as bars.
await desktop.page.goto(`${base}/demo/insights`, { waitUntil: 'domcontentloaded' });
await desktop.page.locator('[data-chart="act"]').waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(1_800);
const gain = () => desktop.page.locator('section:has([data-chart="act"]) dd').first().innerText();
report.analytics = await desktop.page.evaluate(() => ({
  tabs: [...document.querySelectorAll('nav[aria-label="Analytics tabs"] a')].map(
    (a) => a.textContent,
  ),
  reasons: [...document.querySelectorAll('[data-reason]')].map((r) => r.textContent),
  bars: document.querySelectorAll('[data-bar]').length,
  gridlines: document.querySelectorAll('section:has([data-chart="act"]) svg line').length,
}));
report.analytics.gain = await gain();
await desktop.page.screenshot({ path: `${out}/analytics-overview-1440.png`, fullPage: true });
await desktop.page.locator('input[type="range"]').fill('50');
await desktop.page.waitForTimeout(1_400);
report.analytics.gainAtHalf = await gain();
await desktop.page.goto(`${base}/demo/insights/cohorts`, { waitUntil: 'domcontentloaded' });
await desktop.page.locator('[data-cohort]').first().waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(1_500);
report.analytics.cohorts = await desktop.page.evaluate(() => {
  const flagged = [...document.querySelectorAll('[data-cohort][data-flagged="true"]')];
  return {
    flagged: flagged.map((row) => row.querySelector('th')?.textContent),
    edge: flagged.map((row) => getComputedStyle(row.querySelector('th')).borderLeftColor),
    highlighted: document.querySelectorAll('[data-chart="highlighted"]').length,
  };
});
await desktop.page.screenshot({ path: `${out}/analytics-cohorts-1440.png`, fullPage: true });
await desktop.page.goto(`${base}/demo/insights/lessons`, { waitUntil: 'domcontentloaded' });
await desktop.page.locator('[data-lesson]').first().waitFor({ timeout: 30_000 });
await desktop.page.waitForTimeout(1_200);
report.analytics.lessons = await desktop.page.evaluate(() => ({
  bars: document.querySelectorAll('[data-lesson]').length,
  flagged: document.querySelectorAll('[data-lesson][data-flagged="true"]').length,
}));
await desktop.page.screenshot({ path: `${out}/analytics-lessons-1440.png`, fullPage: true });

// Automations › Queue › History: what came of each action, the proof of value (block 4).
await desktop.page.goto(`${base}/demo/actions/queue/history`, { waitUntil: 'domcontentloaded' });
await desktop.page.waitForSelector('[data-outcome]', { timeout: 30_000 });
await desktop.page.waitForTimeout(800);
report.history = await desktop.page.evaluate(() =>
  [...document.querySelectorAll('li')]
    .filter((item) => item.querySelector('[data-outcome]'))
    .slice(0, 12)
    .map((item) => ({
      member: item.querySelector('p')?.textContent ?? null,
      outcome: item.querySelector('[data-outcome]').textContent,
    })),
);
await desktop.page.screenshot({ path: `${out}/actions-history-1440.png` });
// And the queue: approving one moves the tab and « Approve all » together.
await desktop.page.goto(`${base}/demo/actions/queue`, { waitUntil: 'domcontentloaded' });
const approveAll = desktop.page.getByRole('button', { name: /^Approve all/ });
await approveAll.waitFor({ timeout: 30_000 });
const queueTab = desktop.page.getByRole('link', { name: /^To approve/ });
const countIn = async (locator) => /(\d+)\)?\s*$/.exec((await locator.textContent()) ?? '')?.[1];
report.queue = { before: [await countIn(queueTab), await countIn(approveAll)] };
await desktop.page.getByRole('button', { name: 'Approve', exact: true }).first().click();
await desktop.page.getByRole('button', { name: 'Approve all (5)' }).waitFor({ timeout: 10_000 });
report.queue.after = [await countIn(queueTab), await countIn(approveAll)];
await desktop.page.screenshot({ path: `${out}/actions-queue-approved.png` });

// The words (fix prompt v4.1, block 6): « Skip » beside each « Approve », and on no page the
// internal « golden hour » nor French quotes in the English demo.
report.words = {
  skip: await desktop.page.getByRole('button', { name: 'Skip', exact: true }).count(),
  approve: await desktop.page.getByRole('button', { name: 'Approve', exact: true }).count(),
  golden: [],
  frenchQuotes: [],
};
for (const path of [
  'insights',
  'insights/cohorts',
  'insights/lessons',
  'actions',
  'actions/queue',
  'actions/queue/scheduled',
  'actions/queue/history',
  'settings/actions',
]) {
  await desktop.page.goto(`${base}/demo/${path}`, { waitUntil: 'domcontentloaded' });
  await desktop.page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 30_000 });
  await desktop.page.waitForTimeout(800);
  const text = await desktop.page.evaluate(() => document.body.innerText);
  if (/golden/i.test(text)) report.words.golden.push(path);
  if (/[«»]/.test(text)) report.words.frenchQuotes.push(path);
}
report.words.languages = await desktop.page
  .getByRole('combobox', { name: 'Language of the messages' })
  .evaluate((select) => [...select.options].map((option) => option.textContent));

// Demo safety (fix prompt v4.1, block 5): the Alumni link an example, « Open » and the bots'
// buttons said disabled, their tip over them when hovered; no link anywhere leads outside.
report.demoSafety = { links: [], buttons: [] };
const outsideLinks = () =>
  desktop.page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .filter((a) => new URL(a.href).origin !== window.location.origin || a.target)
      .map((a) => a.href),
  );
for (const [path, shot] of [
  ['actions/queue/alumni', 'demo-alumni-1440.png'],
  ['sources/discord', 'demo-discord-1440.png'],
  ['sources/telegram', 'demo-telegram-1440.png'],
]) {
  await desktop.page.goto(`${base}/demo/${path}`, { waitUntil: 'domcontentloaded' });
  const button = desktop.page.locator('[data-demo-disabled]').first();
  await button.waitFor({ timeout: 30_000 });
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  await desktop.page.waitForTimeout(400);
  const tip = desktop.page.locator(`[id="${await button.getAttribute('aria-describedby')}"]`);
  report.demoSafety.buttons.push({
    path,
    label: (await button.innerText()).trim(),
    disabled: await button.getAttribute('aria-disabled'),
    tip: await tip.innerText(),
    tipShown: await tip.evaluate((element) => getComputedStyle(element).opacity),
  });
  report.demoSafety.links.push(...(await outsideLinks()));
  if (path === 'actions/queue/alumni') {
    report.demoSafety.alumniUrl = await desktop.page.locator('code').first().innerText();
  }
  await desktop.page.screenshot({ path: `${out}/${shot}` });
}
await desktop.context.close();

const phone = await open({ width: 390, height: 844 });
await phone.page.screenshot({ path: `${out}/dashboard-390-full.png`, fullPage: true });
// On a phone, the tour too: its first and last places.
await phone.page.getByRole('button', { name: 'Guide', exact: true }).click();
await phone.page.waitForTimeout(1_200);
await phone.page.screenshot({ path: `${out}/guide-390.png` });
await phone.page.getByRole('button', { name: 'Replay the tour' }).click();
report.phoneTour = [];
for (const [index, place] of TOUR_PLACES.entries()) {
  report.phoneTour.push(await lightOn(phone.page, place, `${index + 1} of 5`));
  if (index === 0 || index === TOUR_PLACES.length - 1) {
    await phone.page.screenshot({ path: `${out}/tour-390-${index + 1}.png` });
  }
  await phone.page.locator('[data-spot="tip"] [data-autofocus]').click();
}
await phone.page.goto(`${base}/demo/members`, { waitUntil: 'domcontentloaded' });
const phoneMembers = phone.page.getByRole('table', { name: 'All members' });
await phoneMembers.waitFor({ timeout: 30_000 });
await phone.page.waitForTimeout(1_500);
report.members.phoneOverflow = await phone.page.evaluate(
  () => document.scrollingElement.scrollWidth - window.innerWidth,
);
await phone.page.screenshot({ path: `${out}/members-390.png` });
await phoneMembers.getByRole('row').nth(1).click();
await phone.page.getByRole('dialog').waitFor({ timeout: 30_000 });
await phone.page.waitForTimeout(1_500);
await phone.page.screenshot({ path: `${out}/members-drawer-390.png` });
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
  report.chart.linesDrawn >= 2 &&
  report.balance.amount !== null &&
  report.balance.amount === report.balance.chartEnds &&
  report.balance.periodClimbs &&
  report.balance.monthMark === report.balance.monthStart &&
  /^[+−]\$[\d,]+\.\d{2} vs last month$/.test(report.balance.delta ?? '') &&
  report.balance.periods.join(' ') === '7D 30D 90D' &&
  report.firstNeedingAttention === 'Margaux Picard' &&
  report.attentionRow.atRest === '0' &&
  report.attentionRow.hovered === '1' &&
  report.activity.loadingAfter5s === 0 &&
  report.guide.width === 420 &&
  report.guide.cards.length === 5 &&
  report.guide.pictures === 5 &&
  report.guide.showMe === 5 &&
  report.tour.length === 5 &&
  report.tour.every(wellLit) &&
  report.tourEnd.path === '/demo' &&
  report.tourEnd.scrollY === 0 &&
  report.showMe.length === 5 &&
  report.showMe.every(wellLit) &&
  report.phoneTour.length === 5 &&
  report.phoneTour.every((step) => step.found && step.inside) &&
  report.welcome.length === 4 &&
  report.members.columns.join(' | ') ===
    'Member | Risk | Status | MRR | Last activity | Next renewal | Do not contact' &&
  report.members.rows > 0 &&
  report.members.first === 'Hugo Bernard' &&
  report.members.heights.every((height) => height <= 60) &&
  report.members.cutHeaders === 0 &&
  report.members.redWords === 0 &&
  report.members.urgentDots > 0 &&
  report.members.chipsTop === 64 &&
  report.members.high > 0 &&
  report.members.sortedByMrr &&
  report.members.drawer.width === 420 &&
  report.members.drawer.left >= 0 &&
  report.members.drawer.right <= report.members.drawer.window &&
  report.members.drawer.pageLocked &&
  report.members.search.value === 'hugo' &&
  report.members.search.rows.length === 1 &&
  report.members.search.rows[0].includes('Hugo Bernard') &&
  report.members.search.address === 'hugo' &&
  ['Why', 'Quick actions', 'Risk over 30 days', 'Payments', 'Activity over 30 days'].every(
    (title) => report.members.drawer.sections.includes(title),
  ) &&
  report.members.drawer.scoreDrawn &&
  report.members.drawer.doNotContact === 'false' &&
  report.members.phoneOverflow <= 0 &&
  // One story (fix prompt v4.1, block 4).
  report.story.juliette.some((cell) => /^Paused · resumes \w{3} \d{1,2}$/.test(cell)) &&
  report.story.julietteDrawer.some((line) => /· resumes on /.test(line)) &&
  report.story.hugo.some((cell) => /^Ends \w{3} \d{1,2}/.test(cell)) &&
  report.story.kevin.some((cell) => /^Ends \w{3} \d{1,2}/.test(cell)) &&
  report.story.sarah.some((cell) => /^Unpaid since \w{3} \d{1,2}/.test(cell)) &&
  report.story.paul.some((cell) => cell === 'Gone') &&
  ['Recovered $49.00', 'Still failing', 'Came back', 'No reply yet'].every((outcome) =>
    report.history.some((item) => item.outcome === outcome),
  ) &&
  report.history.some((item) => /^Paused until /.test(item.outcome)) &&
  report.queue.before.join() === '6,6' &&
  report.queue.after.join() === '5,5' &&
  report.activity.byMembers.length === 2 &&
  report.activity.byMembers.every((line) => /^[\d,]+ by members$/.test(line)) &&
  // Demo safety (fix prompt v4.1, block 5).
  report.demoSafety.alumniUrl === 'https://whop.com/your-community/alumni' &&
  report.demoSafety.buttons.length === 3 &&
  report.demoSafety.buttons.every(
    (button) =>
      button.disabled === 'true' &&
      button.tip === 'Disabled in the demo' &&
      button.tipShown === '1',
  ) &&
  report.demoSafety.links.length === 0 &&
  // The words (fix prompt v4.1, block 6).
  report.words.skip > 0 &&
  report.words.skip === report.words.approve &&
  report.words.golden.length === 0 &&
  report.words.frenchQuotes.length === 0 &&
  report.words.languages.join() === 'English,French' &&
  // Automations (fix prompt v4.1, block 7; brief v4 §9.4).
  report.automations.tabs.length === 2 &&
  report.automations.tabs[0] === 'Rules' &&
  report.automations.tabs[1].startsWith('Queue') &&
  report.automations.rules === 5 &&
  report.automations.switches === 5 &&
  report.automations.on === 5 &&
  report.automations.mode === 'Manual' &&
  report.automations.limits.length === 4 &&
  report.automations.tags.length === 4 &&
  report.automations.tags.every((tag) => tag === 'EN') &&
  /^We miss you, Alex$/.test(report.automations.preview ?? '') &&
  report.automations.primaries === 0 &&
  report.automations.empty.title === 1 &&
  report.automations.empty.ready.join() === 'payment_retry,payment_notice,exit_survey' &&
  report.automations.empty.primaries === 1 &&
  report.automations.turnedOn.join() === 'payment_retry,payment_notice,exit_survey' &&
  report.automations.queue.filters.length === 4 &&
  report.automations.queue.primaries.length === 1 &&
  /^Approve all \(\d+\)$/.test(report.automations.queue.primaries[0]) &&
  report.automations.queue.rowButtons.length > 0 &&
  report.automations.queue.rowButtons.every(Boolean) &&
  // Analytics (fix prompt v4.1, block 7; brief v4 §9.5).
  report.analytics.tabs.join() === 'Overview,Cohorts,Lessons' &&
  /^\+\$[\d,]+\.\d{2}$/.test(report.analytics.gain) &&
  Math.abs(
    Number(report.analytics.gainAtHalf.replace(/[^\d.]/g, '')) * 2 -
      Number(report.analytics.gain.replace(/[^\d.]/g, '')),
  ) <= 0.02 &&
  report.analytics.reasons.length > 0 &&
  report.analytics.bars === 30 &&
  report.analytics.gridlines >= 3 &&
  report.analytics.cohorts.flagged.length > 0 &&
  report.analytics.cohorts.edge.every((color) => color === 'rgb(94, 234, 212)') &&
  report.analytics.cohorts.highlighted === 1 &&
  report.analytics.lessons.bars > 0 &&
  report.analytics.lessons.flagged > 0;
writeFileSync(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify(report, null, 2));
if (!ok) {
  console.error(
    'A font did not load or a figure is not in Satoshi, an amount lacks its cents, the demo is not in English, the chart drew nothing, does not end on the balance, goes down or does not mark where the month starts, « Needs attention » is out of order, a block of Integrations › Activity still says « Loading… » after 5 seconds, the guide or the welcome is not whole, the tour or a « Show me » misses its place or covers it, or Members, its search or its drawer is not as the brief says (fix prompt v4.1), or a « Needs attention » row shows its actions at rest, or the demo does not tell one story (a pause, an end, an unpaid date, a member gone, an outcome, a count), or something in the demo leads outside StayPut (a link, a button not said disabled), or the words are not those of block 6 (« Skip », no « golden hour », “ ” quotes, English first), or Automations is not two tabs with a switch per rule, the mode, the limits, EN/FR previews, the three ready-made rules and one primary button, or Analytics lacks its forecast, slider, donut, bars, curves or turquoise-edged flagged month (block 7): see the report above.',
  );
  process.exitCode = 1;
}
