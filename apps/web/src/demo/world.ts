import {
  DEFAULT_OFFERS,
  choosePriority,
  type ActionSettingsView,
  type CreatorOfferKind,
  type CreatorOfferMade,
  type CreatorSession,
  type DashboardView,
  type FeedItem,
  type IntegrationsStatus,
  type MemberRow,
  type MembersPage,
  type RiskDay,
  type RiskLevel,
  type RiskReason,
  type SyncStatus,
} from '@stayput/core';
import { DEMO_COMPANY_ID } from '../api';

/**
 * The demo community (/demo): an imaginary trading community of 56 members, with what a real
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
    'monthly',
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
  person('Maxime Vidal', 'monthly', 'high', 81, 166, 24, reasons(inactive(24), ticket(6))),
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
  person('Adam Chevalier', 'monthly', 'medium', 51, 112, 8, reasons(inactive(8), drop(36))),
  person('Juliette Caron', 'vip', 'medium', 49, 178, 6, reasons(quiet(75), drop(35))),
  person(
    'Bastien Colin',
    'monthly',
    'medium',
    47,
    64,
    7,
    reasons(stalled(16, 'Module 4 · Position sizing'), drop(33)),
  ),
  person('Yasmine Kaci', 'monthly', 'medium', 46, 39, 5, reasons(drop(44), ticket(3))),
  person('Tom Barbier', 'monthly', 'medium', 45, 154, 9, reasons(inactive(9), quiet(58))),
  person('Laura Weber', 'monthly', 'medium', 43, 71, 4, reasons(drop(39), quiet(52))),
  person('Ethan Brooks', 'monthly', 'medium', 41, 5, null, reasons(never(5), stalled(5))),
  person('Maya Fernandes', 'monthly', 'low', 28, 4, null, reasons(never(4), stalled(4))),
  person('Malik Traoré', 'monthly', 'low', 24, 33, 3, reasons(drop(24))),
  person('Alice Perrin', 'monthly', 'low', 22, 80, 3, reasons(drop(26))),
  person('Eva Rey', 'monthly', 'low', 20, 44, 2, reasons(quiet(28))),
  person('Manon Dupuis', 'monthly', 'low', 19, 127, 2, reasons(drop(22))),
  person('Lina Bouaziz', 'monthly', 'low', 18, 6, 1),
  person('Louis Garnier', 'monthly', 'low', 17, 95, 2, reasons(quiet(30))),
  person('Paul Henry', null, 'low', 16, 29, 2),
  person('Noah Blanc', 'monthly', 'low', 15, 84, 1),
  person('David Okafor', 'monthly', 'low', 15, 14, 2),
  person('Emma Rousseau', 'monthly', 'low', 14, 175, 1, reasons(quiet(25))),
  person('Enzo Morel', 'monthly', 'low', 13, 61, 2),
  person('Clara Faure', 'monthly', 'low', 12, 91, 0),
  person('Sofia Ricci', 'monthly', 'low', 12, 36, 1),
  person('Mila André', 'monthly', 'low', 12, 18, 1),
  person('Nathan Girard', 'monthly', 'low', 11, 160, 2),
  person('Arthur Lemoine', 'monthly', 'low', 11, 48, 1),
  person('Rayan Mansouri', 'monthly', 'low', 10, 117, 1),
  person('Anaïs Robin', 'vip', 'low', 10, 56, 1),
  person('Pauline Giraud', 'monthly', 'low', 10, 0.4, 0),
  person('Lucas Petit', 'annual', 'low', 9, 290, 1),
  person('Samuel Diallo', 'monthly', 'low', 9, 73, 1),
  person('Antoine Brun', 'monthly', 'low', 9, 26, 1),
  person('Chloé Lefèvre', 'monthly', 'low', 8, 149, 1),
  person('Julia Martins', 'monthly', 'low', 8, 67, 0),
  person('Amira Hamdi', 'monthly', 'low', 8, 22, 0),
  person('Inès Haddad', 'monthly', 'low', 7, 233, 0),
  person('Gabriel Roux', 'vip', 'low', 7, 101, 1),
  person('Ilyes Saidi', 'monthly', 'low', 7, 41, 0),
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
  members: MembersPage;
  dashboard: () => DashboardView;
  feed: () => { items: FeedItem[] };
  sync: SyncStatus;
  integrations: IntegrationsStatus;
  settings: ActionSettingsView;
  /** « Message » on the dashboard: queued for the members not on the never-contact list. */
  message: (memberIds: readonly string[]) => number;
  /** « Pause » or « Offer »: refused when one is open, when the member cannot be contacted. */
  offer: (memberId: string, kind: CreatorOfferKind) => CreatorOfferMade | { error: string };
  setContact: (memberId: string, doNotContact: boolean) => boolean | null;
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
    // Renews on the day of the month (or of the year) they joined.
    const sinceRenewal = plan ? p.joined % plan.days : 0;
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
              : new Date((leftAt ?? now) - Math.max(sinceRenewal, 0.5) * DAY).toISOString(),
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
    const medium = last ? levelCount('medium') : 11 + Math.round(random() * 3);
    const total = last
      ? atRiskMembers.length + levelCount('medium') + levelCount('low')
      : 49 + Math.floor(i / 5);
    return {
      day: localDay(day),
      departure: departures,
      high: Math.max(0, atRisk - departures),
      medium,
      low: Math.max(0, total - atRisk - medium),
    };
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
    item(8 * HOUR, 'stayput', 'saved', 'Noah Blanc', usd(49)),
    item(9 * HOUR, 'member', 'joined', 'Pauline Giraud'),
    item(11 * HOUR, 'stayput', 'message_sent', 'Rose Gauthier'),
    item(14 * HOUR, 'member', 'activity', 'Inès Haddad', { source: 'whop', activity: 'post' }),
    item(18 * HOUR, 'member', 'payment_succeeded', 'Gabriel Roux', usd(149)),
    item(22 * HOUR, 'member', 'activity', 'Zoé Lambert', { source: 'whop', activity: 'result' }),
    item(26 * HOUR, 'stayput', 'saved', 'Anaïs Robin', usd(149)),
    item(29 * HOUR, 'member', 'cancellation_scheduled', 'Kevin Nguyen'),
    item(31 * HOUR, 'stayput', 'message_sent', 'Victor Leclerc'),
    item(34 * HOUR, 'stayput', 'saved', 'Julia Martins', usd(49)),
    item(38 * HOUR, 'member', 'activity', 'Nathan Girard', {
      source: 'discord',
      activity: 'message',
    }),
    item(41 * HOUR, 'stayput', 'saved', 'Arthur Lemoine', usd(49)),
    item(44 * HOUR, 'member', 'payment_succeeded', 'Léa Moreau', usd(49)),
  ];

  // What members do while someone looks at the demo: one new line now and then.
  const LIVE: readonly [string, Partial<FeedItem>][] = [
    ['Emma Rousseau', { source: 'discord', activity: 'message' }],
    ['Lucas Petit', { source: 'whop', activity: 'lesson' }],
    ['Jade Mercier', { source: 'telegram', activity: 'message' }],
    ['Gabriel Roux', { source: 'whop', activity: 'post' }],
    ['Sofia Ricci', { source: 'discord', activity: 'message' }],
    ['Karim Belkacem', { source: 'whop', activity: 'result' }],
  ];
  let live = 0;
  let nextLive = now + 20_000;

  const reached = new Map<string, number>();
  const offers = new Map<string, CreatorOfferKind>();
  const memberOf = (id: string) => joined.find((m) => m.id === id);

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
          guildId: '1187420000000000001',
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
      linkedMembers: 41,
      unlinkedAuthors: 3,
    },
    telegram: {
      available: true,
      addToGroup: null,
      readsAllMessages: true,
      groups: [
        {
          chatId: '-1002187400001',
          title: 'Atlas · Signals',
          connectedAt: at(38 * DAY),
          active: true,
          lastMessageAt: at(6 * MINUTE),
        },
      ],
      linkedMembers: 27,
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
    },
    members,
    sync,
    integrations,
    settings,
    dashboard: () => {
      const current = Date.now();
      const unreached = joined
        .filter(
          (m) =>
            m.risk?.level === 'high' &&
            !m.doNotContact &&
            current - (reached.get(m.id) ?? -Infinity) > 5 * DAY,
        )
        .map((m) => ({ memberId: m.id, monthly: price(m) }))
        .sort((a, b) => b.monthly - a.monthly);
      return {
        currency: CURRENCY,
        saved: {
          thisMonth: { direct: 345, influenced: 98, saves: 7 },
          lastMonth: { direct: 245 },
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
        memberActivity30d: activity30d,
        stayputActions30d: { total: 52, messages: 38, paymentRetries: 9, offers: 5 },
        mode: settings.mode,
        testMode: settings.dryRun,
        riskHistory,
        priority: choosePriority({
          mode: settings.mode,
          pending: { actions: 0, members: 0, revenue: 0 },
          unreached,
        }),
      };
    },
    feed: () => {
      const current = Date.now();
      if (current >= nextLive) {
        const [name, extra] = LIVE[live % LIVE.length]!;
        live += 1;
        feed.unshift({
          ...item(0, 'member', 'activity', name, extra),
          at: new Date(current).toISOString(),
        });
        feed.splice(24);
        nextLive = current + 25_000 + Math.floor(random() * 20_000);
      }
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
    setContact: (id, doNotContact) => {
      const member = memberOf(id);
      if (!member) return null;
      member.doNotContact = doNotContact;
      return doNotContact;
    },
    syncNow: () => {
      const moment = new Date().toISOString();
      sync.lastSyncAt = moment;
      for (const stream of sync.streams) stream.lastPassAt = moment;
    },
  };
}

/** The calendar day of a moment where the demo is opened: `YYYY-MM-DD`. */
function localDay(moment: Date): string {
  const month = String(moment.getMonth() + 1).padStart(2, '0');
  const day = String(moment.getDate()).padStart(2, '0');
  return `${moment.getFullYear()}-${month}-${day}`;
}
