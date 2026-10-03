import type { MessageKey } from '@stayput/i18n';

/**
 * The guide (brief v4 §10 and §11): what the tour, the guide's cards and its shortcuts point at.
 * Every place they light up marks itself with `data-tour="<name>"`; a spot lists the selectors
 * it may land on, the first one on screen wins (the menu's item on a computer, « More » on a
 * phone). Pure: the components (components/guide) draw it.
 */

const at = (name: string) => `[data-tour="${name}"]`;

/** A place to light up: the first of these selectors found on screen. */
export type Targets = readonly string[];

export interface TourStep {
  id: 'hero' | 'priority' | 'risk' | 'automations' | 'integrations';
  targets: Targets;
  /** What the place is called: the words the page itself uses for it. */
  title: MessageKey;
  body: MessageKey;
}

/** The tour, on the dashboard: hero amount → priority action → risk ring → Automations → Integrations. */
export const TOUR: readonly TourStep[] = [
  { id: 'hero', targets: [at('hero')], title: 'dash.saved', body: 'tour.hero' },
  { id: 'priority', targets: [at('priority')], title: 'dash.priority', body: 'tour.priority' },
  {
    id: 'risk',
    // The first member's ring; while « Needs attention » has nobody, the list itself.
    targets: [`${at('attention')} [data-risk-ring]`, at('attention')],
    title: 'tab.riskScore',
    body: 'tour.risk',
  },
  {
    id: 'automations',
    targets: [at('nav-actions')],
    title: 'nav.actions',
    body: 'tour.automations',
  },
  {
    id: 'integrations',
    targets: [at('nav-sources'), at('nav-more')],
    title: 'nav.sources',
    body: 'tour.integrations',
  },
];

export interface GuideCard {
  id: 'who' | 'keep' | 'money' | 'control' | 'connect';
  title: MessageKey;
  body: MessageKey;
  /** « Show me »: the page, after the dashboard's root (`''`: the dashboard), and its place. */
  page: string;
  targets: Targets;
}

/** The guide's five cards, in the validated words (§11). */
export const GUIDE_CARDS: readonly GuideCard[] = [
  {
    id: 'who',
    title: 'guide.who.title',
    body: 'guide.who.body',
    page: '',
    targets: [at('attention')],
  },
  {
    id: 'keep',
    title: 'guide.keep.title',
    body: 'guide.keep.body',
    page: 'settings/actions',
    targets: [at('mode')],
  },
  {
    id: 'money',
    title: 'guide.money.title',
    body: 'guide.money.body',
    page: '',
    targets: [at('hero')],
  },
  {
    id: 'control',
    title: 'guide.control.title',
    body: 'guide.control.body',
    page: 'settings/actions',
    targets: [at('limits')],
  },
  {
    id: 'connect',
    title: 'guide.connect.title',
    body: 'guide.connect.body',
    page: 'sources',
    // The invitation to connect while nothing is; once something is, the platforms' tabs.
    targets: [at('connect'), at('tabs')],
  },
];

export interface Shortcut {
  id: 'leaving' | 'retries' | 'connect' | 'limits';
  label: MessageKey;
  page: string;
  /** The control to bring forward there (a brief light, the page stays usable); none: the page. */
  targets: Targets;
}

/** « What do you want to do? »: four ways straight to the screen that does it. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'leaving', label: 'guide.do.leaving', page: 'members?filter=leaving', targets: [] },
  { id: 'retries', label: 'guide.do.retries', page: 'settings/actions', targets: [at('retries')] },
  {
    id: 'connect',
    label: 'guide.do.connect',
    page: 'sources',
    targets: [at('connect'), at('tabs')],
  },
  { id: 'limits', label: 'guide.do.limits', page: 'settings/actions', targets: [at('limits')] },
];

/** A page of the dashboard, from its root. */
export function pageHref(root: string, page: string): string {
  return page ? `${root}/${page}` : root;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Around the lit place: room for the 2 px halo without touching what it frames. */
export const HALO_PAD = 8;

/** The halo around an element's box, kept inside the window. */
export function haloBox(element: Box, view: Size, pad = HALO_PAD): Box {
  const x = Math.max(2, element.x - pad);
  const y = Math.max(2, element.y - pad);
  const right = Math.min(view.width - 2, element.x + element.width + pad);
  const bottom = Math.min(view.height - 2, element.y + element.height + pad);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Whether an element is wholly on screen, under the top bar and above a phone's bottom bar. */
export function inView(element: Box, view: Size, top = 64, bottom = 0): boolean {
  return element.y >= top && element.y + element.height <= view.height - bottom;
}

export type Side = 'below' | 'above' | 'right' | 'left' | 'center';

/**
 * Where the tour's card goes beside the lit place: under it when it fits, else above, else to
 * its right (a menu item), else to its left; centred when nothing fits (or nothing is lit). Kept
 * `margin` inside the window, `gap` from the halo.
 */
export function placeCard(
  halo: Box | null,
  card: Size,
  view: Size,
  gap = 12,
  margin = 16,
): { x: number; y: number; side: Side } {
  const clampX = (x: number) => Math.max(margin, Math.min(x, view.width - margin - card.width));
  const clampY = (y: number) => Math.max(margin, Math.min(y, view.height - margin - card.height));
  if (halo) {
    const centredX = clampX(halo.x + halo.width / 2 - card.width / 2);
    if (halo.y + halo.height + gap + card.height <= view.height - margin) {
      return { x: centredX, y: halo.y + halo.height + gap, side: 'below' };
    }
    if (halo.y - gap - card.height >= margin) {
      return { x: centredX, y: halo.y - gap - card.height, side: 'above' };
    }
    if (halo.x + halo.width + gap + card.width <= view.width - margin) {
      return { x: halo.x + halo.width + gap, y: clampY(halo.y), side: 'right' };
    }
    if (halo.x - gap - card.width >= margin) {
      return { x: halo.x - gap - card.width, y: clampY(halo.y), side: 'left' };
    }
  }
  return {
    x: clampX((view.width - card.width) / 2),
    y: clampY((view.height - card.height) / 2),
    side: 'center',
  };
}

/** The first of the selectors that names something on screen (a hidden menu has no size). */
export function findTarget(targets: Targets, root: ParentNode = document): HTMLElement | null {
  for (const selector of targets) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return element;
    }
  }
  return null;
}
