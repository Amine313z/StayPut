import { MESSAGES } from '@stayput/i18n';
import { describe, expect, it } from 'vitest';
import { GUIDE_CARDS, SHORTCUTS, TOUR, haloBox, inView, pageHref, placeCard } from '../src/guide';

const VIEW = { width: 1440, height: 900 };
const CARD = { width: 320, height: 170 };

describe('the guide', () => {
  it('tours the five places of the brief, in its order (§10)', () => {
    expect(TOUR.map((step) => step.id)).toEqual([
      'hero',
      'priority',
      'risk',
      'automations',
      'integrations',
    ]);
    // A phone has no side menu: Integrations is found under « More ».
    expect(TOUR.at(-1)?.targets).toEqual(['[data-tour="nav-sources"]', '[data-tour="nav-more"]']);
  });

  it('has five cards and four shortcuts, each said in both languages', () => {
    expect(GUIDE_CARDS.map((card) => card.id)).toEqual([
      'who',
      'keep',
      'money',
      'control',
      'connect',
    ]);
    expect(SHORTCUTS).toHaveLength(4);
    const keys = [
      ...GUIDE_CARDS.flatMap((card) => [card.title, card.body]),
      ...SHORTCUTS.map((shortcut) => shortcut.label),
      ...TOUR.flatMap((step) => [step.title, step.body]),
    ];
    for (const key of keys) {
      expect(MESSAGES.en[key], key).toBeTruthy();
      expect(MESSAGES.fr[key], key).toBeTruthy();
    }
    // Every place is one a screen marks (`data-tour`).
    for (const target of [...GUIDE_CARDS, ...SHORTCUTS, ...TOUR].flatMap((spot) => spot.targets)) {
      expect(target).toMatch(/^\[data-tour="[a-z-]+"\]/);
    }
    expect(pageHref('/demo', '')).toBe('/demo');
    expect(pageHref('/demo', 'settings/actions')).toBe('/demo/settings/actions');
  });

  it('keeps the validated words: no test mode, no mechanics (§10, §12)', () => {
    for (const locale of ['en', 'fr'] as const) {
      const words = GUIDE_CARDS.map((card) => MESSAGES[locale][card.body]).join(' ');
      expect(words).not.toMatch(/test|direct|influenc|guardrail|garde-fou/i);
    }
  });

  it('puts the card under the lit place, else above, else beside it, else in the middle', () => {
    // Room below.
    expect(placeCard({ x: 600, y: 100, width: 300, height: 80 }, CARD, VIEW)).toEqual({
      x: 590,
      y: 192,
      side: 'below',
    });
    // At the bottom: above.
    expect(placeCard({ x: 600, y: 700, width: 300, height: 120 }, CARD, VIEW).side).toBe('above');
    // As tall as the window: beside it, on the right first.
    expect(placeCard({ x: 0, y: 20, width: 220, height: 860 }, CARD, VIEW)).toEqual({
      x: 232,
      y: 20,
      side: 'right',
    });
    expect(placeCard({ x: 1100, y: 20, width: 330, height: 860 }, CARD, VIEW).side).toBe('left');
    // Nothing lit: in the middle.
    expect(placeCard(null, CARD, VIEW)).toEqual({ x: 560, y: 365, side: 'center' });
    // Never out of the window: a place at its left edge keeps the card 16 px in.
    expect(placeCard({ x: 0, y: 100, width: 40, height: 40 }, CARD, VIEW).x).toBe(16);
  });

  it('draws the halo around the place, inside the window', () => {
    expect(haloBox({ x: 100, y: 100, width: 200, height: 50 }, VIEW)).toEqual({
      x: 92,
      y: 92,
      width: 216,
      height: 66,
    });
    expect(haloBox({ x: 0, y: 860, width: 1440, height: 60 }, VIEW)).toEqual({
      x: 2,
      y: 852,
      width: 1436,
      height: 46,
    });
    // Under the top bar (64 px) or behind a phone's bottom bar: not on screen.
    expect(inView({ x: 0, y: 40, width: 10, height: 10 }, VIEW)).toBe(false);
    expect(inView({ x: 0, y: 100, width: 10, height: 10 }, VIEW)).toBe(true);
    expect(inView({ x: 0, y: 820, width: 10, height: 30 }, VIEW, 64, 72)).toBe(false);
  });
});
