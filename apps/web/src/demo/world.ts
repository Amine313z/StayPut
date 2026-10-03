import {
  DEFAULT_OFFERS,
  choosePriority,
  type ActionSettingsView,
  type CreatorOfferKind,
  type CreatorOfferMade,
  type CreatorSession,
  type DashboardView,
  type FeedItem,
  type GettingStarted,
  type IntegrationsStatus,
  type MemberRow,
  type MembersPage,
  type RevenueDay,
  type RiskDay,
  type RiskLevel,
  type RiskReason,
  type SyncStatus,
} from '@stayput/core';
import { DEMO_COMPANY_ID } from '../api';
import { createDemoPages, localDay, type DemoPages } from './pages';

/**
 * The demo community (/demo): an imaginary trading community of 36 members (39 with those who
 * left, the brief asks for 25 to 40), with what a real
 * one has after a few months of StayPut: members drifting away, cancellations scheduled, failed
 * payments, money saved, a feed that moves. Every figure is computed from the members below the
 * way the Worker computes the real ones, so the screens tell one consistent story. Dates are
 * counted back from the moment the demo opens; the random parts are seeded, so every visit
 * shows the same community (and screenshots match).
 */

const COMMUNITY = 'Atlas Trading Club';
const CURRENCY = 'USD';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What a member pays: per month, per month for VIPs, or once a year. */
const PLANS = {
  monthly: { price: 49, days: 30 },
  vip: { price: 149, days: 30 },
  annual: { price: 470, days: 365 },
} as const;
type Plan = keyof typeof PLANS;

/** A member of the demo, before dates are counted from the moment it opens. */
interface Person {
  name: string;
  /** Null: on the free plan. */
  plan: Plan | null;
  level: RiskLevel | null;
  score: number;
  /** Days since they joined (a fraction for today's newcomers). */
  joined: number;
  /** Days since their last activity; null: never active. */
  active: number | null;
  reasons: (now: number) => RiskReason[];
  /** Leaves in that many days (a cancellation scheduled). */
  leaves?: number;
  /** Their last payment failed, and why. */
  failed?: string;
  /** Left the community that many days ago. */
  left?: number;
}

const cancel =
  (inDays: number) =>
  (now: number): RiskReason => ({
    code: 'cancel_scheduled',
    date: new Date(now + inDays * DAY).toISOString(),
  });
const inactive = (days: number) => (): RiskReason => ({ code: 'inactive', days });
const never = (days: number) => (): RiskReason => ({ code: 'never_active', days });
const drop = (percent: number) => (): RiskReason => ({ code: 'activity_drop', percent });
const quiet = (percent: number) => (): RiskReason => ({ code: 'reactions_drop', percent });
const stalled =
  (days: number, lesson: string | null = null) =>
  (): RiskReason => ({ code: 'no_progress', days, lesson });
const ticket = (days: number) => (): RiskReason => ({ code: 'ticket_open', days });
const paymentFailed = () => (): RiskReason => ({ code: 'payment_failed' });

const reasons =
  (...parts: ((now: number) => RiskReason)[]) =>
  (now: number) =>
    parts.map((part) => part(now));

const person = (
  name: string,
  plan: Plan | null,
  level: RiskLevel | null,
  score: number,
  joined: number,
  active: number | null,
  why: (now: number) => RiskReason[] = () => [],
  extra: Partial<Person> = {},
): Person => ({ name, plan, level, score, joined, active, reasons: why, ...extra });

/** The most at risk first, as the Worker sends them. */
const PEOPLE: readonly Person[] = [
  person('Hugo Bernard', 'vip', 'scheduled_departure', 100, 214, 9, reasons(cancel(6), drop(100)), {
    leaves: 6,
  }),
  person(
    'Margaux Picard',
    'monthly',
    'scheduled_departure',
    100,
    98,
    12,
    reasons(cancel(11), inactive(12)),
    {
      leaves: 11,
    },
  ),
  person(
    'Kevin Nguyen',
    'annual',
    'scheduled_departure',
    100,
    143,
    6,
    reasons(cancel(17), stalled(20, 'Module 5 · Backtesting')),
    { leaves: 17 },
  ),
  person('Sarah Cohen', 'vip', 'high', 88, 187, 8, reasons(paymentFailed(), drop(64)), {
    failed: 'Card declined',
  }),
  person(
    'Yanis Benali',
    'monthly',
    'high',
    84,
    121,
    19,
    reasons(inactive(19), stalled(23, 'Module 3 · Risk management')),
  ),
  person('Maxime Vidal', 'vip', 'high', 81, 166, 24, reasons(paymentFailed(), inactive(24)), {
    failed: 'Card expired',
  }),
  person('Elena Novak', 'monthly', 'high', 79, 76, 15, reasons(paymentFailed(), inactive(15)), {
    failed: 'Insufficient funds',
  }),
  person('Théo Fontaine', 'monthly', 'high', 74, 59, 4, reasons(drop(82), quiet(100))),
  person(
    'Omar Fassi',
    'monthly',
    'high',
    71,
    132,
    11,
    reasons(stalled(31, 'Module 2 · Reading the order book'), drop(71)),
  ),
  person('Lou Marchand', 'monthly', 'medium', 62, 88, 6, reasons(drop(55), quiet(60))),
  person('Rose Gauthier', 'monthly', 'medium', 58, 205, 5, reasons(ticket(4), drop(41))),
  person('Victor Leclerc', 'annual', 'medium', 55, 251, 7, reasons(stalled(14), drop(38))),
  person('Nora Chabane', 'monthly', 'medium', 53, 47, 5, reasons(drop(47), quiet(50))),
  person('Juliette Caron', 'vip', 'medium', 49, 178, 6, reasons(quiet(75), drop(35))),
  person('Tom Barbier', 'monthly', 'medium', 45, 154, 9, reasons(inactive(9), quiet(58))),
  person('Laura Weber', 'monthly', 'medium', 43, 71, 4, reasons(drop(39), quiet(52))),
  person('Ethan Brooks', 'monthly', 'medium', 41, 5, null, reasons(never(5), stalled(5))),
  person('Maya Fernandes', 'monthly', 'low', 28, 4, null, reasons(never(4), stalled(4))),
  person('Paul Henry', null, 'low', 16, 29, 2),
  person('Emma Rousseau', 'monthly', 'low', 14, 175, 1, reasons(quiet(25))),
  person('Clara Faure', 'monthly', 'low', 12, 91, 0),
  person('Sofia Ricci', 'monthly', 'low', 12, 36, 1),
  person('Nathan Girard', 'monthly', 'low', 11, 160, 2),
  person('Arthur Lemoine', 'monthly', 'low', 11, 48, 1),
  person('Anaïs Robin', 'vip', 'low', 10, 56, 1),
  person('Pauline Giraud', 'monthly', 'low', 10, 0.4, 0),
  person('Lucas Petit', 'annual', 'low', 9, 290, 1),
  person('Inès Haddad', 'monthly', 'low', 7, 233, 0),
  person('Gabriel Roux', 'vip', 'low', 7, 101, 1),
  person('Léa Moreau', 'monthly', 'low', 6, 267, 0),
  person('Jade Mercier', 'monthly', 'low', 6, 138, 0),
  person('Karim Belkacem', 'monthly', 'low', 6, 52, 0),
  person('Mehdi Amrani', 'monthly', 'low', 5, 198, 0),
  person('Zoé Lambert', 'monthly', 'low', 5, 109, 0),
  person('Camille Laurent', 'vip', 'low', 4, 302, 0),
  // Joined 26 minutes ago: not scored yet (the scores run every hour).
  person('Jonas Keller', 'monthly', null, 0, 0.018, null),
  person('Benoît Lacroix', 'monthly', null, 0, 160, 31, undefined, { left: 12 }),
  person('Sabrina Aït', 'monthly', null, 0, 77, 40, undefined, { left: 21 }),
  person('Lucie Moulin', 'monthly', null, 0, 120, 52, undefined, { left: 40 }),
];

/**
 * What StayPut saved, member by member (the Worker's `stayput.saves`): a payment recovered after
 * a retry, a member back from a pause, a cancellation taken back, each at the price of the
 * member's plan. The three most recent are the feed's. Within 30 days never the same member
 * twice (« 7 members saved » are seven plans paid), and none between 29 and 30 days ago, so that
 * count does not change with the hour the demo opens. Far enough back to fill the chart's first
 * month whatever the date.
 */
const SAVES: readonly { name: string; ago: number }[] = [
  { name: 'Clara Faure', ago: 41 * MINUTE },
  { name: 'Anaïs Robin', ago: 26 * HOUR },
  { name: 'Arthur Lemoine', ago: 41 * HOUR },
  { name: 'Sofia Ricci', ago: 6 * DAY + 7 * HOUR },
  { name: 'Camille Laurent', ago: 11 * DAY + 3 * HOUR },
  { name: 'Jade Mercier', ago: 18 * DAY + 9 * HOUR },
  { name: 'Inès Haddad', ago: 23 * DAY + 5 * HOUR },
  { name: 'Juliette Caron', ago: 31 * DAY + 4 * HOUR },
  { name: 'Karim Belkacem', ago: 34 * DAY + 6 * HOUR },
  { name: 'Mehdi Amrani', ago: 45 * DAY + 3 * HOUR },
  // The year's plan, once.
  { name: 'Lucas Petit', ago: 52 * DAY + 5 * HOUR },
  { name: 'Rose Gauthier', ago: 58 * DAY + 9 * HOUR },
  { name: 'Emma Rousseau', ago: 64 * DAY + 2 * HOUR },
  { name: 'Gabriel Roux', ago: 70 * DAY + 6 * HOUR },
  { name: 'Léa Moreau', ago: 77 * DAY + 4 * HOUR },
  { name: 'Nathan Girard', ago: 85 * DAY + 7 * HOUR },
  { name: 'Tom Barbier', ago: 93 * DAY + 3 * HOUR },
  { name: 'Inès Haddad', ago: 101 * DAY + 5 * HOUR },
  { name: 'Camille Laurent', ago: 108 * DAY + 2 * HOUR },
  { name: 'Jade Mercier', ago: 116 * DAY + 8 * HOUR },
];

/** How long ago StayPut last saved that member, when it was less than `within` ago. */
function savedWithin(name: string, within: number): number | undefined {
  const agos = SAVES.filter((save) => save.name === name && save.ago < within).map((s) => s.ago);
  return agos.length > 0 ? Math.min(...agos) : undefined;
}

/** The price of a member's plan: what StayPut saved when it saved them. */
function planPrice(name: string): number {
  const plan = PEOPLE.find((p) => p.name === name)?.plan;
  if (!plan) throw new Error(`${name}: no plan to save`);
  return PLANS[plan].price;
}

/** Seeded random numbers (mulberry32): the same community at every visit. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Range = [number, number];

const ACTIVITY_RANGES: Record<RiskLevel, readonly [Range, Range, Range, Range]> = {
  // messages, reactions, posts, lessons over 30 days
  low: [
    [8, 52],
    [5, 34],
    [0, 5],
    [1, 8],
  ],
  medium: [
    [2, 14],
    [1, 9],
    [0, 2],
    [0, 3],
  ],
  high: [
    [0, 2],
    [0, 2],
    [0, 0],
    [0, 1],
  ],
  scheduled_departure: [
    [0, 3],
    [0, 2],
    [0, 0],
    [0, 0],
  ],
};

/** A member's monthly price: a year counts for a twelfth (members.ts, monthlyPrice). */
function monthly(plan: Plan | null): number {
  if (!plan) return 0;
  const { price, days } = PLANS[plan];
  return days >= 365 ? price / 12 : (price * 30) / days;
}

function memberId(index: number): string {
  return `mber_demo${String(index + 1).padStart(2, '0')}`;
}

export interface DemoWorld {
  session: CreatorSession;
  /** Automations, Analytics, Integrations › Activity, Settings › Risk score (pages.ts). */
  pages: DemoPages;
  members: MembersPage;
  /** What StayPut saved, payment by payment (the Worker's `stayput.saves`), the latest first. */
  saves: readonly { memberId: string; at: string; amount: number }[];
  dashboard: () => DashboardView;
  feed: () => { items: FeedItem[] };
  /**
   * What members did while the demo is open, up to `current`: the feed's new lines, counted on
   * Discord, Telegram and Members alike. Every answer of the demo runs it first.
   */
  advance: (current: number) => void;
  sync: SyncStatus;
  integrations: IntegrationsStatus;
  settings: ActionSettingsView;
  /** « Message » on the dashboard: queued for the members not on the never-contact list. */
  message: (memberIds: readonly string[]) => number;
  /** « Retry now »: the failed payments StayPut may retry, charged again (simulated here). */
  retry: () => number;
  /** « Getting started »: a step done (the members reviewed, the guardrails saved). */
  started: (step: 'reviewed' | 'guardrails') => void;
  /** The action settings saved (Settings › Automations). */
  saveSettings: (next: ActionSettingsView) => ActionSettingsView;
  /** « Turn off » on the test-mode banner: the test mode only, the limits untouched. */
  testModeOff: () => ActionSettingsView;
  /** « Pause » or « Offer »: refused when one is open, when the member cannot be contacted. */
  offer: (memberId: string, kind: CreatorOfferKind) => CreatorOfferMade | { error: string };
  setContact: (memberId: string, doNotContact: boolean) => boolean | null;
  /** A Discord server or a Telegram group taken off (Integrations). */
  disconnect: (platform: 'discord' | 'telegram', id: string) => void;
  syncNow: () => void;
}

/** The demo community as of `now`. */
export function createWorld(now: number): DemoWorld {
  const random = seeded(20_261_002);
  const between = ([low, high]: Range) => low + Math.floor(random() * (high - low + 1));
  const at = (ago: number) => new Date(now - ago).toISOString();
  const scoredAt = at(38 * MINUTE);

  const rows: MemberRow[] = PEOPLE.map((p, index) => {
    const plan = p.plan ? PLANS[p.plan] : null;
    const ranges = p.level ? ACTIVITY_RANGES[p.level] : null;
    const count = (kind: 0 | 1 | 2 | 3) =>
      ranges && p.active !== null ? between(ranges[kind]) : 0;
    const activity = {
      messages: count(0),
      reactions: count(1),
      posts: count(2),
      lessons: count(3),
    };
    // Renews on the day of the month (or of the year) they joined, unless StayPut saved a
    // payment of theirs within the period: that payment started it, and is their last one.
    const saved = plan ? savedWithin(p.name, plan.days * DAY) : undefined;
    const sinceRenewal = plan ? (saved === undefined ? p.joined % plan.days : saved / DAY) : 0;
    const renewal = plan ? now + (plan.days - sinceRenewal) * DAY : null;
    const leftAt = p.left === undefined ? null : now - p.left * DAY;
    const lastActive = p.active === null ? null : at(p.active * DAY + between([1, 600]) * MINUTE);
    return {
      id: memberId(index),
      name: p.name,
      status: leftAt === null ? 'joined' : 'left',
      accessLevel: leftAt === null ? 'customer' : 'no_access',
      joinedAt: at(p.joined * DAY),
      lastActionAt: lastActive,
      lastActivityAt: lastActive,
      doNotContact: false,
      activity,
      risk:
        p.level && leftAt === null
          ? {
              score: p.score,
              level: p.level,
              reasons: p.reasons(now),
              inactiveNewcomer: p.active === null && p.joined >= 3 && p.joined <= 7,
              computedAt: scoredAt,
            }
          : null,
      membership: plan
        ? {
            status: leftAt !== null ? 'canceled' : p.failed ? 'past_due' : 'active',
            price: plan.price,
            currency: 'usd',
            billingPeriodDays: plan.days,
            cancelAtPeriodEnd: p.leaves !== undefined,
            currentPeriodEnd: new Date(
              leftAt ?? (p.leaves === undefined ? renewal! : now + p.leaves * DAY),
            ).toISOString(),
          }
        : null,
      lastPayment: plan
        ? {
            status: p.failed ? 'failed' : 'succeeded',
            amount: plan.price,
            currency: 'usd',
            at: p.failed
              ? at(between([2, 30]) * HOUR)
              : new Date(
                  (leftAt ?? now) - (saved ?? Math.max(sinceRenewal, 0.5) * DAY),
                ).toISOString(),
            failureReason: p.failed ?? null,
          }
        : null,
    };
  });

  const joined = rows.filter((m) => m.status === 'joined');
  const levelCount = (level: RiskLevel) => joined.filter((m) => m.risk?.level === level).length;
  const price = (m: MemberRow) => monthly(PEOPLE[rows.indexOf(m)]!.plan);
  const paying = joined.filter((m) => m.membership && price(m) > 0);
  const atRiskMembers = joined.filter(
    (m) => m.risk?.level === 'high' || m.risk?.level === 'scheduled_departure',
  );
  const round = (value: number) => Math.round(value * 100) / 100;
  const revenue = round(paying.reduce((total, m) => total + price(m), 0));
  const atRiskRevenue = round(atRiskMembers.reduce((total, m) => total + price(m), 0));
  const activity30d = joined.reduce(
    (total, m) =>
      total + m.activity.messages + m.activity.reactions + m.activity.posts + m.activity.lessons,
    0,
  );

  const members: MembersPage = {
    summary: {
      members: joined.length,
      liveMemberships: joined.filter((m) => m.membership).length,
      scheduledCancellations: joined.filter((m) => m.membership?.cancelAtPeriodEnd).length,
      failedPayments: joined.filter((m) => m.lastPayment?.status === 'failed').length,
      activity30d,
      revenue: {
        currency: CURRENCY,
        monthly: revenue,
        atRisk: atRiskRevenue,
        otherCurrencies: false,
      },
      risk: {
        high: levelCount('high'),
        medium: levelCount('medium'),
        low: levelCount('low'),
        scheduledDeparture: levelCount('scheduled_departure'),
        inactiveNewcomers: joined.filter((m) => m.risk?.inactiveNewcomer).length,
        computedAt: scoredAt,
      },
    },
    members: rows,
    truncated: false,
  };

  // Of the members here 30 days ago, those still here.
  const base = rows.filter((_, i) => {
    const p = PEOPLE[i]!;
    return p.joined >= 30 && (p.left === undefined || p.left <= 30);
  });
  const kept = base.filter((m) => m.status === 'joined').length;

  const riskHistory: RiskDay[] = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(now - (29 - i) * DAY);
    const last = i === 29;
    const departures = last ? levelCount('scheduled_departure') : 2 + Math.round(random() * 2);
    const atRisk = last
      ? atRiskMembers.length
      : Math.round(13.5 - (4 * i) / 29 + (random() - 0.5) * 2);
    const medium = last ? levelCount('medium') : 7 + Math.round(random() * 2);
    const total = last
      ? atRiskMembers.length + levelCount('medium') + levelCount('low')
      : 30 + Math.floor(i / 5);
    return {
      day: localDay(day),
      departure: departures,
      high: Math.max(0, atRisk - departures),
      medium,
      low: Math.max(0, total - atRisk - medium),
    };
  });

  // The money StayPut saved, payment by payment: each member's plan, once.
  const savesMade = SAVES.map((save) => ({ ...save, amount: planPrice(save.name) }));
  const monthOf = (moment: Date) => moment.getFullYear() * 12 + moment.getMonth();
  const thisMonth = monthOf(new Date(now));
  const savedIn = (month: number) =>
    savesMade
      .filter((save) => monthOf(new Date(now - save.ago)) === month)
      .reduce((total, save) => total + save.amount, 0);
  const savesThisMonth = savesMade.filter(
    (save) => monthOf(new Date(now - save.ago)) === thisMonth,
  ).length;
  const savedByDay = new Map<string, number>();
  for (const save of savesMade) {
    const day = localDay(new Date(now - save.ago));
    savedByDay.set(day, (savedByDay.get(day) ?? 0) + save.amount);
  }
  // The chart's days, as the Worker sends them: from the 1st of the month 89 days ago up to
  // today, so that each month's balance adds up from its 1st.
  const today = localDay(new Date(now));
  const historyDays: string[] = [];
  const start = new Date(now - 89 * DAY);
  for (
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12);
    localDay(cursor) <= today;
    cursor.setDate(cursor.getDate() + 1)
  ) {
    historyDays.push(localDay(cursor));
  }
  // What the members at risk paid each month: today, the figure of the hero row; before, a member
  // crossing into high risk or out of it a few times a week, at their plan's price, so the total
  // moves by steps; higher three months ago, before StayPut was at work. Counted back from today,
  // each step toward that slope when the total has drifted from it.
  const lastDay = historyDays.length - 1;
  const atRiskByDay: number[] = [];
  atRiskByDay[lastDay] = atRiskRevenue;
  for (let i = lastDay - 1; i >= 0; i--) {
    const trend = 1_180 - ((1_180 - atRiskRevenue) * i) / lastDay;
    let value = atRiskByDay[i + 1]!;
    if (random() < 0.3) {
      const gap = trend - value;
      const price = Math.abs(gap) > 100 && random() < 0.4 ? monthly('vip') : monthly('monthly');
      const up = Math.abs(gap) > price / 2 ? gap > 0 : random() < 0.5;
      value += up ? price : -price;
    }
    atRiskByDay[i] = round(Math.max(atRiskRevenue * 0.8, value));
  }
  const revenueHistory: RevenueDay[] = historyDays.map((day, i) => ({
    day,
    saved: savedByDay.get(day) ?? 0,
    atRisk: atRiskByDay[i]!,
  }));
  // The members saved in the chart's last 30 days, each once: their plans are its 30-day total.
  const last30 = new Set(revenueHistory.slice(-30).map((entry) => entry.day));
  const savedMembers30d = new Set(
    savesMade
      .filter((save) => last30.has(localDay(new Date(now - save.ago))))
      .map((save) => save.name),
  ).size;
  const gettingStarted: GettingStarted = {
    discord: true,
    automation: true,
    reviewed: false,
    guardrails: false,
  };

  const DISCORD_GUILD = '1187420000000000001';
  const TELEGRAM_CHAT = '-1002187400001';
  const TELEGRAM_TITLE = 'Atlas · Signals';
  const pages = createDemoPages({
    now,
    community: COMMUNITY,
    rows,
    monthly: price,
    guildId: DISCORD_GUILD,
    chatId: TELEGRAM_CHAT,
    telegramTitle: TELEGRAM_TITLE,
  });

  const byName = (name: string) => rows.find((m) => m.name === name)!;
  let feedSeq = 0;
  const item = (
    ago: number,
    by: FeedItem['by'],
    event: FeedItem['event'],
    name: string,
    extra: Partial<FeedItem> = {},
  ): FeedItem => ({
    id: `demo-${++feedSeq}`,
    at: at(ago),
    by,
    event,
    memberId: byName(name).id,
    memberName: name,
    ...extra,
  });
  const usd = (amount: number) => ({ amount, currency: CURRENCY });
  const feed: FeedItem[] = [
    item(4 * MINUTE, 'member', 'activity', 'Camille Laurent', {
      source: 'discord',
      activity: 'message',
    }),
    item(12 * MINUTE, 'stayput', 'message_sent', 'Lou Marchand'),
    item(26 * MINUTE, 'member', 'joined', 'Jonas Keller'),
    item(41 * MINUTE, 'stayput', 'saved', 'Clara Faure', usd(49)),
    item(43 * MINUTE, 'member', 'payment_succeeded', 'Clara Faure', usd(49)),
    item(95 * MINUTE, 'member', 'payment_failed', 'Sarah Cohen', usd(149)),
    item(2 * HOUR, 'stayput', 'payment_retry', 'Elena Novak'),
    item(3 * HOUR, 'member', 'activity', 'Léa Moreau', { source: 'whop', activity: 'lesson' }),
    item(4 * HOUR, 'member', 'cancellation_scheduled', 'Margaux Picard'),
    item(5 * HOUR, 'stayput', 'offer_applied', 'Juliette Caron'),
    item(6 * HOUR, 'member', 'activity', 'Mehdi Amrani', {
      source: 'telegram',
      activity: 'message',
    }),
    item(9 * HOUR, 'member', 'joined', 'Pauline Giraud'),
    item(11 * HOUR, 'stayput', 'message_sent', 'Rose Gauthier'),
    item(14 * HOUR, 'member', 'activity', 'Inès Haddad', { source: 'whop', activity: 'post' }),
    item(18 * HOUR, 'member', 'payment_succeeded', 'Gabriel Roux', usd(149)),
    item(22 * HOUR, 'member', 'activity', 'Zoé Lambert', { source: 'whop', activity: 'result' }),
    item(26 * HOUR, 'stayput', 'saved', 'Anaïs Robin', usd(149)),
    item(29 * HOUR, 'member', 'cancellation_scheduled', 'Kevin Nguyen'),
    item(31 * HOUR, 'stayput', 'message_sent', 'Victor Leclerc'),
    item(38 * HOUR, 'member', 'activity', 'Nathan Girard', {
      source: 'discord',
      activity: 'message',
    }),
    item(41 * HOUR, 'stayput', 'saved', 'Arthur Lemoine', usd(49)),
    item(44 * HOUR, 'member', 'payment_succeeded', 'Léa Moreau', usd(49)),
  ];
  // A message the feed tells is on the platform its author is on, and is their last one there.
  for (const entry of feed) {
    if (entry.activity !== 'message' || !entry.memberId) continue;
    if (entry.source !== 'discord' && entry.source !== 'telegram') continue;
    entry.source =
      pages.noteMessage(entry.memberId, Date.parse(entry.at), entry.source) ?? entry.source;
  }

  // What members do while someone looks at the demo: one new line now and then, counted where it
  // happened, so that the feed, Integrations and Members tell it alike: a message on Discord or
  // Telegram (the one the member is on), a lesson, a post or a result on Whop.
  const LIVE: readonly [
    string,
    NonNullable<FeedItem['activity']>,
    'discord' | 'telegram' | 'whop',
  ][] = [
    ['Emma Rousseau', 'message', 'discord'],
    ['Lucas Petit', 'lesson', 'whop'],
    ['Arthur Lemoine', 'message', 'telegram'],
    ['Gabriel Roux', 'post', 'whop'],
    ['Sofia Ricci', 'message', 'discord'],
    ['Karim Belkacem', 'result', 'whop'],
  ];
  let live = 0;
  let nextLive = now + 20_000;
  /** Everything members did up to `current`, at the moment they did it. */
  const advance = (current: number) => {
    while (nextLive <= current) {
      const moment = nextLive;
      const [name, activity, place] = LIVE[live % LIVE.length]!;
      live += 1;
      const member = byName(name);
      let source: NonNullable<FeedItem['source']> = place;
      if (activity === 'message') {
        source =
          (place === 'whop' ? null : pages.recordMessage(member.id, moment, place)) ?? 'whop';
        member.activity.messages += 1;
      } else if (activity === 'lesson') member.activity.lessons += 1;
      else if (activity === 'post') member.activity.posts += 1;
      if (activity !== 'result') members.summary.activity30d += 1;
      member.lastActivityAt = member.lastActionAt = new Date(moment).toISOString();
      feed.unshift({
        ...item(0, 'member', 'activity', name, { source, activity }),
        at: new Date(moment).toISOString(),
      });
      feed.splice(24);
      nextLive = moment + 25_000 + Math.floor(random() * 20_000);
    }
  };

  const reached = new Map<string, number>();
  const offers = new Map<string, CreatorOfferKind>();
  /** The failed payments being retried now: nothing more to do about them but wait. */
  const retried = new Set<string>();
  const memberOf = (id: string) => joined.find((m) => m.id === id);
  const failedNow = () => joined.filter((m) => m.lastPayment?.status === 'failed');
  const leavingNow = () => joined.filter((m) => m.membership?.cancelAtPeriodEnd);
  const sum = (values: readonly number[]) => round(values.reduce((t, v) => t + v, 0));

  const settings: ActionSettingsView = {
    mode: 'manual',
    locale: 'en',
    dryRun: false,
    killSwitch: false,
    timezone: 'Europe/Paris',
    quietHoursStart: 22,
    quietHoursEnd: 8,
    defaultSendHour: 19,
    maxMessagesPer5Days: 1,
    maxMessagesPerMonth: 4,
    maxPaymentRetries: 2,
    monthlyPromoCap: 10,
    maxFreeDaysPerQuarter: 14,
    templates: {},
    offers: DEFAULT_OFFERS,
  };

  const sync: SyncStatus = {
    backfillDone: true,
    lastSyncAt: at(4 * MINUTE),
    streams: [
      'plans',
      'members',
      'memberships',
      'payments',
      'chat_channels',
      'forums',
      'courses',
    ].map((stream) => ({
      stream,
      backfillDone: true,
      inProgress: false,
      lastPassAt: at(4 * MINUTE),
      error: null,
    })),
  };

  const integrations: IntegrationsStatus = {
    whopAppId: null,
    discord: {
      available: true,
      install: null,
      servers: [
        {
          guildId: DISCORD_GUILD,
          name: COMMUNITY,
          connectedAt: at(46 * DAY),
          channels: ['general', 'trade-ideas', 'wins', 'questions'].map((_, i) => ({
            id: `11874200000000001${i}0`,
            backfillDone: true,
            lastReadAt: at((3 + i) * MINUTE),
            error: null,
          })),
        },
      ],
      linkedMembers: 28,
      unlinkedAuthors: 2,
    },
    telegram: {
      available: true,
      addToGroup: null,
      readsAllMessages: true,
      groups: [
        {
          chatId: TELEGRAM_CHAT,
          title: TELEGRAM_TITLE,
          connectedAt: at(38 * DAY),
          active: true,
          lastMessageAt: at(6 * MINUTE),
        },
      ],
      linkedMembers: 19,
      unlinkedAuthors: 2,
    },
  };

  return {
    session: {
      companyId: DEMO_COMPANY_ID,
      userId: 'user_demo',
      accessLevel: 'admin',
      via: 'iframe',
      timezoneSet: true,
      companyName: COMMUNITY,
      companyLogo: false,
      testMode: false,
    },
    members,
    saves: savesMade.map((save) => ({
      memberId: byName(save.name).id,
      at: at(save.ago),
      amount: save.amount,
    })),
    sync,
    integrations,
    settings,
    pages,
    dashboard: () => {
      const current = Date.now();
      // Members at high risk no message reached (or will) within 5 days, as the Worker counts.
      const planned = pages.reached();
      const unreached = joined
        .filter(
          (m) =>
            m.risk?.level === 'high' &&
            !m.doNotContact &&
            !planned.has(m.id) &&
            current - (reached.get(m.id) ?? -Infinity) > 5 * DAY,
        )
        .map((m) => ({ memberId: m.id, monthly: price(m) }))
        .sort((a, b) => b.monthly - a.monthly);
      return {
        currency: CURRENCY,
        saved: {
          // And two renewals after a message (influenced), counted apart.
          thisMonth: { direct: savedIn(thisMonth), influenced: 98, saves: savesThisMonth + 2 },
          lastMonth: { direct: savedIn(thisMonth - 1) },
          otherCurrencies: false,
        },
        monthlyRevenue: revenue,
        atRisk: {
          revenue: atRiskRevenue,
          members: atRiskMembers.length,
          departures: levelCount('scheduled_departure'),
          high: levelCount('high'),
        },
        retention30: { rate: base.length ? kept / base.length : null, kept, base: base.length },
        members: {
          total: joined.length,
          newLast7Days: PEOPLE.filter((p) => p.left === undefined && p.joined < 7).length,
        },
        memberActivity30d: members.summary.activity30d,
        stayputActions30d: {
          total: 43,
          messages: 31,
          paymentRetries: 7,
          offers: 5,
          pauses: 6,
          saved: savedMembers30d,
        },
        mode: settings.mode,
        testMode: settings.dryRun,
        riskHistory,
        revenueHistory,
        gettingStarted: { ...gettingStarted },
        priority: choosePriority({
          mode: settings.mode,
          pending: pages.pending(),
          retryable: (() => {
            const due = failedNow().filter((m) => !m.doNotContact && !retried.has(m.id));
            return {
              payments: due.length,
              revenue: sum(due.map((m) => m.lastPayment!.amount)),
            };
          })(),
          leaving: leavingNow()
            .filter((m) => !m.doNotContact && !offers.has(m.id) && price(m) > 0)
            .map((m) => ({ memberId: m.id, monthly: price(m) }))
            .sort((a, b) => b.monthly - a.monthly),
          unreached,
          unresolved: {
            failed: {
              members: failedNow().length,
              revenue: sum(failedNow().map((m) => m.lastPayment!.amount)),
            },
            leaving: {
              members: leavingNow().length,
              revenue: sum(leavingNow().map(price)),
            },
          },
        }),
      };
    },
    advance,
    feed: () => {
      advance(Date.now());
      return { items: feed };
    },
    message: (memberIds) => {
      let queued = 0;
      for (const id of memberIds) {
        const member = memberOf(id);
        if (!member || member.doNotContact) continue;
        reached.set(id, Date.now());
        queued += 1;
      }
      return queued;
    },
    retry: () => {
      const due = failedNow().filter((m) => !m.doNotContact && !retried.has(m.id));
      for (const member of due) retried.add(member.id);
      return due.length;
    },
    offer: (id, kind) => {
      const member = memberOf(id);
      if (!member) return { error: 'not_a_member' };
      if (member.doNotContact) return { error: 'do_not_contact' };
      if (!member.membership || price(member) === 0) return { error: 'no_membership' };
      if (offers.has(id)) return { error: 'offer_open' };
      offers.set(id, kind);
      reached.set(id, Date.now());
      return {
        offerId: `demo-offer-${offers.size}`,
        kind,
        terms:
          kind === 'pause_offer'
            ? { days: settings.offers.pauseDays }
            : { percentOff: settings.offers.promoPercent, months: settings.offers.promoMonths },
      };
    },
    started: (step) => {
      gettingStarted[step] = true;
    },
    saveSettings: (next) => {
      Object.assign(settings, next);
      gettingStarted.guardrails = true;
      return settings;
    },
    testModeOff: () => {
      settings.dryRun = false;
      return settings;
    },
    setContact: (id, doNotContact) => {
      const member = memberOf(id);
      if (!member) return null;
      member.doNotContact = doNotContact;
      return doNotContact;
    },
    disconnect: (platform, id) => {
      if (platform === 'discord') {
        integrations.discord.servers = integrations.discord.servers.filter((s) => s.guildId !== id);
      } else {
        integrations.telegram.groups = integrations.telegram.groups.map((g) =>
          g.chatId === id ? { ...g, active: false } : g,
        );
      }
    },
    syncNow: () => {
      const moment = new Date().toISOString();
      sync.lastSyncAt = moment;
      for (const stream of sync.streams) stream.lastPassAt = moment;
    },
  };
}
