import { expect, test, type Page } from '@playwright/test';
import { contains, cutOut, intersects, type Box } from '../src/guide';

/**
 * The spotlight in a real browser (fix prompt v4.1, block 1): the tour and every « Show me », in
 * English and in French, at 1280×720 and 1024×768 (the config's projects). For each place, once
 * the light has landed: the place lies wholly inside the cut-out and on screen, and the tooltip
 * stands in the window without touching the place, nor what the tour lights next on that page.
 * The tour then ends where it began.
 */

const WORDS = {
  en: {
    replay: 'Replay the tour',
    showMe: 'Show me',
    dashboard: 'Dashboard',
    guide: 'How StayPut works',
  },
  fr: {
    replay: 'Revoir la visite',
    showMe: 'Montrez-moi',
    dashboard: 'Tableau de bord',
    guide: 'Comment marche StayPut',
  },
} as const;

/** The tour's places, in its order. */
const TOUR = [
  'hero-amount',
  'priority-action',
  'risk-ring',
  'rule-payment-retry',
  'connect-discord',
];
/** The tour's places on the dashboard: each tooltip there keeps clear of the next place. */
const SAME_PAGE = 3;
/** Each « Show me »'s place, in the guide's order. */
const CARDS = ['attention-row', 'rule-payment-retry', 'hero-amount', 'limits', 'connect-discord'];

interface Light {
  target: Box | null;
  next: Box | null;
  cut: Box;
  tip: Box;
  side: string;
  view: { width: number; height: number };
}

/** The demo's dashboard; in French, chosen in Settings (the demo keeps it for the visit). */
async function openDemo(page: Page, locale: keyof typeof WORDS) {
  if (locale === 'fr') {
    await page.goto('/demo/settings');
    await page.getByRole('radio', { name: 'Français' }).click();
    await page.getByRole('link', { name: WORDS.fr.dashboard, exact: true }).first().click();
  } else {
    await page.goto('/demo');
  }
  await page.locator('[data-tour="hero-amount"]').waitFor();
}

/** What the light shows now; null while it is still on its way (no tooltip yet). */
async function readLight(page: Page, place: string, next: string | null): Promise<Light | null> {
  return page.evaluate(
    ([place, next]) => {
      const boxOf = (element: Element | null) => {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      };
      const first = (name: string) =>
        [...document.querySelectorAll(`[data-tour="${name}"]`)].find((element) => {
          const r = element.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }) ?? null;
      const tip = document.querySelector('[data-spot="tip"]');
      const cut = document.querySelector('[data-spot="cut"]');
      const side = tip?.getAttribute('data-side');
      if (!tip || !cut || !side || getComputedStyle(tip).opacity !== '1') return null;
      return {
        target: boxOf(first(place)),
        next: next ? boxOf(first(next)) : null,
        cut: boxOf(cut)!,
        tip: boxOf(tip)!,
        side,
        view: { width: window.innerWidth, height: window.innerHeight },
      };
    },
    [place, next] as const,
  );
}

const same = (a: Box, b: Box) =>
  Math.abs(a.x - b.x) < 0.5 &&
  Math.abs(a.y - b.y) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;

/** Waits for the light to land (cut-out and tooltip still for two looks), then reads it. */
async function landed(page: Page, place: string, next: string | null = null): Promise<Light> {
  let previous: Light | null = null;
  let light: Light | null = null;
  await expect
    .poll(
      async () => {
        light = await readLight(page, place, next);
        const still =
          light !== null &&
          previous !== null &&
          same(light.cut, previous.cut) &&
          same(light.tip, previous.tip);
        previous = light;
        return still;
      },
      { message: `the light on « ${place} » lands`, timeout: 15_000, intervals: [250] },
    )
    .toBe(true);
  return light!;
}

const inWindow = (box: Box, view: Light['view']) =>
  box.x >= 0 && box.y >= 0 && box.x + box.width <= view.width && box.y + box.height <= view.height;

function check(light: Light, place: string) {
  const { target, cut, tip, view } = light;
  expect(target, `« ${place} » is on the page`).not.toBeNull();
  expect(contains(cut, target!), `« ${place} » lies wholly inside the cut-out`).toBe(true);
  expect(inWindow(target!, view), `« ${place} » is wholly on screen`).toBe(true);
  expect(intersects(tip, target!), `the tooltip clears « ${place} »`).toBe(false);
  expect(inWindow(tip, view), `the tooltip of « ${place} » is wholly on screen`).toBe(true);
  if (light.next && inWindow(light.next, view)) {
    expect(
      intersects(tip, cutOut(light.next)),
      `the tooltip clears what comes after « ${place} »`,
    ).toBe(false);
  }
}

for (const locale of ['en', 'fr'] as const) {
  const words = WORDS[locale];

  test(`the tour lights each place wholly, its tooltip beside it, then ends where it began (${locale})`, async ({
    page,
  }) => {
    await openDemo(page, locale);
    const start = page.url();
    await page.getByRole('button', { name: 'Guide', exact: true }).click();
    await page.getByRole('button', { name: words.replay }).click();
    for (const [index, place] of TOUR.entries()) {
      const next = index + 1 < SAME_PAGE ? TOUR[index + 1]! : null;
      check(await landed(page, place, next), place);
      // Next, and Done on the last place.
      await page.locator('[data-spot="tip"] [data-autofocus]').click();
    }
    await expect(page.locator('[data-spot="tip"]')).toHaveCount(0);
    expect(page.url()).toBe(start);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });

  test(`every « Show me » lights its place wholly, its tooltip beside it (${locale})`, async ({
    page,
  }) => {
    await openDemo(page, locale);
    for (const [index, place] of CARDS.entries()) {
      await page.getByRole('button', { name: 'Guide', exact: true }).click();
      await page
        .getByRole('dialog', { name: words.guide })
        .getByRole('button', { name: words.showMe })
        .nth(index)
        .click();
      check(await landed(page, place), place);
      // « Got it ».
      await page.locator('[data-spot="tip"] [data-autofocus]').click();
      await expect(page.locator('[data-spot="tip"]')).toHaveCount(0);
    }
  });
}
