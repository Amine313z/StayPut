import { expect, test, type Page } from '@playwright/test';

/**
 * Members in a real browser (fix prompt v4.1, block 3): the search keeps every key typed fast and
 * finds Hugo Bernard alone; a member's drawer stands wholly in the window at 1024 and 1440 px,
 * anchored to its right edge, the page behind locked still; a « Needs attention » row shows its
 * actions only when hovered.
 */

// Playwright reads the fixtures a hook wants from its first parameter: none here.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(({}, info) => {
  // The widths are the test's own: one project is enough.
  test.skip(info.project.name !== '1280x720', 'the test sets its own window sizes');
});

async function openMembers(page: Page) {
  await page.goto('/demo/members');
  await page.getByRole('table', { name: 'All members' }).waitFor();
}

const rows = (page: Page) =>
  page
    .getByRole('table', { name: 'All members' })
    .locator('[role=rowgroup]:last-child > [role=row]');

test('the search keeps every key, finds Hugo Bernard alone, then writes the address', async ({
  page,
}) => {
  await openMembers(page);
  const field = page.getByRole('searchbox', { name: 'Search a member' });
  for (const query of ['hugo', 'HUGO', 'Hugó']) {
    await field.fill('');
    await field.pressSequentially(query, { delay: 15 });
    await expect(field).toHaveValue(query);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Hugo Bernard');
  }
  // 250 ms after the last key, the address holds the words.
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Hugó');
  // Nothing found: said with the words, and one click back to everyone.
  await field.fill('zzz');
  await expect(page.getByText('No member matches “zzz”.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search and filters' }).click();
  await expect(field).toHaveValue('');
  await expect.poll(() => rows(page).count()).toBeGreaterThan(30);
});

for (const width of [1024, 1440]) {
  test(`a member's drawer stands wholly in the window at ${width} px, the page locked`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await openMembers(page);
    // The page's width beside its scrollbar, before the drawer locks it.
    const pageWidth = await page.evaluate(() => document.documentElement.clientWidth);
    await rows(page).first().click();
    const drawer = page.getByRole('dialog', { name: 'Hugo Bernard' });
    await drawer.waitFor();
    // Its quick actions are there: the drawer has landed.
    await drawer.getByRole('button', { name: /^Offer Hugo Bernard/ }).waitFor();
    await page.waitForTimeout(700);
    const box = await drawer.evaluate((dialog) => {
      const r = dialog.getBoundingClientRect();
      const clipped = [...dialog.querySelectorAll('*')].filter((element) => {
        const b = element.getBoundingClientRect();
        return b.width > 0 && (b.right > r.right + 0.5 || b.left < r.left - 0.5);
      });
      return {
        left: r.left,
        right: r.right,
        width: r.width,
        // The window, its scrollbar's room included.
        window: window.innerWidth,
        clipped: clipped.length,
      };
    });
    // 420 px against the page's right edge (the scrollbar's room kept beside it, if any):
    // never past the window, never short of the page.
    expect(box.width).toBe(Math.min(420, width));
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.window + 0.5);
    expect(box.right).toBeGreaterThanOrEqual(pageWidth - 0.5);
    expect(box.clipped).toBe(0);
    for (const name of [/^Message Hugo Bernard/, /^Offer Hugo Bernard/, /^Make Hugo Bernard/]) {
      const button = await drawer.getByRole('button', { name }).boundingBox();
      expect(button).not.toBeNull();
      expect(button!.x + button!.width).toBeLessThanOrEqual(box.right);
    }
    // The page behind does not scroll while the drawer is open.
    const before = await page.evaluate(() => window.scrollY);
    await page.mouse.move(100, 400);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Closed, the page scrolls again.
    await expect(page.locator('html')).not.toHaveAttribute('data-scroll-lock');
    await expect(page.locator('html')).not.toHaveCSS('overflow', 'hidden');
  });
}

test('a « Needs attention » row shows a chevron at rest, its actions when hovered', async ({
  page,
}) => {
  await page.goto('/demo');
  const attention = page.locator('[data-tour="attention"]');
  const first = attention.getByRole('listitem').first();
  await first.waitFor();
  const actions = first.locator('[data-row-actions]');
  await page.mouse.move(5, 5);
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(first.locator('[data-row-chevron]')).toBeVisible();
  await first.hover();
  await expect(actions).toHaveCSS('opacity', '1');
  // Each icon names itself while hovered.
  const message = first.getByRole('button', { name: /^Message / });
  await message.hover();
  await expect(first.locator('[data-tip]', { hasText: 'Message' })).toHaveCSS('opacity', '1');
  // The row itself opens the member.
  await page.mouse.move(5, 5);
  const name = await first.getByRole('link').textContent();
  await first.getByRole('link').click();
  await expect(page.getByRole('dialog', { name: name! })).toBeVisible();
});
