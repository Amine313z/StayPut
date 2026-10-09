import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The key paths, in a real browser (SPEC Phase 8.6): installing StayPut (the welcome), the audit
 * (who may leave, and why), an action StayPut takes (proposed, approved, then scheduled), StayPut
 * opened from the community (a member, the team), and a save attributed (the money kept, in the
 * history and on the dashboard). The creator's paths run on the demo, answered in the browser;
 * the community's entry on answers given here, shaped as the Worker gives them. The Worker's side
 * of the same paths, from Whop's deliveries to the money saved, is apps/worker/test/journey.test.ts.
 */

// Playwright reads the fixtures a hook wants from its first parameter: none here.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== '1280x720', 'one window is enough');
});

test('installation: the welcome, step by step, then the dashboard in the mode chosen', async ({
  page,
}) => {
  await page.goto('/demo?welcome');
  const welcome = page.getByRole('dialog');
  await expect(welcome.getByText('Step 1 of 4')).toBeVisible();
  // 1. What the community is about: the score's weights follow it.
  await welcome.getByRole('radio', { name: 'Trading' }).click();
  await expect(welcome.getByRole('radio', { name: 'Trading' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await welcome.getByRole('button', { name: 'Get started' }).click();
  // 2. Discord and Telegram, optional.
  await expect(welcome.getByText('Step 2 of 4')).toBeVisible();
  await welcome.getByRole('button', { name: 'Next' }).click();
  // 3. Automatic or manual.
  await expect(welcome.getByText('Step 3 of 4')).toBeVisible();
  await welcome.getByRole('radio', { name: /^Automatic/ }).check({ force: true });
  await welcome.getByRole('button', { name: 'Next' }).click();
  // 4. The first audit: who is at risk, and what they pay.
  await expect(welcome.getByText('Step 4 of 4')).toBeVisible();
  await expect(welcome.getByRole('heading', { name: 'Your first audit' })).toBeVisible();
  await expect(welcome.getByText(/members? at risk/)).toBeVisible();
  await welcome.getByRole('button', { name: 'Go to my dashboard' }).click();
  await expect(welcome).toBeHidden();
  await expect(page.getByText('Revenue saved · This month').first()).toBeVisible();
  // The mode chosen is the one Automations shows.
  await page
    .getByRole('navigation', { name: 'Dashboard sections' })
    .getByRole('link', {
      name: 'Automations',
    })
    .click();
  await expect(page.getByRole('radiogroup').getByRole('radio', { checked: true })).toHaveText(
    /Automatic/,
  );
});

test('audit: the members at high risk, each with the reasons of their score', async ({ page }) => {
  await page.goto('/demo/members');
  const table = page.getByRole('table', { name: 'All members' });
  await table.waitFor();
  const high = page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^High/ });
  await high.click();
  await expect(high).toHaveAttribute('aria-pressed', 'true');
  // As many rows as the filter counts, each scored 70 or more (the high level's threshold).
  const counted = Number(/(\d+)$/.exec((await high.textContent()) ?? '')?.[1]);
  expect(counted).toBeGreaterThan(0);
  const rows = table.locator('[role=rowgroup]:last-child > [role=row]');
  await expect(rows).toHaveCount(counted);
  for (const row of await rows.all()) {
    // The score's cell holds its number alone.
    const cells = await row.getByRole('cell').allTextContents();
    const score = cells.map((cell) => cell.trim()).find((cell) => /^\d{1,3}$/.test(cell));
    expect(Number(score)).toBeGreaterThanOrEqual(70);
  }
  // The first of them: why StayPut thinks they may leave.
  await rows.first().click();
  const drawer = page.getByRole('dialog');
  const why = drawer.getByRole('region', { name: 'Why' });
  await expect(why.getByRole('listitem').first()).toBeVisible();
});

test('an action: proposed in the queue, approved, then scheduled', async ({ page }) => {
  await page.goto('/demo/actions/queue');
  const approveAll = page.getByRole('button', { name: /^Approve all/ });
  await approveAll.waitFor();
  const count = async () => Number(/\((\d+)\)/.exec((await approveAll.textContent()) ?? '')?.[1]);
  const before = await count();
  expect(before).toBeGreaterThan(1);
  // The first proposal: who it is for, approved.
  const first = page.getByRole('button', { name: 'Approve', exact: true }).first();
  const item = page.locator('li', { has: first }).first();
  const who = (await item.locator('p').first().textContent())?.trim() ?? '';
  expect(who).not.toBe('');
  await first.click();
  await expect.poll(count).toBe(before - 1);
  // It now waits for its time, in the scheduled ones.
  await page.getByRole('link', { name: /^Scheduled/ }).click();
  await expect(page.locator('li', { hasText: who }).first()).toBeVisible();
});

test('a save attributed: the money a retry recovered, in the history and on the dashboard', async ({
  page,
}) => {
  await page.goto('/demo/actions/queue/history');
  const recovered = page.locator('[data-outcome="recovered"]').first();
  await expect(recovered).toBeVisible();
  // « Recovered $49.00 »: the amount the member paid after the action, with its cents.
  await expect(recovered).toHaveText(/^Recovered \$\d[\d,]*\.\d{2}$/);
  // The dashboard counts the month's saves: an amount with its cents, above zero.
  await page.goto('/demo');
  const hero = page.getByText('Revenue saved · This month').first();
  await expect(hero).toBeVisible();
  const figure = page.locator('[data-tour="hero-amount"]');
  await expect(figure).toContainText(/\$[1-9][\d,]*\.\d{2}/);
});

/**
 * StayPut opened from the community (Whop's experience view), answered as the Worker answers
 * `/home`. Members have no StayPut space (2026-10-08): the departure survey and the offers reach
 * them in the community's support chat (apps/worker/test/journey.test.ts), never on a page.
 */
async function entryApi(page: Page, home: { dashboard: string | null; locale: 'en' | 'fr' }) {
  const asked: string[] = [];
  await page.route('**/api/member/exp_Journey/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    asked.push(path);
    if (path === '/api/member/exp_Journey/home') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(home) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return asked;
}

test('a member who opens StayPut: StayPut’s loading screen, then nothing to do, in French', async ({
  page,
}) => {
  const asked = await entryApi(page, { dashboard: null, locale: 'fr' });
  await page.goto('/experiences/exp_Journey');
  await expect(page.getByText('Rien à faire ici')).toBeVisible();
  // The loading screen has gone; nothing of a space, never a risk score (SPEC 5.3).
  await expect(page.locator('#boot')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
  await expect(page.getByText(/risk|risque/i)).toHaveCount(0);
  expect(asked).toEqual(['/api/member/exp_Journey/home']);
});

test('the team who opens StayPut in its community lands on its dashboard, nothing between', async ({
  page,
}) => {
  await entryApi(page, { dashboard: '/demo', locale: 'en' });
  // Every frame the page draws until the dashboard: StayPut's loading screen, never the
  // member page's « Nothing to do here ».
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    const look = () => {
      if (document.body?.innerText.includes('Nothing to do here')) seen.push('nothing');
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.goto('/experiences/exp_Journey');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.locator('#boot')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([]);
});
