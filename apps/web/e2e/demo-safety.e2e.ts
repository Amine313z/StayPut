import { expect, test, type Page } from '@playwright/test';

/**
 * The demo in a real browser (fix prompt v4.1, block 5): no page of /demo calls a host other
 * than StayPut's own, nor StayPut's API (the demo is answered in the browser); no link on it
 * leads outside or to a new tab; every button that would open a page outside StayPut says
 * « Disabled in the demo » when hovered, and opens nothing when clicked.
 */

// Playwright reads the fixtures a hook wants from its first parameter: none here.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== '1280x720', 'one window is enough');
});

/** The pages with a button to a page outside StayPut: Alumni's « Open », the bots' « Add ». */
const WITH_WAY_OUT = new Set(['actions/queue/alumni', 'sources/discord', 'sources/telegram']);

/** Every page of the demo's menu, each tab included. */
const PAGES = [
  '',
  'members',
  'members/never-contact',
  'actions',
  'actions/queue',
  'actions/queue/scheduled',
  'actions/queue/history',
  'actions/queue/alumni',
  'insights',
  'insights/cohorts',
  'insights/lessons',
  'sources',
  'sources/discord',
  'sources/telegram',
  'settings',
  'settings/risk',
  'settings/actions',
];

/** Links within StayPut only, none to a new tab. */
async function expectLinksInside(page: Page, origin: string, where: string) {
  const links = await page.locator('a[href]').evaluateAll((anchors) =>
    anchors.map((a) => ({
      href: (a as HTMLAnchorElement).href,
      target: a.getAttribute('target'),
    })),
  );
  for (const link of links) {
    expect(new URL(link.href).origin, `${where}: ${link.href}`).toBe(origin);
    expect(link.target, `${where}: ${link.href}`).toBeNull();
  }
}

test('no page of the demo leads or calls outside StayPut', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const calls: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.origin !== origin || url.pathname.startsWith('/api/')) calls.push(request.url());
  });
  // A tab opened from the demo would count too.
  const opened: string[] = [];
  page.context().on('page', (tab) => opened.push(tab.url()));
  let disabled = 0;

  for (const path of PAGES) {
    const where = `/demo${path ? `/${path}` : ''}`;
    await page.goto(where);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    // The page's own data read (the demo answers after a short wait).
    await expect(page.locator('.skeleton')).toHaveCount(0);
    await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0);
    if (WITH_WAY_OUT.has(path)) await page.locator('[data-demo-disabled]').first().waitFor();
    await expectLinksInside(page, origin, where);
    for (const button of await page.locator('[data-demo-disabled]').all()) {
      disabled += 1;
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      const tip = page.locator(`[id="${await button.getAttribute('aria-describedby')}"]`);
      await expect(tip).toHaveText('Disabled in the demo');
      // Hovered: its tip shows.
      await button.scrollIntoViewIfNeeded();
      await button.hover();
      await expect(tip).toHaveCSS('opacity', '1');
      // Clicked (forced: Playwright waits for an enabled button otherwise): nothing opens.
      await button.click({ force: true });
      await page.waitForTimeout(300);
      expect(new URL(page.url()).pathname, where).toBe(where);
    }
  }
  // The guide's panel too.
  await page.goto('/demo');
  await page.getByRole('button', { name: 'Guide' }).click();
  await page.getByRole('dialog', { name: 'How StayPut works' }).waitFor();
  await expectLinksInside(page, origin, 'guide');

  // Alumni's « Open », Discord's and Telegram's buttons at least.
  expect(disabled).toBeGreaterThanOrEqual(3);
  expect(opened).toEqual([]);
  expect(calls).toEqual([]);
});
