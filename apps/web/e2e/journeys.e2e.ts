import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The key paths, in a real browser (SPEC Phase 8.6): installing StayPut (the welcome), the audit
 * (who may leave, and why), an action StayPut takes (proposed, approved, then scheduled), the
 * member's own page (the departure survey and its offer), and a save attributed (the money kept,
 * in the history and on the dashboard). The creator's paths run on the demo, answered in the
 * browser; the member's on answers given here, shaped as the Worker gives them. The Worker's side
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

/** The member's page, answered as the Worker answers it: a cancellation, then the survey. */
async function memberApi(page: Page) {
  const retention = (departure: Record<string, unknown>) => ({
    creatorName: 'Atlas Trading Club',
    locale: 'en',
    whopAppId: null,
    alumniUrl: null,
    preview: null,
    payment: null,
    departure: {
      endsAt: '2026-11-01T00:00:00.000Z',
      reason: null,
      offer: null,
      outcome: 'pending',
      result: null,
      ...departure,
    },
    alumni: null,
    creatorOffer: null,
  });
  const offer = { type: 'promo_offer', percentOff: 20, months: 3, keep: 'required' };
  const posted: Record<string, unknown> = {};
  await page.route('**/api/member/exp_Journey/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/member/exp_Journey/', '');
    const json = (body: unknown) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (route.request().method() === 'POST') {
      posted[path] = route.request().postDataJSON() as unknown;
    }
    if (path === 'session') {
      return json({
        experienceId: 'exp_Journey',
        userId: 'user_Journey',
        accessLevel: 'customer',
        via: 'iframe',
      });
    }
    if (path === 'telegram') {
      return json({ available: false, linked: false, link: null, whopAppId: null });
    }
    if (path === 'retention') return json(retention({}));
    if (path === 'retention/survey') {
      return json(retention({ reason: 'too_expensive', offer }));
    }
    if (path === 'retention/offer') {
      return json(
        retention({
          reason: 'too_expensive',
          offer,
          outcome: 'accepted',
          result: { status: 'applied', kept: true, promoApplied: true },
        }),
      );
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return posted;
}

test('the member’s page: why they leave, the offer for it, and their membership kept', async ({
  page,
}) => {
  const posted = await memberApi(page);
  await page.goto('/experiences/exp_Journey');
  await expect(page.getByRole('heading', { name: 'Your membership is ending' })).toBeVisible();
  // Never a risk score on the member's side (SPEC 5.3).
  await expect(page.getByText(/risk/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'It’s too expensive' }).click();
  expect(posted['retention/survey']).toEqual({ reason: 'too_expensive' });
  // The offer for that reason: 20% off for 3 months, the membership kept with consent.
  await expect(page.getByText('20% off for 3 months')).toBeVisible();
  const accept = page.getByRole('button', { name: 'Take the discount' });
  await expect(accept).toBeDisabled();
  await page.getByLabel('I keep my membership: my cancellation is withdrawn.').check();
  await accept.click();
  expect(posted['retention/offer']).toEqual({ accept: true, keep: true });
  // What came of it, in the member's words: the discount on their next payments, the
  // membership going on.
  await expect(page.getByText('Done: 20% off your next 3 payments.')).toBeVisible();
  await expect(
    page.getByText('Your membership continues: your cancellation is withdrawn.'),
  ).toBeVisible();
});
