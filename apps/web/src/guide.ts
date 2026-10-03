import type { MessageKey } from '@stayput/i18n';

/**
 * The guide (brief v4 §10 and §11, fix prompt v4.1 block 1): what the tour, the guide's cards
 * and its shortcuts light up, and where the light and its tooltip go. Every place marks the
 * exact element with `data-tour="<name>"` (never a wrapper around more than it says); a spot
 * lists the selectors it may land on, the first one on screen wins. Pure: the components
 * (components/guide) draw it.
 */

const at = (name: string) => `[data-tour="${name}"]`;

/** A place to light up: the first of these selectors found on screen. */
export type Targets = readonly string[];

export interface TourStep {
  id: 'hero' | 'priority' | 'risk' | 'automations' | 'integrations';
  /** The page it shows, after the dashboard's root (`''`: the dashboard). */
  page: string;
  targets: Targets;
  /** What the place is called: the words the page itself uses for it. */
  title: MessageKey;
  body: MessageKey;
}

/**
 * The tour: the amount saved → the action of the day → the first member's risk ring, on the
 * dashboard; then a rule of Automations and connecting Discord, on their own pages.
 */
export const TOUR: readonly TourStep[] = [
  { id: 'hero', page: '', targets: [at('hero-amount')], title: 'dash.saved', body: 'tour.hero' },
  {
    id: 'priority',
    page: '',
    targets: [at('priority-action')],
    title: 'dash.priority',
    body: 'tour.priority',
  },
  {
    id: 'risk',
    page: '',
    // The first member's ring; while « Needs attention » has nobody, the list itself.
    targets: [at('risk-ring'), at('attention')],
    title: 'tab.riskScore',
    body: 'tour.risk',
  },
  {
    id: 'automations',
    page: 'actions',
    targets: [at('rule-payment-retry')],
    title: 'nav.actions',
    body: 'tour.automations',
  },
  {
    id: 'integrations',
    page: 'sources/discord',
    // The button that connects Discord; without the bot configured, the platforms' tabs.
    targets: [at('connect-discord'), at('tabs')],
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
  /** The tour step that shows the same place: its words go in the light, else the caption. */
  step?: TourStep['id'];
}

/** The guide's five cards, in the validated words (§11). */
export const GUIDE_CARDS: readonly GuideCard[] = [
  {
    id: 'who',
    title: 'guide.who.title',
    body: 'guide.who.body',
    page: '',
    targets: [at('attention-row'), at('attention')],
  },
  {
    id: 'keep',
    title: 'guide.keep.title',
    body: 'guide.keep.body',
    page: 'actions',
    targets: [at('rule-payment-retry')],
    step: 'automations',
  },
  {
    id: 'money',
    title: 'guide.money.title',
    body: 'guide.money.body',
    page: '',
    targets: [at('hero-amount')],
    step: 'hero',
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
    page: 'sources/discord',
    targets: [at('connect-discord'), at('tabs')],
    step: 'integrations',
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

/** Around the lit element: the cut-out's room (8 px), its corners rounded 12 px. */
export const CUT_PAD = 8;
export const CUT_RADIUS = 12;
/** From the cut-out to the tooltip: the arrow (6 px tall) and a little air. */
export const TIP_GAP = 14;
/** The tooltip keeps this far from the window's edges. */
export const TIP_MARGIN = 16;
/** The arrow never sits in the tooltip's rounded corners. */
const ARROW_INSET = 18;

/** The cut-out around an element's box: the element whole, with room around it. */
export function cutOut(element: Box, pad = CUT_PAD): Box {
  return {
    x: element.x - pad,
    y: element.y - pad,
    width: element.width + pad * 2,
    height: element.height + pad * 2,
  };
}

/** Whether `inner` lies wholly within `outer` (half a pixel of rounding allowed). */
export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

/** Whether two boxes share any area. */
export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export type Side = 'right' | 'bottom' | 'left' | 'top';

/** The order the tooltip's side is chosen in (right > bottom > left > top). */
export const SIDES: readonly Side[] = ['right', 'bottom', 'left', 'top'];

export interface TipPlace {
  x: number;
  y: number;
  /** The side of the cut-out it stands on; `center` when nothing is lit. */
  side: Side | 'center';
  /** Where the arrow meets the tooltip's edge: from its top (left, right) or left (top, bottom). */
  arrow: number;
}

/** Where the tooltip would stand on one side of the cut-out, kept inside the window. */
function onSide(side: Side, cut: Box, tip: Size, view: Size): TipPlace {
  const clampX = (x: number) =>
    Math.max(TIP_MARGIN, Math.min(x, view.width - TIP_MARGIN - tip.width));
  const clampY = (y: number) =>
    Math.max(TIP_MARGIN, Math.min(y, view.height - TIP_MARGIN - tip.height));
  const arrowAlong = (centre: number, start: number, length: number) =>
    Math.max(ARROW_INSET, Math.min(centre - start, length - ARROW_INSET));
  if (side === 'right' || side === 'left') {
    const x = side === 'right' ? cut.x + cut.width + TIP_GAP : cut.x - TIP_GAP - tip.width;
    const y = clampY(cut.y + cut.height / 2 - tip.height / 2);
    return { x, y, side, arrow: arrowAlong(cut.y + cut.height / 2, y, tip.height) };
  }
  const y = side === 'bottom' ? cut.y + cut.height + TIP_GAP : cut.y - TIP_GAP - tip.height;
  const x = clampX(cut.x + cut.width / 2 - tip.width / 2);
  return { x, y, side, arrow: arrowAlong(cut.x + cut.width / 2, x, tip.width) };
}

/**
 * Where the tooltip goes (fix prompt v4.1, block 1): on the first side, in the order right,
 * bottom, left, top, where it stands wholly in the window without touching the cut-out or what
 * is lit next (`avoid`). A place in the side menu (`menuEdge`: the menu's right edge) always has
 * it to the right of the menu. When no side fits, the side with the most room, kept in the
 * window; with nothing lit, the middle of the window.
 */
export function placeTip(
  cut: Box | null,
  tip: Size,
  view: Size,
  { avoid = [], menuEdge = null }: { avoid?: readonly Box[]; menuEdge?: number | null } = {},
): TipPlace {
  if (!cut) {
    return {
      x: Math.max(TIP_MARGIN, (view.width - tip.width) / 2),
      y: Math.max(TIP_MARGIN, (view.height - tip.height) / 2),
      side: 'center',
      arrow: 0,
    };
  }
  if (menuEdge !== null) {
    // Its arrow still points at the item; the tooltip clears the whole menu.
    const beside = onSide('right', cut, tip, view);
    return { ...beside, x: Math.max(beside.x, menuEdge + TIP_GAP) };
  }
  const fits = (place: TipPlace) => {
    const box = { x: place.x, y: place.y, width: tip.width, height: tip.height };
    return (
      box.x >= TIP_MARGIN - 0.5 &&
      box.y >= TIP_MARGIN - 0.5 &&
      box.x + box.width <= view.width - TIP_MARGIN + 0.5 &&
      box.y + box.height <= view.height - TIP_MARGIN + 0.5 &&
      !intersects(box, cut) &&
      avoid.every((other) => !intersects(box, other))
    );
  };
  for (const side of SIDES) {
    const place = onSide(side, cut, tip, view);
    if (fits(place)) return place;
  }
  // Nothing fits: the side with the most room, the tooltip kept in the window.
  const room: Record<Side, number> = {
    right: view.width - (cut.x + cut.width),
    bottom: view.height - (cut.y + cut.height),
    left: cut.x,
    top: cut.y,
  };
  const side = [...SIDES].sort((a, b) => room[b] - room[a])[0]!;
  const place = onSide(side, cut, tip, view);
  return {
    ...place,
    x: Math.max(TIP_MARGIN, Math.min(place.x, view.width - TIP_MARGIN - tip.width)),
    y: Math.max(TIP_MARGIN, Math.min(place.y, view.height - TIP_MARGIN - tip.height)),
  };
}

/** The first of the selectors that names something on screen (a hidden element has no size). */
export function findTarget(targets: Targets, root: ParentNode = document): HTMLElement | null {
  for (const selector of targets) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) return element;
    }
  }
  return null;
}
