import { MESSAGES } from '@stayput/i18n';
import { describe, expect, it } from 'vitest';
import {
  GUIDE_CARDS,
  SHORTCUTS,
  TOUR,
  contains,
  cutOut,
  intersects,
  pageHref,
  placeTip,
} from '../src/guide';

const VIEW = { width: 1440, height: 900 };
const TIP = { width: 320, height: 170 };
const boxOf = (place: { x: number; y: number }) => ({ ...place, ...TIP });

describe('the guide', () => {
  it('tours the five places of the brief, in its order, each on its page (§10, v4.1)', () => {
    expect(TOUR.map((step) => [step.id, step.page, step.targets[0]])).toEqual([
      ['hero', '', '[data-tour="hero-amount"]'],
      ['priority', '', '[data-tour="priority-action"]'],
      ['risk', '', '[data-tour="risk-ring"]'],
      ['automations', 'actions', '[data-tour="rule-payment-retry"]'],
      ['integrations', 'sources/discord', '[data-tour="connect-discord"]'],
    ]);
    // « Show me » lights the same places as the tour, with its words, where the tour shows them.
    expect(GUIDE_CARDS.map((card) => [card.id, card.page, card.targets[0], card.step])).toEqual([
      ['who', '', '[data-tour="attention-row"]', undefined],
      ['keep', 'actions', '[data-tour="rule-payment-retry"]', 'automations'],
      ['money', '', '[data-tour="hero-amount"]', 'hero'],
      ['control', 'settings/actions', '[data-tour="limits"]', undefined],
      ['connect', 'sources/discord', '[data-tour="connect-discord"]', 'integrations'],
    ]);
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

  it('cuts the page out around the place, 8 px of room, the place wholly inside', () => {
    const place = { x: 100, y: 100, width: 200, height: 50 };
    expect(cutOut(place)).toEqual({ x: 92, y: 92, width: 216, height: 66 });
    expect(contains(cutOut(place), place)).toBe(true);
    expect(contains(place, cutOut(place))).toBe(false);
    // Side by side is not overlapping; one pixel over is.
    expect(intersects(place, { x: 300, y: 100, width: 10, height: 10 })).toBe(false);
    expect(intersects(place, { x: 299, y: 100, width: 10, height: 10 })).toBe(true);
  });

  it('puts the tooltip on the first side with room: right, bottom, left, top', () => {
    // Room on the right: there, the arrow at the place's middle.
    const left = { x: 200, y: 300, width: 200, height: 80 };
    expect(placeTip(left, TIP, VIEW)).toEqual({ x: 414, y: 255, side: 'right', arrow: 85 });
    // No room on the right: under it, kept 16 px inside the window.
    const corner = { x: 1200, y: 300, width: 220, height: 60 };
    expect(placeTip(corner, TIP, VIEW)).toEqual({ x: 1104, y: 374, side: 'bottom', arrow: 206 });
    // As wide as the page, near its bottom: above it.
    const wide = { x: 16, y: 700, width: 1408, height: 120 };
    expect(placeTip(wide, TIP, VIEW)).toMatchObject({ y: 516, side: 'top' });
    // Nothing lit: the middle of the window.
    expect(placeTip(null, TIP, VIEW)).toEqual({ x: 560, y: 365, side: 'center', arrow: 0 });
  });

  it('never covers the place, what is lit next, nor leaves the window', () => {
    const place = { x: 200, y: 100, width: 400, height: 60 };
    const next = { x: 600, y: 0, width: 400, height: 400 };
    const tip = placeTip(place, TIP, VIEW, { avoid: [next] });
    expect(tip.side).toBe('bottom');
    expect(intersects(boxOf(tip), next)).toBe(false);
    expect(intersects(boxOf(tip), place)).toBe(false);
    // In the side menu: always to the right of the menu.
    expect(
      placeTip({ x: 8, y: 200, width: 204, height: 40 }, TIP, VIEW, { menuEdge: 220 }),
    ).toEqual({ x: 234, y: 135, side: 'right', arrow: 85 });
    // Nowhere to go: still wholly in the window.
    const all = placeTip({ x: 0, y: 0, width: 1440, height: 900 }, TIP, VIEW);
    expect(contains({ x: 16, y: 16, width: 1408, height: 868 }, boxOf(all))).toBe(true);
  });
});
