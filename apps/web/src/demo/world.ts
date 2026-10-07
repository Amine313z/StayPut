import {
  DEFAULT_HIGH_FROM,
  DEFAULT_OFFERS,
  DEFAULT_SAVE_RATE,
  DEFAULT_STAY,
  MEMBER_PAYMENTS_LIMIT,
  WEEKLY_REPORT_HOUR,
  addDays,
  choosePriority,
  nextReportAt,
  reportedWeek,
  scoreWithSignals,
  signalReasons,
  type ActionSettingsView,
  type CreatorOfferKind,
  type CreatorOfferMade,
  type CreatorSession,
  type DashboardView,
  type DataExport,
  type ExitReason,
  type FeedItem,
  type GettingStarted,
  type InsightsOverview,
  type IntegrationsStatus,
  type MemberDetail,
  type MemberDetailPayment,
  type MemberPlatformActivity,
  type MemberRow,
  type MembersPage,
  type PlatformSignals,
  type PriorityAction,
  type RevenueDay,
  type RiskDay,
  type RiskLevel,
  type RiskReason,
  type RuleId,
  type SentWeeklyReport,
  type SyncStatus,
  type TeamView,
  type WeeklyReportsView,
  monthStart,
  zonedDay,
  zonedMoment,
} from '@stayput/core';
import { DEMO_COMPANY_ID, DEMO_WHOP_ID } from '../api';
import { fold } from '../text';
import { createDemoPages, type DemoPages } from './pages';
import { seeded } from './random';

/** The reasons computeRisk always names first: a departure scheduled, a payment failed. */
const FACTS: ReadonlySet<string> = new Set(['cancel_scheduled', 'payment_failed']);

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
/** How many days back the chart may reach: from the 1st of the month 89 days ago, 120 at most. */
const HISTORY_REACH = 124;

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
  /**
   * Days since they joined (a fraction for today's newcomers). Their plan renews on that day of
   * each period: a payment then, the next renewal one period later (fix prompt v4.1, block 4).
   */
  joined: number;
  /** Days since their last activity; null: never active. */
  active: number | null;
  reasons: (dates: ReasonDates) => RiskReason[];
  /** A cancellation scheduled: they leave at the end of the period they paid. */
  cancels?: boolean;
  /** Their latest renewal failed, and why (nothing came in since). */
  failed?: string;
  /** Left the community that many days ago, at the end of the last period they paid. */
  left?: number;
  /** StayPut paused them that many hours ago, at their renewal, for that many days. */
  paused?: { hoursAgo: number; days: number };
  /** Last active exactly that many hours ago: a message brought them back. */
  seenHoursAgo?: number;
}

/** What a member's reasons are dated from: now, and the end of the period they paid. */
interface ReasonDates {
  now: number;
  end: number | null;
}

const cancel =
  () =>
  (dates: ReasonDates): RiskReason => ({
    code: 'cancel_scheduled',
    date: new Date(dates.end ?? dates.now).toISOString(),
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
  (...parts: ((dates: ReasonDates) => RiskReason)[]) =>
  (dates: ReasonDates) =>
    parts.map((part) => part(dates));

const person = (
  name: string,
  plan: Plan | null,
  level: RiskLevel | null,
  score: number,
  joined: number,
  active: number | null,
  why: (dates: ReasonDates) => RiskReason[] = () => [],
  extra: Partial<Person> = {},
): Person => ({ name, plan, level, score, joined, active, reasons: why, ...extra });

const H = 1 / 24;

/**
 * The most at risk first, as the Worker sends them. Each date follows from the day they joined
 * and their plan (fix prompt v4.1, block 4): Hugo paid on the 29th, so he leaves a month later;
 * Kevin's year runs to the day he paid it; a renewal that failed failed on its day.
 */
const PEOPLE: readonly Person[] = [
  person('Hugo Bernard', 'vip', 'scheduled_departure', 100, 214, 9, reasons(cancel(), drop(100)), {
    cancels: true,
  }),
  // Her month ends this week: the most urgent departure.
  person(
    'Margaux Picard',
    'monthly',
    'scheduled_departure',
    100,
    115,
    12,
    reasons(cancel(), inactive(12)),
    { cancels: true },
  ),
  person(
    'Kevin Nguyen',
    'annual',
    'scheduled_departure',
    100,
    143,
    6,
    reasons(cancel(), stalled(20, 'Module 5 · Backtesting')),
    { cancels: true },
  ),
  // Her renewal failed 95 minutes ago.
  person(
    'Sarah Cohen',
    'vip',
    'high',
    88,
    180 + 95 / 1_440,
    8,
    reasons(paymentFailed(), drop(64)),
    {
      failed: 'Card declined',
    },
  ),
  person(
    'Yanis Benali',
    'monthly',
    'high',
    84,
    121,
    19,
    reasons(inactive(19), stalled(23, 'Module 3 · Risk management')),
  ),
  person('Maxime Vidal', 'vip', 'high', 81, 152.1, 24, reasons(paymentFailed(), inactive(24)), {
    failed: 'Card expired',
  }),
  // Three days ago; StayPut's retry failed again two hours ago.
  person('Elena Novak', 'monthly', 'high', 79, 63, 15, reasons(paymentFailed(), inactive(15)), {
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
  // High two days ago; StayPut's message brought him back.
  person('Victor Leclerc', 'annual', 'medium', 55, 251, 1, reasons(stalled(14), drop(38)), {
    seenHoursAgo: 20,
  }),
  person('Nora Chabane', 'monthly', 'medium', 53, 47, 5, reasons(drop(47), quiet(50))),
  // Paused at her renewal, five hours ago, for 30 days.
  person('Juliette Caron', 'vip', 'medium', 49, 150 + 5 * H, 6, reasons(quiet(75), drop(35)), {
    paused: { hoursAgo: 5, days: 30 },
  }),
  person('Tom Barbier', 'monthly', 'medium', 45, 154, 9, reasons(inactive(9), quiet(58))),
  person('Laura Weber', 'monthly', 'medium', 43, 71, 4, reasons(drop(39), quiet(52))),
  person('Ethan Brooks', 'monthly', 'medium', 41, 5, null, reasons(never(5), stalled(5))),
  person('Maya Fernandes', 'monthly', 'low', 28, 4, null, reasons(never(4), stalled(4))),
  person('Emma Rousseau', 'monthly', 'low', 14, 175, 1, reasons(quiet(25))),
  // Her renewal failed two days ago; StayPut's retry got it paid.
  person('Clara Faure', 'monthly', 'low', 12, 92, 0),
  person('Sofia Ricci', 'monthly', 'low', 12, 36.5, 1),
  person('Nathan Girard', 'monthly', 'low', 11, 160, 2),
  person('Arthur Lemoine', 'monthly', 'low', 11, 62, 1),
  person('Anaïs Robin', 'vip', 'low', 10, 56, 1),
  // Joined this morning; StayPut's welcome brought her in two hours ago.
  person('Pauline Giraud', 'monthly', 'low', 10, 0.4, 0, undefined, { seenHoursAgo: 2 }),
  person('Lucas Petit', 'annual', 'low', 9, 290, 1),
  person('Inès Haddad', 'monthly', 'low', 7, 233, 0),
  // Renewed 18 hours ago.
  person('Gabriel Roux', 'vip', 'low', 7, 90.75, 1),
  // Renewed 44 hours ago.
  person('Léa Moreau', 'monthly', 'low', 6, 241 + 20 * H, 0),
  person('Jade Mercier', 'monthly', 'low', 6, 138.5, 0),
  person('Karim Belkacem', 'monthly', 'low', 6, 52, 0),
  person('Mehdi Amrani', 'monthly', 'low', 5, 198, 0),
  person('Zoé Lambert', 'monthly', 'low', 5, 109, 0),
  person('Camille Laurent', 'vip', 'low', 4, 302, 0),
  // Joined 26 minutes ago: not scored yet (the scores run every hour).
  person('Jonas Keller', 'monthly', null, 0, 0.018, null),
  // Those who left, at the end of the last month they paid.
  person('Benoît Lacroix', 'monthly', null, 0, 162, 31, undefined, { left: 12 }),
  person('Sabrina Aït', 'monthly', null, 0, 81, 40, undefined, { left: 21 }),
  person('Lucie Moulin', 'monthly', null, 0, 130, 52, undefined, { left: 40 }),
  // Never a member without a membership scored among the others: he left (block 4, rule 8).
  person('Paul Henry', 'monthly', null, 0, 69, 10, undefined, { left: 9 }),
];

/** How StayPut saved a member: what it did, before the money came in. */
type SaveVia = 'retry' | 'notice' | 'pause' | 'extend';

/**
 * What StayPut saved, member by member (the Worker's `stayput.saves`), and how: a failed payment
 * retried or a member who updated their card after the notice, a member back from a 30-day pause,
 * a cancellation taken back after free days, each at the price of the member's plan. Each one is
 * an action of the History that says « Recovered » (fix prompt v4.1, block 4). The three most
 * recent are the feed's. Within 30 days never the same member twice (« 7 members saved » are
 * seven plans paid), and none between 29 and 30 days ago, so that count does not change with the
 * hour the demo opens. Far enough back to fill the chart's first month whatever the date.
 */
const SAVES: readonly { name: string; ago: number; via: SaveVia }[] = [
  { name: 'Clara Faure', ago: 43 * MINUTE, via: 'retry' },
  { name: 'Anaïs Robin', ago: 26 * HOUR, via: 'extend' },
  { name: 'Arthur Lemoine', ago: 41 * HOUR, via: 'retry' },
  { name: 'Sofia Ricci', ago: 6 * DAY + 7 * HOUR, via: 'notice' },
  { name: 'Camille Laurent', ago: 11 * DAY + 3 * HOUR, via: 'pause' },
  { name: 'Jade Mercier', ago: 18 * DAY + 9 * HOUR, via: 'retry' },
  { name: 'Inès Haddad', ago: 23 * DAY + 5 * HOUR, via: 'pause' },
  { name: 'Gabriel Roux', ago: 31 * DAY + 4 * HOUR, via: 'notice' },
  { name: 'Karim Belkacem', ago: 34 * DAY + 6 * HOUR, via: 'retry' },
  { name: 'Mehdi Amrani', ago: 45 * DAY + 3 * HOUR, via: 'retry' },
  // The year's plan, once.
  { name: 'Lucas Petit', ago: 52 * DAY + 5 * HOUR, via: 'notice' },
  { name: 'Rose Gauthier', ago: 58 * DAY + 9 * HOUR, via: 'retry' },
  { name: 'Emma Rousseau', ago: 64 * DAY + 2 * HOUR, via: 'pause' },
  { name: 'Gabriel Roux', ago: 70 * DAY + 6 * HOUR, via: 'retry' },
  { name: 'Léa Moreau', ago: 77 * DAY + 4 * HOUR, via: 'notice' },
  { name: 'Nathan Girard', ago: 85 * DAY + 7 * HOUR, via: 'retry' },
  { name: 'Tom Barbier', ago: 93 * DAY + 3 * HOUR, via: 'pause' },
  { name: 'Inès Haddad', ago: 101 * DAY + 5 * HOUR, via: 'retry' },
  { name: 'Camille Laurent', ago: 108 * DAY + 2 * HOUR, via: 'notice' },
  { name: 'Jade Mercier', ago: 116 * DAY + 8 * HOUR, via: 'retry' },
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

/** A Whop username as members pick theirs: their name, lowercase, in one of a few shapes. */
function usernameOf(name: string, index: number): string {
  const [first = '', last = ''] = fold(name)
    .replace(/[^a-z ]/g, '')
    .split(' ');
  const shapes = [`${first}.${last}`, `${first}${last}`, `${first}_${last}`, `${first[0]}${last}`];
  return shapes[index % shapes.length]!;
}

function memberId(index: number): string {
  return `mber_demo${String(index + 1).padStart(2, '0')}`;
}

/**
 * A member's plan in dates (fix prompt v4.1, block 4), all from the day they joined: their plan
 * renews on that day of each period. `paidAt`: the latest payment that came in; `end`: when the
 * membership renews, or ends for a member leaving, one period after it; for a renewal that
 * failed, the day it was due (`failedAt`, unpaid since); after StayPut's pause, the day it ends;
 * for a member gone, the end of the last period they paid. A payment StayPut saved within the
 * period is the latest one, and starts it.
 */
function billingOf(
  p: Person,
  period: number,
  now: number,
): { paidAt: number; failedAt: number | null; end: number; pausedUntil: number | null } {
  if (p.left !== undefined) {
    const leftAt = now - p.left * DAY;
    return { paidAt: leftAt - period, failedAt: null, end: leftAt, pausedUntil: null };
  }
  // Their latest renewal day: now, or before.
  const renewal = now - ((p.joined * DAY) % period);
  const saved = savedWithin(p.name, period);
  if (saved !== undefined) {
    return { paidAt: now - saved, failedAt: null, end: now - saved + period, pausedUntil: null };
  }
  if (p.failed)
    return { paidAt: renewal - period, failedAt: renewal, end: renewal, pausedUntil: null };
  if (p.paused) {
    const until = now - p.paused.hoursAgo * HOUR + p.paused.days * DAY;
    return { paidAt: renewal - period, failedAt: null, end: until, pausedUntil: until };
  }
  return { paidAt: renewal, failedAt: null, end: renewal + period, pausedUntil: null };
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
  /** « Automatic or manual? » in the welcome: the mode only. */
  setMode: (mode: ActionSettingsView['mode']) => ActionSettingsView;
  /** A rule of Automations › Rules turned on or off, as the Worker's `set_rule` (0032). */
  setRule: (rule: RuleId, on: boolean) => ActionSettingsView;
  /** « Pause » or « Offer »: refused when one is open, when the member cannot be contacted. */
  offer: (memberId: string, kind: CreatorOfferKind) => CreatorOfferMade | { error: string };
  setContact: (memberId: string, doNotContact: boolean) => boolean | null;
  /** A Discord server or a Telegram group taken off (Integrations). */
  disconnect: (platform: 'discord' | 'telegram', id: string) => void;
  syncNow: () => void;
  /** A member's drawer (Members): null for no member of the demo. */
  memberDetail: (memberId: string) => MemberDetail | null;
  /** Analytics › Overview: the forecast's figures, the departure survey's reasons, 30 days. */
  overview: () => InsightsOverview;
  /**
   * A platform's signals saved (Integrations › Discord and › Telegram): the members' scores
   * follow, as the Worker's next scoring would make them.
   */
  saveSignals: (
    platform: 'discord' | 'telegram',
    signals: PlatformSignals,
  ) => Record<'discord' | 'telegram', PlatformSignals>;
  /** Analytics › Reports: the Monday reports of the last 6 weeks, from the demo's own story. */
  reports: () => WeeklyReportsView;
  /** Settings › General: the Whop team, and who opened StayPut. */
  team: () => TeamView;
  /** « Export my data »: the demo's own, as the Worker would give it (its members, its team). */
  exportData: () => DataExport;
  /** The Monday report turned on or off. */
  setReports: (enabled: boolean) => WeeklyReportsView;
}

/**
 * The demo community as of `now`, in `zone`'s calendar: the visitor's own time zone, as a
 * community StayPut opens in a creator's browser starts with (Settings › Automations › Time
 * zone), so every date the demo shows falls on the same day.
 */
export function createWorld(now: number, zone = 'Europe/Paris'): DemoWorld {
  // The demo's clock: `now` when the world is made, then the real time passing (the live feed,
  // what the visitor approves). Never the real date itself: everything here is dated from
  // `now`, and the same `now` gives the same demo whatever the day (a test's fixed date drifted
  // past the 5-day windows on 2026-10-07).
  const startedAt = Date.now();
  const clock = () => now + (Date.now() - startedAt);
  const random = seeded(20_261_002);
  const between = ([low, high]: Range) => low + Math.floor(random() * (high - low + 1));
  const at = (ago: number) => new Date(now - ago).toISOString();
  const scoredAt = at(38 * MINUTE);

  const rows: MemberRow[] = PEOPLE.map((p, index) => {
    const plan = p.plan ? PLANS[p.plan] : null;
    const ranges = p.level ? ACTIVITY_RANGES[p.level] : null;
    // A member here for less than 30 days did that much less: a newcomer of this morning has
    // done a thing or two, not a month's worth (one story, fix prompt v4.1 block 7). The draws
    // stay the same, so every other member keeps their figures.
    const tenure = Math.min(1, p.joined / 30);
    const count = (kind: 0 | 1 | 2 | 3) =>
      ranges && p.active !== null ? Math.round(between(ranges[kind]) * tenure) : 0;
    const activity = {
      messages: count(0),
      reactions: count(1),
      posts: count(2),
      lessons: count(3),
    };
    // Active within the 30 days: at least the one thing they did.
    if (p.active !== null && p.active < 30 && ranges) {
      if (activity.messages + activity.reactions + activity.posts + activity.lessons === 0) {
        activity.messages = 1;
      }
    }
    const billing = plan ? billingOf(p, plan.days * DAY, now) : null;
    const leftAt = p.left === undefined ? null : now - p.left * DAY;
    const minutes = p.active === null ? 0 : between([1, 600]);
    const lastActive =
      p.active === null
        ? null
        : at(
            p.seenHoursAgo !== undefined
              ? p.seenHoursAgo * HOUR
              : p.active * DAY + minutes * MINUTE,
          );
    return {
      id: memberId(index),
      name: p.name,
      username: usernameOf(p.name, index),
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
              reasons: p.reasons({ now, end: billing?.end ?? null }),
              inactiveNewcomer: p.active === null && p.joined >= 3 && p.joined <= 7,
              computedAt: scoredAt,
            }
          : null,
      membership:
        plan && billing
          ? {
              status:
                leftAt !== null
                  ? 'canceled'
                  : p.failed
                    ? 'past_due'
                    : p.paused
                      ? 'paused'
                      : 'active',
              price: plan.price,
              currency: 'usd',
              billingPeriodDays: plan.days,
              cancelAtPeriodEnd: p.cancels === true,
              currentPeriodEnd: new Date(billing.end).toISOString(),
              pausedUntil:
                billing.pausedUntil === null ? null : new Date(billing.pausedUntil).toISOString(),
            }
          : null,
      lastPayment:
        plan && billing
          ? {
              status: p.failed ? 'failed' : 'succeeded',
              amount: plan.price,
              currency: 'usd',
              at: new Date(billing.failedAt ?? billing.paidAt).toISOString(),
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
      day: zonedDay(day.getTime(), zone),
      departure: departures,
      high: Math.max(0, atRisk - departures),
      medium,
      low: Math.max(0, total - atRisk - medium),
    };
  });

  // The money StayPut saved, payment by payment: each member's plan, once.
  const savesMade = SAVES.map((save) => ({ ...save, amount: planPrice(save.name) }));
  // What the members at risk paid each month, `k` days before today: today, the figure of the
  // hero row; before, a member crossing into high risk or out of it a few times a week, at their
  // plan's price, so the total moves by steps; higher three months ago, before StayPut was at
  // work. Counted back from today, each step toward that slope when the total has drifted from it.
  // Drawn once, far enough back for any chart: its days only depend on the time zone.
  const atRiskBack: number[] = [atRiskRevenue];
  for (let k = 1; k < HISTORY_REACH; k++) {
    const trend = atRiskRevenue + ((1_180 - atRiskRevenue) * k) / (HISTORY_REACH - 1);
    let value = atRiskBack[k - 1]!;
    if (random() < 0.3) {
      const gap = trend - value;
      const price = Math.abs(gap) > 100 && random() < 0.4 ? monthly('vip') : monthly('monthly');
      const up = Math.abs(gap) > price / 2 ? gap > 0 : random() < 0.5;
      value += up ? price : -price;
    }
    atRiskBack.push(round(Math.max(atRiskRevenue * 0.8, value)));
  }
  /**
   * The money saved in the community's calendar (Settings › Automations › Time zone), as the
   * Worker counts it: each save on its day there, the month beginning at midnight there; the
   * chart's days from the 1st of the month 89 days ago up to today.
   */
  const calendar = (zone: string) => {
    const dayOf = (save: { ago: number }) => zonedDay(now - save.ago, zone);
    const today = zonedDay(now, zone);
    const month = today.slice(0, 7);
    const lastMonth = addDays(monthStart(today), -1).slice(0, 7);
    const savedByDay = new Map<string, number>();
    for (const save of savesMade) {
      savedByDay.set(dayOf(save), (savedByDay.get(dayOf(save)) ?? 0) + save.amount);
    }
    const days: string[] = [];
    for (let day = monthStart(addDays(today, -89)); day <= today; day = addDays(day, 1)) {
      days.push(day);
    }
    const revenueHistory: RevenueDay[] = days.map((day, i) => ({
      day,
      saved: round(savedByDay.get(day) ?? 0),
      atRisk: atRiskBack[days.length - 1 - i]!,
    }));
    const savedIn = (key: string) =>
      round(
        savesMade
          .filter((save) => dayOf(save).startsWith(key))
          .reduce((total, save) => total + save.amount, 0),
      );
    // The members saved in the chart's last 30 days, each once: their plans are its 30-day total.
    const last30 = new Set(days.slice(-30));
    return {
      revenueHistory,
      thisMonth: savedIn(month),
      lastMonth: savedIn(lastMonth),
      savesThisMonth: savesMade.filter((save) => dayOf(save).startsWith(month)).length,
      savedMembers30d: new Set(
        savesMade.filter((save) => last30.has(dayOf(save))).map((save) => save.name),
      ).size,
    };
  };
  const gettingStarted: GettingStarted = {
    discord: true,
    automation: true,
    reviewed: false,
    guardrails: false,
  };

  const DISCORD_GUILD = '1187420000000000001';
  const TELEGRAM_CHAT = '-1002187400001';
  const TELEGRAM_TITLE = 'Atlas · Signals';
  // What members did, day by day over the community's last 30 days (Analytics › Overview): each
  // member's 30-day total spread over the days since they joined, up to the day they were last
  // active, which has at least one. The days add up to the Members page's totals. Its own seed:
  // the rest of the community draws the same numbers as before.
  const spread = seeded(20_261_004);
  const today = zonedDay(now, zone);
  const activityDays = Array.from({ length: 30 }, (_, i) => ({
    day: addDays(today, i - 29),
    actions: 0,
    members: new Set<string>(),
  }));
  const dayIndex = (time: number) => {
    const day = zonedDay(time, zone);
    return activityDays.findIndex((d) => d.day === day);
  };
  for (const m of joined) {
    const total =
      m.activity.messages + m.activity.reactions + m.activity.posts + m.activity.lessons;
    const last = m.lastActivityAt ? dayIndex(Date.parse(m.lastActivityAt)) : -1;
    if (total === 0 || last < 0) continue;
    const first = Math.min(last, Math.max(0, m.joinedAt ? dayIndex(Date.parse(m.joinedAt)) : 0));
    const weights = Array.from({ length: last - first + 1 }, () => 0.3 + spread());
    const sum = weights.reduce((a, b) => a + b, 0);
    const shares = weights.map((w) => ((total - 1) * w) / sum);
    const counts = shares.map(Math.floor);
    // The units the rounding left, to the days that lost the most to it.
    let left = total - 1 - counts.reduce((a, b) => a + b, 0);
    for (const i of shares
      .map((share, i) => ({ i, rest: share - Math.floor(share) }))
      .sort((a, b) => b.rest - a.rest)
      .map((d) => d.i)) {
      if (left <= 0) break;
      counts[i]! += 1;
      left -= 1;
    }
    counts[counts.length - 1]! += 1;
    counts.forEach((count, i) => {
      if (count === 0) return;
      const day = activityDays[first + i]!;
      day.actions += count;
      day.members.add(m.id);
    });
  }

  const pages = createDemoPages({
    now,
    clock,
    community: COMMUNITY,
    rows,
    monthly: price,
    saves: SAVES.map((save) => ({
      memberId: rows[PEOPLE.findIndex((p) => p.name === save.name)]!.id,
      at: now - save.ago,
      amount: planPrice(save.name),
      via: save.via,
    })),
    guildId: DISCORD_GUILD,
    chatId: TELEGRAM_CHAT,
    telegramTitle: TELEGRAM_TITLE,
    zone,
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
    // StayPut's retry failed again: Elena's payment is still unpaid (History: « Still failing »).
    item(2 * HOUR - MINUTE, 'member', 'payment_failed', 'Elena Novak', usd(49)),
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

  /**
   * The platforms' signals saved (Integrations › Discord and › Telegram): each member's score
   * from its making, as the Worker's next scoring would give it, the reasons of the signals that
   * add points after the member's own, and the figures that count the levels. With no signal on,
   * every member is back to the score the demo made.
   */
  const madeRisk = new Map(rows.flatMap((m) => (m.risk ? [[m.id, { ...m.risk }] as const] : [])));
  const rescore = () => {
    const signals = pages.platforms.signals();
    const { mediumFrom, highFrom } = pages.riskSettings();
    for (const member of joined) {
      const made = madeRisk.get(member.id);
      const making = pages.platforms.making(member);
      if (!made || !making) continue;
      const score = scoreWithSignals(making, signals, highFrom);
      if (score === making.base) {
        member.risk = { ...made };
        continue;
      }
      const inactive = made.reasons.some((r) => r.code === 'inactive');
      const added = signalReasons(pages.platforms.figures(member.id), signals, now).filter(
        (r) => !(inactive && r.code === 'platform_silent'),
      );
      member.risk = {
        ...made,
        score,
        level:
          making.rule === 1
            ? 'scheduled_departure'
            : score >= highFrom
              ? 'high'
              : score >= mediumFrom
                ? 'medium'
                : 'low',
        // As computeRisk: a scheduled departure or a failed payment first; then, the demo's own
        // reasons carrying no weight, the signals just turned on before them, as they moved it.
        reasons: [
          ...made.reasons.filter((r) => FACTS.has(r.code)),
          ...added,
          ...made.reasons.filter((r) => !FACTS.has(r.code)),
        ].slice(0, 2),
      };
    }
    const atRiskNow = joined.filter(
      (m) => m.risk?.level === 'high' || m.risk?.level === 'scheduled_departure',
    );
    const atRisk = round(atRiskNow.reduce((total, m) => total + price(m), 0));
    Object.assign(members.summary.risk, {
      high: levelCount('high'),
      medium: levelCount('medium'),
      low: levelCount('low'),
      scheduledDeparture: levelCount('scheduled_departure'),
    });
    if (members.summary.revenue) members.summary.revenue.atRisk = atRisk;
    atRiskBack[0] = atRisk;
    const departures = levelCount('scheduled_departure');
    riskHistory[29] = {
      ...riskHistory[29]!,
      departure: departures,
      high: atRiskNow.length - departures,
      medium: levelCount('medium'),
      low: levelCount('low'),
    };
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
    timezone: zone,
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
    rulesOff: [],
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

  /**
   * A member's drawer, from the member as every page shows them: their score day by day since
   * they joined (rising to today's for those drifting away, steady for the others), the
   * membership of their row, a payment each period back to when they joined (the latest one their
   * row's), and what they did on Whop and on the Discord and Telegram accounts StayPut knows.
   */
  const memberDetail = (memberId: string): MemberDetail | null => {
    const index = rows.findIndex((m) => m.id === memberId);
    const row = rows[index];
    const p = PEOPLE[index];
    if (!row || !p) return null;
    const own = seeded(20_261_003 + index * 7_919);
    const tag = String(index + 1).padStart(2, '0');
    const risk = row.risk;
    const start = !risk
      ? 0
      : risk.level === 'scheduled_departure'
        ? 48 + own() * 14
        : risk.level === 'high'
          ? risk.score - 32 - own() * 10
          : risk.level === 'medium'
            ? risk.score - 14
            : risk.score + 4;
    // A « Score turned high » action came on a day the score was high (fix prompt v4.1, block
    // 4): high from that day on; for a member it brought back, high that day, then lower.
    const turnedHigh = pages.scoreTurnedHigh(memberId);
    const highDay = turnedHigh === null ? null : zonedDay(turnedHigh, zone);
    const days = Array.from({ length: 30 }, (_, i) => zonedDay(now - (29 - i) * DAY, zone));
    const peakAt = highDay === null ? -1 : days.indexOf(highDay);
    const PEAK = DEFAULT_HIGH_FROM + 4;
    const scores = risk
      ? days
          .map((day, i) => ({ day, i }))
          .filter(({ i }) => 29 - i < p.joined)
          .map(({ day, i }) => {
            const t = i / 29;
            const noise = (own() - 0.5) * 6;
            const curve = Math.max(
              0,
              Math.min(100, Math.round(start + (risk.score - start) * t * t + noise)),
            );
            let score = i === 29 ? risk.score : curve;
            if (peakAt >= 0 && i >= peakAt) {
              score =
                risk.score >= DEFAULT_HIGH_FROM
                  ? Math.max(score, DEFAULT_HIGH_FROM)
                  : // Brought back: from the peak down to today's, day by day.
                    Math.round(
                      PEAK + ((risk.score - PEAK) * (i - peakAt)) / Math.max(29 - peakAt, 1),
                    );
            } else if (peakAt >= 0 && risk.score < DEFAULT_HIGH_FROM) {
              // Rising to it.
              const u = i / Math.max(peakAt, 1);
              score = Math.max(
                0,
                Math.min(100, Math.round(start + (PEAK - start) * u * u + noise)),
              );
            }
            return { day, score };
          })
      : [];
    const plan = p.plan ? PLANS[p.plan] : null;
    const payments: MemberDetailPayment[] = [];
    if (plan && row.lastPayment) {
      const last = Date.parse(row.lastPayment.at);
      const first = row.joinedAt ? Date.parse(row.joinedAt) : last;
      payments.push({
        id: `pay_demo${tag}p0`,
        status: row.lastPayment.status,
        amount: plan.price,
        currency: 'usd',
        at: row.lastPayment.at,
        failureReason: row.lastPayment.failureReason,
      });
      // Paid each period before it; a payment StayPut saved is the one of its period.
      const saves = SAVES.filter((save) => save.name === p.name).map((save) => now - save.ago);
      const period = plan.days * DAY;
      const paidBefore = row.lastPayment.status === 'failed' ? last - period : last;
      if (paidBefore !== last) {
        payments.push({
          id: `pay_demo${tag}p1`,
          status: 'succeeded',
          amount: plan.price,
          currency: 'usd',
          at: new Date(paidBefore).toISOString(),
          failureReason: null,
        });
      }
      for (
        let moment = paidBefore - period;
        moment >= first - DAY && payments.length < MEMBER_PAYMENTS_LIMIT;
        moment -= period
      ) {
        const saved = saves.find((at) => Math.abs(at - moment) < period / 2);
        payments.push({
          id: `pay_demo${tag}p${payments.length}`,
          status: 'succeeded',
          amount: plan.price,
          currency: 'usd',
          at: new Date(saved ?? moment).toISOString(),
          failureReason: null,
        });
      }
    }
    const accounts = pages.memberPlatforms(memberId);
    const elsewhere = accounts.discord.messages + accounts.telegram.messages;
    const onWhop =
      Math.max(0, row.activity.messages - elsewhere) +
      row.activity.reactions +
      row.activity.posts +
      row.activity.lessons;
    const platforms: MemberPlatformActivity[] = [
      {
        platform: 'whop',
        events: onWhop,
        lastAt: onWhop > 0 ? row.lastActivityAt : null,
        linked: true,
      },
    ];
    for (const platform of ['discord', 'telegram'] as const) {
      const connected =
        platform === 'discord'
          ? integrations.discord.servers.length > 0
          : integrations.telegram.groups.length > 0;
      if (!connected) continue;
      const account = accounts[platform];
      platforms.push({
        platform,
        events: account.messages,
        lastAt: account.lastAt === null ? null : new Date(account.lastAt).toISOString(),
        linked: account.linked,
      });
    }
    return {
      memberId,
      scores,
      memberships: row.membership
        ? [
            {
              id: `mem_demo${tag}`,
              status: row.membership.status,
              price: row.membership.price,
              currency: row.membership.currency,
              billingPeriodDays: row.membership.billingPeriodDays,
              cancelAtPeriodEnd: row.membership.cancelAtPeriodEnd,
              currentPeriodEnd: row.membership.currentPeriodEnd,
              startedAt: row.joinedAt,
            },
          ]
        : [],
      payments,
      platforms,
    };
  };

  /**
   * The Monday reports (SPEC 6.9) as the Worker makes them, from the demo's own story: each week
   * in the community's calendar, its saves (each member once), the members who left, the departure
   * survey's answers. The week's priority is what StayPut did next (the following week's saves);
   * the last report's, the dashboard's. Each one sent on its Monday at 8:00.
   */
  // The community's Whop team: its owner, a moderator, and an assistant who never opened StayPut.
  const team: TeamView = {
    members: [
      {
        userId: 'user_demo',
        name: 'Alexandre Roy',
        username: 'alex.roy',
        openedAt: at(4 * MINUTE),
      },
      {
        userId: 'user_demoMod',
        name: 'Mélanie Dupuis',
        username: 'melanie.mod',
        openedAt: at(2 * DAY + 3 * HOUR),
      },
      { userId: 'user_demoHelp', name: 'Yusuf Kaya', username: 'yusuf.k', openedAt: null },
    ],
  };
  let reportsOn = true;
  const weeklyReports = (current: PriorityAction | null): WeeklyReportsView => {
    const zone = settings.timezone;
    const answers = pages.exitAnswers();
    const bounds = (start: string) => [
      zonedMoment(start, 0, 0, zone),
      zonedMoment(addDays(start, 7), 0, 0, zone),
    ];
    const savesOf = (start: string) => {
      const [from, to] = bounds(start) as [number, number];
      return savesMade.filter((save) => now - save.ago >= from && now - save.ago < to);
    };
    const priorityOf = (saves: typeof savesMade): PriorityAction | null => {
      const of = (vias: readonly SaveVia[]) => saves.filter((save) => vias.includes(save.via));
      const total = (list: typeof savesMade) => round(list.reduce((t, x) => t + x.amount, 0));
      const failed = of(['retry', 'notice']);
      if (failed.length > 0)
        return { kind: 'retry', payments: failed.length, revenue: total(failed) };
      const paused = of(['pause']);
      if (paused.length > 0) {
        return {
          kind: 'pause',
          memberIds: paused.map((save) => byName(save.name).id),
          revenue: total(paused),
        };
      }
      const kept = of(['extend']);
      return kept.length > 0
        ? { kind: 'review', filter: 'cancelling', members: kept.length, revenue: total(kept) }
        : null;
    };
    // The week that ended last Monday, once its report went (Monday 8:00 there).
    let latest = reportedWeek(now, zone).start;
    if (zonedMoment(addDays(latest, 7), WEEKLY_REPORT_HOUR, 0, zone) > now) {
      latest = addDays(latest, -7);
    }
    const reports: SentWeeklyReport[] = [];
    for (let k = 0; k < 6; k++) {
      const start = addDays(latest, -7 * k);
      const [from, to] = bounds(start) as [number, number];
      const saves = savesOf(start);
      const counts = new Map<ExitReason, number>();
      for (const answer of answers) {
        if (answer.at >= from && answer.at < to) {
          counts.set(answer.reason, (counts.get(answer.reason) ?? 0) + 1);
        }
      }
      reports.push({
        weekStart: start,
        currency: CURRENCY,
        saved: {
          members: new Set(saves.map((save) => save.name)).size,
          direct: round(saves.reduce((t, save) => t + save.amount, 0)),
          influenced: 0,
        },
        lost: PEOPLE.filter(
          (p) => p.left !== undefined && now - p.left * DAY >= from && now - p.left * DAY < to,
        ).length,
        reasons: [...counts.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
        priority: k === 0 ? current : priorityOf(savesOf(addDays(start, 7))),
        sentAt: new Date(
          zonedMoment(addDays(start, 7), WEEKLY_REPORT_HOUR, 0, zone) + 4_000,
        ).toISOString(),
        failed: false,
      });
    }
    return {
      enabled: reportsOn,
      nextAt: new Date(nextReportAt(now, zone)).toISOString(),
      timezone: zone,
      reports,
    };
  };

  const world: DemoWorld = {
    memberDetail,
    session: {
      companyId: DEMO_COMPANY_ID,
      userId: 'user_demo',
      accessLevel: 'admin',
      via: 'iframe',
      timezoneSet: true,
      companyName: COMMUNITY,
      companyLogo: false,
      testMode: false,
      operator: false,
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
      const current = clock();
      // The community's calendar as Settings › Automations says now.
      const days = calendar(settings.timezone);
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
          thisMonth: { direct: days.thisMonth, influenced: 98, saves: days.savesThisMonth + 2 },
          lastMonth: { direct: days.lastMonth },
          otherCurrencies: false,
        },
        monthlyRevenue: revenue,
        atRisk: {
          revenue: atRiskBack[0]!,
          members: levelCount('high') + levelCount('scheduled_departure'),
          departures: levelCount('scheduled_departure'),
          high: levelCount('high'),
        },
        retention30: { rate: base.length ? kept / base.length : null, kept, base: base.length },
        members: {
          total: joined.length,
          newLast7Days: PEOPLE.filter((p) => p.left === undefined && p.joined < 7).length,
        },
        memberActivity30d: members.summary.activity30d,
        // What StayPut did over 30 days: the History's own actions, as the Worker counts them.
        stayputActions30d: { ...pages.done30d(), saved: days.savedMembers30d },
        mode: settings.mode,
        testMode: settings.dryRun,
        riskHistory,
        revenueHistory: days.revenueHistory,
        gettingStarted: { ...gettingStarted },
        // The demo opens on its dashboard: its welcome only with `?welcome` (brief v4 §10).
        welcomed: true,
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
      advance(clock());
      return { items: feed };
    },
    message: (memberIds) => {
      let queued = 0;
      for (const id of memberIds) {
        const member = memberOf(id);
        if (!member || member.doNotContact) continue;
        reached.set(id, clock());
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
      reached.set(id, clock());
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
      // As the Worker: the rules change on Automations › Rules only.
      const { rulesOff: _rules, ...rest } = next;
      Object.assign(settings, rest);
      gettingStarted.guardrails = true;
      return settings;
    },
    testModeOff: () => {
      settings.dryRun = false;
      return settings;
    },
    setMode: (mode) => {
      settings.mode = mode;
      if (mode === 'auto') gettingStarted.automation = true;
      return settings;
    },
    setRule: (rule, on) => {
      const off = new Set(settings.rulesOff);
      if (on) off.delete(rule);
      else off.add(rule);
      settings.rulesOff = [...off].sort();
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
        // As the Worker does (disconnect_telegram_chat): the group goes, the bot leaves it.
        integrations.telegram.groups = integrations.telegram.groups.filter((g) => g.chatId !== id);
      }
    },
    syncNow: () => {
      const moment = new Date(clock()).toISOString();
      sync.lastSyncAt = moment;
      for (const stream of sync.streams) stream.lastPassAt = moment;
    },
    saveSignals: (platform, signals) => {
      const saved = pages.platforms.saveSignals(platform, signals);
      rescore();
      return saved;
    },
    overview: () => {
      const revenue = { low: 0, medium: 0, high: 0, scheduled_departure: 0 };
      for (const m of paying) revenue[m.risk?.level ?? 'low'] += price(m);
      // What members did since the demo opened: today's.
      const live = Math.max(0, members.summary.activity30d - activity30d);
      return {
        currency: CURRENCY,
        revenue: {
          low: round(revenue.low),
          medium: round(revenue.medium),
          high: round(revenue.high),
          scheduled_departure: round(revenue.scheduled_departure),
        },
        // Eight weeks of history: StayPut's figures until the community has 60 days of its own.
        stay: { ...DEFAULT_STAY },
        calibrated: [],
        saveRate: DEFAULT_SAVE_RATE,
        saveRateObserved: false,
        reasons: pages.exitReasons(),
        activity: activityDays.map((d, i) => ({
          day: d.day,
          actions: d.actions + (i === activityDays.length - 1 ? live : 0),
          members: d.members.size,
        })),
      };
    },
    team: () => team,
    exportData: () => ({
      exportedAt: new Date(now).toISOString(),
      company: { id: DEMO_WHOP_ID, name: COMMUNITY, is_demo: true },
      team: team.members,
      tables: {
        members: { rows: members.members.map((m) => ({ ...m })), truncated: false },
      },
    }),
    reports: () => weeklyReports(world.dashboard().priority),
    setReports: (enabled) => {
      reportsOn = enabled;
      return weeklyReports(world.dashboard().priority);
    },
  };
  return world;
}
