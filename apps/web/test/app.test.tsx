import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  AccountsView,
  AlumniView,
  AnnouncementsView,
  BuddiesView,
  GoalProposalsView,
  RescuesView,
  MemberSpaceView,
  RescueChallenge,
  ResultAnswer,
  ShareAnswer,
  SpaceOverview,
  TestimonialCard,
  PlatformActivityView,
  ActionRow,
  ActionSettingsView,
  ActionsPage,
  DashboardView,
  DiscordChannelChoice,
  InsightsOverview,
  InsightsReport,
  IntegrationsStatus,
  MemberDetail,
  MemberRetentionView,
  OperatorStatus,
  WebhookReplay,
  MemberRisk,
  MemberRow,
  MemberTelegramStatus,
  MembersPage,
  PeopleView,
  PlatformDashboard,
  PlatformDayView,
  PlatformSlotView,
  RevenueDay,
  RiskSettingsView,
  SyncRun,
  SyncStatus,
  SentWeeklyReport,
  WeeklyReportsView,
  BenchmarksView,
  BadgeView,
  TeamView,
  DataExport,
  MemberDataExport,
} from '@stayput/core';
import { DEFAULT_PLATFORM_SIGNALS, WHOP_VIEW_PATHS, forecastRevenue } from '@stayput/core';
import type { Locale } from '@stayput/i18n';
import { RouterProvider, createMemoryRouter, matchRoutes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/App';
import { DEMO_COMPANY_ID } from '../src/api';
import { AlumniCard } from '../src/components/AlumniCard';
import { resetDemo } from '../src/demo/api';
import { DemoMode } from '../src/demoMode';
import { readScreenshot } from '../src/ocr';
import { LIVE_REFRESH_MS } from '../src/views/creator/platform/PlatformDashboard';
import { I18nProvider, detectLocale } from '../src/i18n';
import { ErrorPanel } from '../src/components/Status';
import { ToastProvider } from '../src/ui/Toast';

// Tesseract reads screenshots in a real browser only: the tests say what it read.
vi.mock('../src/ocr', () => ({ readScreenshot: vi.fn() }));

/** `never`: a call that never answers (until the page gives it up). */
type Answer = { status: number; body: unknown } | Error | 'never';

/**
 * Answers the Worker's routes from a table (`/path` for a GET, `POST /path` otherwise), in order
 * for repeated calls; records the calls and the headers of each.
 */
function mockApi(answers: Record<string, Answer[]>) {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = method === 'GET' ? input : `${method} ${input}`;
    calls.push(path);
    headersOf.set(path, new Headers(init?.headers));
    if (typeof init?.body === 'string') bodies.set(path, JSON.parse(init.body) as unknown);
    const answer = answers[path]?.shift();
    if (!answer) return Promise.reject(new Error(`unexpected ${path}`));
    if (answer instanceof Error) return Promise.reject(answer);
    if (answer === 'never') {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const headersOf = new Map<string, Headers>();
const bodies = new Map<string, unknown>();

function renderAt(path: string, locale: Locale = 'en') {
  render(
    <I18nProvider initialLocale={locale}>
      <ToastProvider>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
      </ToastProvider>
    </I18nProvider>,
  );
}

/** The three figures of a platform's hero, as drawn. */
const heroFiguresOf = (hero: HTMLElement) =>
  within(hero)
    .getAllByRole('definition')
    .map((d) => d.textContent ?? '');

const creatorSession = {
  status: 200,
  body: {
    companyId: 'biz_A1',
    userId: 'user_alice',
    accessLevel: 'admin',
    via: 'iframe',
    timezoneSet: true,
    companyName: 'Le Club',
    testMode: false,
  },
};

const syncStatus = (over: Partial<SyncStatus> = {}) => ({
  status: 200,
  body: {
    backfillDone: true,
    lastSyncAt: '2026-10-01T10:00:00.000Z',
    streams: [
      {
        stream: 'members',
        backfillDone: true,
        inProgress: false,
        lastPassAt: '2026-10-01T10:00:00.000Z',
        error: null,
      },
    ],
    ...over,
  } satisfies SyncStatus,
});

const SCORED_AT = '2026-10-01T11:00:00.000Z';

/** A member who pays $49 a month and is fine, unless `over` says otherwise. */
const memberRow = (over: Partial<MemberRow> & Pick<MemberRow, 'id' | 'name'>): MemberRow => ({
  username: null,
  status: 'joined',
  accessLevel: 'customer',
  joinedAt: '2026-06-01T10:00:00.000Z',
  lastActionAt: '2026-09-30T10:00:00.000Z',
  lastActivityAt: '2026-09-30T10:00:00.000Z',
  doNotContact: false,
  activity: { messages: 0, reactions: 0, posts: 0, lessons: 0 },
  risk: null,
  membership: {
    status: 'active',
    price: 49,
    currency: 'usd',
    billingPeriodDays: 30,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: '2026-10-15T10:00:00.000Z',
  },
  lastPayment: {
    status: 'succeeded',
    amount: 49,
    currency: 'usd',
    at: '2026-09-15T10:00:00.000Z',
    failureReason: null,
  },
  ...over,
});

const risk = (over: Partial<MemberRisk> & Pick<MemberRisk, 'score' | 'level'>): MemberRisk => ({
  reasons: [],
  inactiveNewcomer: false,
  computedAt: SCORED_AT,
  ...over,
});

/** As the Worker sends them: the most at risk first. */
const MEMBERS: MembersPage = {
  summary: {
    members: 5,
    liveMemberships: 5,
    scheduledCancellations: 1,
    failedPayments: 1,
    activity30d: 7,
    revenue: { currency: 'USD', monthly: 245, atRisk: 98, otherCurrencies: false },
    risk: {
      high: 1,
      medium: 1,
      low: 2,
      scheduledDeparture: 1,
      inactiveNewcomers: 1,
      computedAt: SCORED_AT,
    },
  },
  truncated: false,
  members: [
    memberRow({
      id: 'mber_2',
      name: null,
      joinedAt: '2026-07-01T10:00:00.000Z',
      lastActionAt: null,
      lastActivityAt: null,
      risk: risk({
        score: 100,
        level: 'scheduled_departure',
        reasons: [
          { code: 'cancel_scheduled', date: '2026-10-20T10:00:00.000Z' },
          { code: 'activity_drop', percent: 100 },
        ],
      }),
      membership: {
        status: 'active',
        price: 49,
        currency: 'usd',
        billingPeriodDays: 30,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-10-20T10:00:00.000Z',
      },
      lastPayment: {
        status: 'failed',
        amount: 49,
        currency: 'usd',
        at: '2026-09-20T10:00:00.000Z',
        failureReason: 'Card declined',
      },
    }),
    memberRow({
      id: 'mber_3',
      name: 'Bruno Petit',
      username: 'bpetit',
      lastActivityAt: '2026-09-10T10:00:00.000Z',
      risk: risk({
        score: 78,
        level: 'high',
        reasons: [
          { code: 'inactive', days: 21 },
          { code: 'no_progress', days: 25, lesson: '3. Charts' },
        ],
      }),
    }),
    memberRow({
      id: 'mber_4',
      name: 'Denis Moreau',
      risk: risk({
        score: 52,
        level: 'medium',
        reasons: [
          { code: 'activity_drop', percent: 56 },
          { code: 'ticket_open', days: 3 },
        ],
      }),
    }),
    memberRow({
      id: 'mber_5',
      name: 'Chloé Dubois',
      joinedAt: '2026-09-27T10:00:00.000Z',
      lastActionAt: null,
      lastActivityAt: null,
      risk: risk({
        score: 12,
        level: 'low',
        inactiveNewcomer: true,
        reasons: [
          { code: 'never_active', days: 4 },
          { code: 'no_progress', days: 4, lesson: null },
        ],
      }),
    }),
    memberRow({
      id: 'mber_1',
      name: 'Alice Martin',
      activity: { messages: 6, reactions: 1, posts: 0, lessons: 0 },
      risk: risk({ score: 3, level: 'low', reasons: [{ code: 'reactions_drop', percent: 100 }] }),
    }),
  ],
};

const INTEGRATIONS: IntegrationsStatus = {
  whopAppId: 'app_stayput',
  discord: {
    available: true,
    install: {
      url: 'https://discord.com/oauth2/authorize?client_id=1&state=s',
      expiresAt: '2026-10-01T12:30:00.000Z',
    },
    servers: [],
    linkedMembers: 0,
    unlinkedAuthors: 0,
  },
  telegram: {
    available: true,
    addToGroup: {
      url: 'https://t.me/StayPutBot?startgroup=abc',
      expiresAt: '2026-10-01T13:00:00.000Z',
    },
    readsAllMessages: true,
    groups: [],
    linkedMembers: 0,
    unlinkedAuthors: 0,
  },
};

/** The calls of an opened dashboard: the session, the members, the sync status, the sources. */
const ACTION_SETTINGS: ActionSettingsView = {
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
  offers: { pauseDays: 30, promoPercent: 20, promoMonths: 3, extendDays: 7, coachingMessage: null },
  rulesOff: [],
};

const NO_ALUMNI: AlumniView = {
  offer: null,
  entered: 0,
  left: 0,
  returned: 0,
  returnRate: null,
  recovered: null,
};

/**
 * The home's chart as the Worker sends it on Oct 1: from Jul 1 (the 1st of the month 89 days
 * earlier). Saved: $49 on Sep 1, a $149 VIP on Sep 30, two $49 members today ($98, the hero's).
 * The members at risk paid $147 a month from Sep 2 (the first scores), $98 today.
 */
const REVENUE_HISTORY: RevenueDay[] = Array.from({ length: 93 }, (_, i) => {
  const day = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
  const saved = { '2026-09-01': 49, '2026-09-30': 149, '2026-10-01': 98 }[day] ?? 0;
  return { day, saved, atRisk: day < '2026-09-02' ? null : day === '2026-10-01' ? 98 : 147 };
});

/** The home's figures for MEMBERS: $245 a month, $98 of it at risk, Bruno to message. */
const HOME: DashboardView = {
  currency: 'USD',
  saved: {
    thisMonth: { direct: 98, influenced: 49, saves: 3 },
    lastMonth: { direct: 198 },
    otherCurrencies: false,
  },
  monthlyRevenue: 245,
  atRisk: { revenue: 98, members: 2, departures: 1, high: 1 },
  retention30: { rate: 0.8, kept: 4, base: 5 },
  members: { total: 5, newLast7Days: 1 },
  memberActivity30d: 7,
  stayputActions30d: { total: 6, messages: 4, paymentRetries: 1, offers: 1, pauses: 2, saved: 3 },
  mode: 'manual',
  testMode: false,
  riskHistory: [
    { day: '2026-09-29', departure: 0, high: 3, medium: 1, low: 1 },
    { day: '2026-09-30', departure: 1, high: 2, medium: 1, low: 1 },
    { day: '2026-10-01', departure: 1, high: 1, medium: 1, low: 2 },
  ],
  revenueHistory: REVENUE_HISTORY,
  gettingStarted: { discord: true, automation: true, reviewed: true, guardrails: true },
  welcomed: true,
  priority: { kind: 'message', memberIds: ['mber_3'], revenue: 49 },
};

const dashboard = (
  members: MembersPage = MEMBERS,
  integrations = INTEGRATIONS,
  home: DashboardView = HOME,
) => ({
  '/api/creator/biz_A1/session': [creatorSession],
  '/api/creator/biz_A1/members': [{ status: 200, body: members }],
  '/api/creator/biz_A1/sync': [syncStatus()],
  '/api/creator/biz_A1/integrations?lang=en': [{ status: 200, body: integrations }],
  '/api/creator/biz_A1/alumni': [{ status: 200, body: NO_ALUMNI }],
  '/api/creator/biz_A1/dashboard': [{ status: 200, body: home }],
  // Opening Members ticks « Review your at-risk members ».
  'POST /api/creator/biz_A1/getting-started/reviewed': [
    { status: 200, body: { done: true } },
    { status: 200, body: { done: true } },
  ],
});

/** The member space is off in V1 (MEMBER_SPACE_ENABLED): its tests turn it on. */
const spaceOn = () => vi.stubEnv('VITE_MEMBER_SPACE_ENABLED', 'true');
/** The legal pages, off since 2026-10-10 (features.ts), back on. */
const legalOn = () => vi.stubEnv('VITE_LEGAL_PAGES_ENABLED', 'true');

const NOBODY: MembersPage = {
  summary: {
    members: 0,
    liveMemberships: 0,
    scheduledCancellations: 0,
    failedPayments: 0,
    activity30d: 0,
    revenue: null,
    risk: {
      high: 0,
      medium: 0,
      low: 0,
      scheduledDeparture: 0,
      inactiveNewcomers: 0,
      computedAt: null,
    },
  },
  truncated: false,
  members: [],
};

/** Members' states hang on the day (inactive after 14 days…): their tests read them on Oct 1. */
function onOct1() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
}

/** The drawer of the member without a name: leaving on Oct 20, their last payment failed. */
const DETAIL_LEAVING: MemberDetail = {
  memberId: 'mber_2',
  scores: [
    { day: '2026-09-02', score: 40 },
    { day: '2026-09-20', score: 85 },
    { day: '2026-10-01', score: 100 },
  ],
  memberships: [
    {
      id: 'mem_2',
      status: 'active',
      price: 49,
      currency: 'usd',
      billingPeriodDays: 30,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: '2026-10-20T10:00:00.000Z',
      startedAt: '2026-07-01T10:00:00.000Z',
    },
    {
      id: 'mem_2old',
      status: 'expired',
      price: 29,
      currency: 'usd',
      billingPeriodDays: 30,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: '2026-06-30T10:00:00.000Z',
      startedAt: '2026-05-31T10:00:00.000Z',
    },
  ],
  payments: [
    {
      id: 'pay_23',
      status: 'failed',
      amount: 49,
      currency: 'usd',
      at: '2026-09-20T10:00:00.000Z',
      failureReason: 'Card declined',
    },
    {
      id: 'pay_22',
      status: 'succeeded',
      amount: 49,
      currency: 'usd',
      at: '2026-08-20T10:00:00.000Z',
      failureReason: null,
    },
    {
      id: 'pay_21',
      status: 'failed',
      amount: 49,
      currency: 'usd',
      at: '2026-07-20T10:00:00.000Z',
      failureReason: null,
    },
  ],
  platforms: [
    { platform: 'whop', events: 0, lastAt: null, linked: true },
    { platform: 'discord', events: 2, lastAt: '2026-09-29T10:00:00.000Z', linked: true },
    { platform: 'telegram', events: 1, lastAt: '2026-09-28T10:00:00.000Z', linked: false },
  ],
  pauseOffer: null,
};

/** Bruno's drawer: quiet for three weeks, on Whop only. */
const DETAIL_BRUNO: MemberDetail = {
  memberId: 'mber_3',
  scores: [
    { day: '2026-09-30', score: 70 },
    { day: '2026-10-01', score: 78 },
  ],
  memberships: [
    {
      id: 'mem_3',
      status: 'active',
      price: 49,
      currency: 'usd',
      billingPeriodDays: 30,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: '2026-10-15T10:00:00.000Z',
      startedAt: '2026-06-01T10:00:00.000Z',
    },
  ],
  payments: [
    {
      id: 'pay_31',
      status: 'succeeded',
      amount: 49,
      currency: 'usd',
      at: '2026-09-15T10:00:00.000Z',
      failureReason: null,
    },
  ],
  platforms: [{ platform: 'whop', events: 4, lastAt: '2026-09-10T10:00:00.000Z', linked: true }],
  pauseOffer: null,
};

/** A drawer with nothing in it yet. */
const DETAIL_EMPTY = (memberId: string): MemberDetail => ({
  memberId,
  scores: [],
  memberships: [],
  payments: [],
  platforms: [{ platform: 'whop', events: 0, lastAt: null, linked: true }],
  pauseOffer: null,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  resetDemo();
});

describe('creator view', () => {
  it('opens the dashboard of the company in the URL', async () => {
    const calls = mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
    // The side menu: the six sections of the redesign, in its order, the open one marked.
    const menu = screen.getByRole('navigation', { name: 'Dashboard sections' });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Dashboard', 'Members', 'Automations', 'Analytics', 'Integrations', 'Settings']);
    expect(within(menu).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // The top bar: the community by its name (never its id), no StayPut mark (Whop's frame
    // already says it), the member search (⌘K) and the guide; the language is in Settings only,
    // and there is no theme to choose (dark is the only one).
    expect(screen.getByRole('link', { name: 'Le Club' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1',
    );
    expect(screen.queryByRole('link', { name: 'StayPut' })).toBeNull();
    // The dashboard's title, on the left edge of its figures, a step above a page's title.
    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 }).className).toBe(
      'title-home',
    );
    expect(screen.queryByText('biz_A1')).toBeNull();
    expect(
      screen.getByRole('combobox', { name: 'Find a member' }).getAttribute('aria-keyshortcuts'),
    ).toBe('Meta+K Control+K');
    expect(screen.getByRole('button', { name: 'Guide' })).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Language' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Theme' })).toBeNull();
    // One page: no row of tabs.
    expect(screen.queryByRole('navigation', { name: 'Dashboard tabs' })).toBeNull();
    // On a phone, the main sections at the bottom, the others under « More ».
    const phone = screen.getByRole('navigation', { name: 'Main sections' });
    expect(
      within(phone)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Dashboard', 'Members', 'Automations', 'Analytics']);
    expect(within(phone).getByRole('button', { name: 'More' })).toBeTruthy();
    await screen.findByText('Bruno Petit');
    expect(calls.slice().sort()).toEqual([
      '/api/creator/biz_A1/dashboard',
      '/api/creator/biz_A1/integrations?lang=en',
      '/api/creator/biz_A1/members',
      '/api/creator/biz_A1/session',
      '/api/creator/biz_A1/sync',
    ]);
  });

  it('puts the money first, in one hero block with its chart', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    const hero = (await screen.findByRole('heading', { name: 'Your money this month' })).closest(
      'section',
    )!;
    // Three numbers, each its label and its value, nothing under them.
    await vi.waitFor(() =>
      expect(
        within(hero)
          .getAllByRole('definition')
          .map((dd) => dd.textContent),
      ).toEqual(['$98.00', '$98.00', '2']),
    );
    // What each counts is the label's tooltip, on the label's own words: never an « i ».
    expect(
      within(hero)
        .getAllByRole('tooltip')
        .map((tip) => tip.textContent),
    ).toEqual([
      'Payments recovered, cancellations withdrawn and pauses ended this month. Each counts once.',
      'Against the same day last month, Sep 1: $49.00 saved then.',
      'What the members leaving or at high risk pay each month, out of $245.00.',
      '1 leaving, 1 at high risk. Scored every hour, from 0 to 100.',
      'Saved in period: added up from the first day shown, so the line only climbs; the vertical line marks where this month starts. At risk: what members at risk paid a month.',
    ]);
    // As Whop writes a balance: the month so far, then against the same days last month,
    // turquoise when ahead.
    const delta = within(hero).getByRole('button', { name: '+$49.00 vs last month' });
    expect(delta.closest('p')!.className).toContain('text-accent');
    expect(delta.querySelector('.num')?.textContent).toBe('+$49.00');
    const label = within(hero).getByRole('button', { name: 'Revenue saved · This month' });
    expect(document.getElementById(label.getAttribute('aria-describedby')!)?.textContent).toMatch(
      /^Payments recovered/,
    );
    expect(within(hero).queryByRole('button', { name: 'More information' })).toBeNull();
    // The money saved: the screen's one large amount, solid white as Whop writes a balance (the
    // signature gradient is the primary button's, never an amount's), on its light; the money at
    // risk in white too, never red.
    const [saved, atRisk] = within(hero).getAllByRole('definition');
    expect(saved!.querySelector('.metric-lead.text-fg')).toBeTruthy();
    expect(hero.querySelector('.hero-glow')).toBeTruthy();
    expect(atRisk!.querySelector('.metric-hero.text-fg')).toBeTruthy();
    expect(atRisk!.innerHTML).not.toMatch(/danger|urgent/);
    expect(hero.innerHTML).not.toMatch(/text-hero|gradient/);
    // The chart is inside the same block.
    expect(within(hero).getByRole('table', { name: 'Revenue saved vs at risk' })).toBeTruthy();
    // In Analytics: the retention, what the members themselves did.
    expect(screen.queryByText('Retention, 30 days')).toBeNull();
    expect(screen.queryByText('Member activity (30d)')).toBeNull();
    // What StayPut did in 30 days, in one strip.
    const strip = screen
      .getByRole('heading', { name: 'StayPut actions (30d)' })
      .closest('section')!;
    // Each number under its words (the label's own, its tooltip aside).
    const cells = () =>
      Array.from(strip.querySelectorAll('dl > div')).map((cell) => [
        (within(cell as HTMLElement).queryByRole('button') ?? cell.querySelector('dt'))!
          .textContent,
        cell.querySelector('dd')!.textContent,
      ]);
    await vi.waitFor(() =>
      expect(cells()).toEqual([
        ['messages sent', '4'],
        ['payment retried', '1'],
        ['pauses offered', '2'],
        ['members saved', '3'],
      ]),
    );
    // Those three members' plans are what the chart saved in 30 days (brief v4 §13).
    expect(within(strip).getByRole('tooltip').textContent).toBe(
      'What their plans paid: $247.00 in 30 days.',
    );
  });

  it('shows the action of the day with the revenue at stake, and does it in one click', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/dashboard': [
        { status: 200, body: HOME },
        { status: 200, body: { ...HOME, priority: null } },
      ],
      'POST /api/creator/biz_A1/members/message': [{ status: 200, body: { queued: 1 } }],
    });
    renderAt('/dashboard/biz_A1');
    const card = (
      await screen.findByRole('heading', {
        name: 'Message 1 high-risk member nobody reached: $49.00 at risk',
      })
    ).closest('section')!;
    // How it is chosen is the label's tooltip: what those members pay, never a promise.
    expect(within(card).getByRole('tooltip').textContent).toContain('never a promise');
    // The page's only primary button.
    const button = within(card).getByRole('button', { name: 'Send the message' });
    expect(button.className).toContain('button-primary');
    await screen.findByText('Bruno Petit');
    expect(document.querySelectorAll('.button-primary')).toHaveLength(1);
    fireEvent.click(button);
    expect(await screen.findByText('1 message queued')).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/members/message')).toEqual({
      memberIds: ['mber_3'],
    });
    expect(headersOf.get('POST /api/creator/biz_A1/members/message')?.get('x-stayput-csrf')).toBe(
      '1',
    );
    // Read again: nothing urgent any more.
    expect(await screen.findByRole('heading', { name: 'Nothing urgent today' })).toBeTruthy();
  });

  it('lists who needs attention: their ring, the reason, the date and what they pay', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    await screen.findByText('Bruno Petit');
    const attention = screen.getByRole('heading', { name: 'Needs attention' }).closest('section')!;
    const rows = within(attention).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    // The urgent first: a payment failed and not recovered, the red dot said in words too.
    expect(rows[0]!.textContent).toContain('Member without a name');
    expect(rows[0]!.textContent).toContain('UrgentPayment failed');
    expect(rows[0]!.textContent).toContain('Leaves on Oct 20');
    expect(within(rows[0]!).getByRole('img', { name: 'Leaving' })).toBeTruthy();
    expect(rows[1]!.textContent).toContain('Bruno Petit');
    expect(rows[1]!.textContent).toContain('No activity for 21 days');
    expect(rows[1]!.textContent).toContain('Renews on Oct 15');
    expect(rows[1]!.textContent).toContain('$49.00/mo');
    expect(rows[1]!.textContent).not.toContain('Urgent');
    expect(within(rows[1]!).getByRole('img', { name: 'High risk · 78' })).toBeTruthy();
    expect(attention.textContent).not.toContain('Denis Moreau');
    expect(attention.textContent).not.toContain('Alice Martin');
    expect(within(attention).getByRole('link', { name: 'See all (2)' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/members',
    );
    // Each row opens its member; at rest a « › », the actions in its place on hover or focus.
    expect(within(rows[1]!).getByRole('link', { name: 'Bruno Petit' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/members?member=mber_3',
    );
    expect(rows[1]!.querySelector('[data-row-chevron]')).not.toBeNull();
    const actions = rows[1]!.querySelector('[data-row-actions]')!;
    expect(actions.className).toContain('opacity-0');
    expect(actions.className).toContain('group-hover:opacity-100');
    expect(actions.className).toContain('group-focus-within:opacity-100');
    // Icons named over them: Message, Pause, Offer.
    expect([...actions.querySelectorAll('[data-tip]')].map((tip) => tip.textContent)).toEqual([
      'Message',
      'Pause',
      'Offer',
    ]);
    // Each one with the means to act on the spot: Message, Pause, Offer.
    expect(within(attention).getByRole('button', { name: 'Message Bruno Petit' })).toBeTruthy();
    expect(
      within(attention).getByRole('button', { name: 'Offer Bruno Petit a pause' }),
    ).toBeTruthy();
    expect(
      within(attention).getByRole('button', { name: 'Make Bruno Petit an offer' }),
    ).toBeTruthy();
    // The newcomers are found in Members now (brief: five things on the home, no more).
    expect(screen.queryByRole('heading', { name: 'New members who have not started' })).toBeNull();
  });

  it('lets the creator write to a member in their own words, and says what Whop did', async () => {
    const now = Date.now();
    const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
    mockApi({
      ...dashboard(),
      'POST /api/creator/biz_A1/members/mber_3/note': [
        { status: 200, body: { actionId: 'a1', status: 'sent', sendAt: at(0) } },
        { status: 200, body: { actionId: 'a2', status: 'scheduled', sendAt: at(9) } },
        { status: 200, body: { actionId: 'a3', status: 'retrying', sendAt: at(1) } },
        {
          status: 200,
          body: { actionId: 'a4', status: 'failed', sendAt: at(0), reason: 'permission' },
        },
        { status: 409, body: { error: { code: 'conflict', message: 'do_not_contact' } } },
      ],
    });
    renderAt('/dashboard/biz_A1');
    const open = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Message Bruno Petit' }));
      return screen.findByRole('dialog', { name: 'Write to Bruno Petit' });
    };
    let dialog = await open();
    const send = () => within(dialog).getByRole('button', { name: 'Send' });
    // A title is offered; nothing leaves without the creator's words.
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe(
      'A message for you',
    );
    expect(send().hasAttribute('disabled')).toBe(true);
    expect(dialog.textContent).toContain('word for word in the support chat with them');
    const body = within(dialog).getByRole('textbox', { name: 'Your message' });
    fireEvent.change(body, { target: { value: 'Bruno, how is the course going?' } });
    expect(within(dialog).getByText('31/300')).toBeTruthy();
    fireEvent.click(send());
    expect(await screen.findByText('Sent to Bruno Petit')).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/members/mber_3/note')).toEqual({
      title: 'A message for you',
      body: 'Bruno, how is the course going?',
    });
    expect(screen.queryByRole('dialog', { name: 'Write to Bruno Petit' })).toBeNull();

    // In the quiet hours: when it leaves.
    dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Your message' }), {
      target: { value: 'See you tomorrow.' },
    });
    fireEvent.click(send());
    expect(await screen.findByText('Bruno Petit gets it in 9 hours')).toBeTruthy();
    expect(screen.getByText('When your quiet hours end.')).toBeTruthy();

    // Whop did not take it: never « sent », and when StayPut tries again.
    const write = async (words: string) => {
      dialog = await open();
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Your message' }), {
        target: { value: words },
      });
      fireEvent.click(send());
    };
    await write('Are you there?');
    expect(await screen.findByText('Not sent to Bruno Petit yet')).toBeTruthy();
    expect(
      screen.getByText(/^Whop did not take it\. StayPut tries again in \d+ (hour|minutes)/),
    ).toBeTruthy();
    // StayPut may not write in the support chat yet: what to do, said.
    await write('Still there?');
    expect(
      await screen.findByText(
        'StayPut cannot write in your support chat yet: accept its new permissions in Whop. Nothing was sent to Bruno Petit.',
      ),
    ).toBeTruthy();

    // A refusal is said as such, and the words stay to try again.
    dialog = await open();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Your message' }), {
      target: { value: 'One more.' },
    });
    fireEvent.click(send());
    expect(
      await screen.findByText(
        'On the do-not-contact list: StayPut takes no action for this member.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Write to Bruno Petit' })).toBeTruthy();
  });

  it('offers a pause after saying what the member gets, and says when one is open', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/actions': [
        { status: 200, body: ACTION_SETTINGS },
        { status: 200, body: ACTION_SETTINGS },
      ],
      'POST /api/creator/biz_A1/members/mber_3/offer': [
        { status: 200, body: { offerId: 'o1', kind: 'pause_offer', terms: { days: 30 } } },
      ],
      'POST /api/creator/biz_A1/members/mber_2/offer': [
        { status: 409, body: { error: { code: 'conflict', message: 'offer_open' } } },
      ],
    });
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Offer Bruno Petit a pause' }));
    const dialog = await screen.findByRole('dialog', { name: 'Offer Bruno Petit a pause?' });
    expect(
      await within(dialog).findByText('A 30-day pause: their membership waits for them.'),
    ).toBeTruthy();
    // Proposed in the support chat: nothing changes without the member's yes.
    expect(dialog.textContent).toContain('Proposed in the support chat with them');
    expect(dialog.textContent).toContain('you then apply it from their sheet');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Offer the pause' }));
    expect(await screen.findByText('Pause offered to Bruno Petit')).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/members/mber_3/offer')).toEqual({
      kind: 'pause_offer',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Pause offered', { selector: '.sr-only' })).toBeTruthy();

    // A member who already has an open offer: said in words, never a code.
    fireEvent.click(screen.getByRole('button', { name: 'Make Member without a name an offer' }));
    const second = await screen.findByRole('dialog', {
      name: 'Make Member without a name an offer?',
    });
    expect(
      await within(second).findByText('20% off for 3 months, put on their membership.'),
    ).toBeTruthy();
    fireEvent.click(within(second).getByRole('button', { name: 'Make the offer' }));
    expect(
      await screen.findByText(
        'Already under way: a pause is waiting for this member’s answer, or a discount was given this week.',
      ),
    ).toBeTruthy();
  });

  it('says when test mode is on, on top of every screen, and turns it off', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/session': [
        { ...creatorSession, body: { ...creatorSession.body, testMode: true } },
      ],
      'POST /api/creator/biz_A1/test-mode/off': [
        { status: 200, body: { ...ACTION_SETTINGS, dryRun: false } },
      ],
    });
    renderAt('/dashboard/biz_A1');
    const words = await screen.findByText(
      'Test mode is on: StayPut computes everything but sends nothing.',
    );
    // A slim turquoise outline and muted words, never a fill.
    const bar = words.closest('[role="note"]')!;
    expect(bar.className).toContain('border-turq-300/40');
    expect(bar.className).not.toMatch(/warning|bg-/);
    // « Turn off » asks once more: from then on StayPut really sends.
    fireEvent.click(within(bar as HTMLElement).getByRole('button', { name: 'Turn off' }));
    expect(within(bar as HTMLElement).getByText('From now on, StayPut really sends.')).toBeTruthy();
    fireEvent.click(within(bar as HTMLElement).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Test mode is off: StayPut now really sends.')).toBeTruthy();
    expect(calls).toContain('POST /api/creator/biz_A1/test-mode/off');
    expect(
      screen.queryByText('Test mode is on: StayPut computes everything but sends nothing.'),
    ).toBeNull();
  });

  it('shows the five most urgent members only, the most urgent first', async () => {
    const day = 86_400_000;
    const leaving = (inDays: number): MemberRow['membership'] => ({
      status: 'active',
      price: 49,
      currency: 'usd',
      billingPeriodDays: 30,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(Date.now() + inDays * day).toISOString(),
    });
    const members: MemberRow[] = [
      memberRow({ id: 'm_a', name: 'Ana High', risk: risk({ score: 90, level: 'high' }) }),
      memberRow({
        id: 'm_b',
        name: 'Ben Soon',
        risk: risk({ score: 100, level: 'scheduled_departure' }),
        membership: leaving(1),
      }),
      memberRow({
        id: 'm_c',
        name: 'Cleo Card',
        risk: risk({ score: 70, level: 'high' }),
        lastPayment: {
          status: 'failed',
          amount: 49,
          currency: 'usd',
          at: '2026-09-30T10:00:00.000Z',
          failureReason: 'Card declined',
        },
      }),
      memberRow({
        id: 'm_d',
        name: 'Dan Later',
        risk: risk({ score: 100, level: 'scheduled_departure' }),
        membership: leaving(10),
      }),
      memberRow({ id: 'm_e', name: 'Eve High', risk: risk({ score: 85, level: 'high' }) }),
      memberRow({ id: 'm_f', name: 'Fay High', risk: risk({ score: 60, level: 'high' }) }),
      memberRow({ id: 'm_g', name: 'Gus High', risk: risk({ score: 95, level: 'high' }) }),
      memberRow({ id: 'm_h', name: 'Hal Medium', risk: risk({ score: 50, level: 'medium' }) }),
    ];
    mockApi(dashboard({ ...MEMBERS, members }));
    renderAt('/dashboard/biz_A1');
    const attention = (await screen.findByRole('heading', { name: 'Needs attention' })).closest(
      'section',
    )!;
    await within(attention).findByText('Ben Soon');
    // Leaving within 48 hours, a payment failed; then the departures; then the highest scores.
    const rows = within(attention).getAllByRole('listitem');
    expect(rows.map((li) => li.querySelector('a')?.textContent)).toEqual([
      'Ben Soon',
      'Cleo Card',
      'Dan Later',
      'Gus High',
      'Ana High',
    ]);
    expect(rows[0]!.textContent).toContain('UrgentLeaves on');
    expect(rows[2]!.textContent).not.toContain('Urgent');
    expect(within(attention).getByRole('link', { name: 'See all (7)' })).toBeTruthy();
  });

  it('draws the money saved against the money at risk, over 7, 30 or 90 days', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    const chart = (await screen.findByRole('table', { name: 'Revenue saved vs at risk' })).closest(
      'section',
    )!;
    const periods = within(chart).getByRole('radiogroup', { name: 'Period' });
    expect(
      within(periods)
        .getAllByRole('radio')
        .map((radio) => `${radio.textContent} ${radio.getAttribute('aria-checked')}`),
    ).toEqual(['7D false', '30D true', '90D false']);
    // Said in a sentence, and as a table, for screen readers; the saved money added up.
    const summary = () => chart.querySelector('figcaption')?.textContent;
    expect(summary()).toBe(
      'Over the last 30 days, StayPut saved $247.00; the revenue at risk went from $147.00 to $98.00 a month.',
    );
    const rows = () => within(chart).getAllByRole('row');
    const headers = within(chart)
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual(['Day', 'Saved in period', 'Saved in the month', 'At risk']);
    // The period's money adds up from its first day: it ends today on what the 30 days saved,
    // the month's on the hero's figure.
    expect(rows()).toHaveLength(31);
    expect(rows()[1]!.textContent).toBe('Sep 2, 2026$0.00$49.00$147.00');
    expect(rows()[29]!.textContent).toBe('Sep 30, 2026$149.00$198.00$147.00');
    expect(rows()[30]!.textContent).toBe('Oct 1, 2026$247.00$98.00$98.00');
    // Where the month starts, marked: today is the 1st.
    expect(chart.querySelector('[data-chart="month-start"]')?.textContent).toBe('Oct 1');
    // Before the first scores, no risk figure rather than a zero.
    fireEvent.click(within(periods).getByRole('radio', { name: '90D' }));
    expect(rows()).toHaveLength(91);
    expect(rows()[1]!.textContent).toBe('Jul 4, 2026$0.00$0.00—');
    expect(rows()[90]!.textContent).toBe('Oct 1, 2026$296.00$98.00$98.00');
    fireEvent.click(within(periods).getByRole('radio', { name: '7D' }));
    expect(summary()).toBe(
      'Over the last 7 days, StayPut saved $247.00; the revenue at risk went from $147.00 to $98.00 a month.',
    );
    // The keyboard walks the days, and each day's figures are said.
    const plot = within(chart).getByRole('group', { name: 'Revenue saved vs at risk' });
    const said = () => chart.querySelector('[aria-live]')?.textContent;
    fireEvent.focus(plot);
    expect(said()).toBe(
      'Oct 1, 2026: Saved in period $247.00, Saved this month $98.00, At risk $98.00',
    );
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(said()).toBe(
      'Sep 30, 2026: Saved in period $149.00, Saved in September $198.00, At risk $147.00',
    );
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(said()).toBe(
      'Sep 25, 2026: Saved in period $0.00, Saved in September $49.00, At risk $147.00',
    );
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(said()).toBe('');
    // The members at risk, hidden and shown again from the legend.
    const legend = within(chart).getByRole('button', { name: 'At risk' });
    expect(legend.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(legend);
    expect(legend.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(legend);
    expect(legend.getAttribute('aria-pressed')).toBe('true');
  });

  it('puts each day’s saves on that day and never goes down, in English and in French', async () => {
    // As the Worker sends them (its days are the community's, tested there): a save at 23:30
    // on 30 September, one at 00:30 on 1 October, one on the 2nd; today is 3 October.
    const history: RevenueDay[] = Array.from({ length: 95 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const saved = { '2026-09-30': 149, '2026-10-01': 49, '2026-10-02': 49 }[day] ?? 0;
      return { day, saved, atRisk: 147 };
    });
    const home = {
      ...HOME,
      saved: { ...HOME.saved, thisMonth: { ...HOME.saved.thisMonth, direct: 98 } },
      revenueHistory: history,
    };
    for (const [locale, words] of [
      [
        'en',
        {
          table: 'Revenue saved vs at risk',
          oct1: 'Oct 1, 2026: Saved in period $198.00, Saved this month $49.00, At risk $147.00',
          sep30:
            'Sep 30, 2026: Saved in period $149.00, Saved in September $149.00, At risk $147.00',
          marker: 'Oct 1',
        },
      ],
      [
        'fr',
        {
          table: 'Revenus sauvés et revenus à risque',
          oct1: '1 oct. 2026 : Sauvé sur la période 198,00 $, Sauvé ce mois-ci 49,00 $, À risque 147,00 $',
          sep30:
            '30 sept. 2026 : Sauvé sur la période 149,00 $, Sauvé en septembre 149,00 $, À risque 147,00 $',
          marker: '1 oct.',
        },
      ],
    ] as const) {
      mockApi({
        ...dashboard(MEMBERS, INTEGRATIONS, home),
        [`/api/creator/biz_A1/integrations?lang=${locale}`]: [{ status: 200, body: INTEGRATIONS }],
      });
      renderAt('/dashboard/biz_A1', locale);
      const chart = (await screen.findByRole('table', { name: words.table })).closest('section')!;
      expect(chart.querySelector('[data-chart="month-start"]')?.textContent).toBe(words.marker);
      // The table's figures never go down, and end on what the period saved.
      const inPeriod = within(chart)
        .getAllByRole('row')
        .slice(1)
        .map((row) => Number(row.querySelectorAll('td')[0]!.textContent.replace(/[^\d]/g, '')));
      expect(inPeriod).toEqual([...inPeriod].sort((a, b) => a - b));
      expect(inPeriod.at(-1)).toBe(24_700);
      // Each save on its own day: 1 October has its 00:30 save, 30 September its 23:30 one.
      const plot = within(chart).getByRole('group', { name: words.table });
      const said = () => chart.querySelector('[aria-live]')?.textContent?.replace(/\s/g, ' ');
      fireEvent.focus(plot);
      fireEvent.keyDown(plot, { key: 'ArrowLeft' });
      fireEvent.keyDown(plot, { key: 'ArrowLeft' });
      expect(said()).toBe(words.oct1);
      fireEvent.keyDown(plot, { key: 'ArrowLeft' });
      expect(said()).toBe(words.sep30);
      cleanup();
    }
  });

  it('puts « Getting started » under the title, folded from two steps done, gone when done', async () => {
    const calls = mockApi(
      dashboard(MEMBERS, INTEGRATIONS, {
        ...HOME,
        gettingStarted: { discord: true, automation: false, reviewed: false, guardrails: true },
      }),
    );
    renderAt('/dashboard/biz_A1');
    const pill = await screen.findByRole('button', { name: /^Getting started/ });
    expect(pill.textContent).toContain('2/4');
    // Two of four done: the pill alone, its steps one click away.
    expect(pill.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('link', { name: 'Activate your first automation' })).toBeNull();
    fireEvent.click(pill);
    // Each step leads to its screen; the done ones say so.
    const step = (name: string) => screen.getByRole('link', { name }).getAttribute('href');
    expect(step('Connect Discord · done')).toBe('/dashboard/biz_A1/sources');
    expect(step('Activate your first automation')).toBe('/dashboard/biz_A1/actions');
    expect(step('Review your at-risk members')).toBe('/dashboard/biz_A1/members?filter=high');
    expect(step('Set your limits · done')).toBe('/dashboard/biz_A1/settings/actions');
    // Opening the members at risk ticks their step.
    fireEvent.click(screen.getByRole('link', { name: 'Review your at-risk members' }));
    await vi.waitFor(() =>
      expect(calls).toContain('POST /api/creator/biz_A1/getting-started/reviewed'),
    );
    expect(
      headersOf.get('POST /api/creator/biz_A1/getting-started/reviewed')?.get('x-stayput-csrf'),
    ).toBe('1');
    cleanup();
    // One step done: the steps show at once.
    mockApi(
      dashboard(MEMBERS, INTEGRATIONS, {
        ...HOME,
        gettingStarted: { discord: true, automation: false, reviewed: false, guardrails: false },
      }),
    );
    renderAt('/dashboard/biz_A1');
    expect(
      (await screen.findByRole('button', { name: /^Getting started/ })).getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');
    expect(screen.getByRole('link', { name: 'Set your limits' })).toBeTruthy();
    cleanup();
    // Everything done: gone.
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    await screen.findByText('Revenue saved · This month');
    expect(screen.queryByRole('button', { name: /^Getting started/ })).toBeNull();
  });

  it('shows each member on one line: the ring, one word for their state, what they pay', async () => {
    onOct1();
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members');
    const table = await screen.findByRole('table', { name: 'All members' });
    // Every column has a name and sorts; the bell's column is named for screen readers alone.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Member',
      'Risk',
      'Status',
      'MRR',
      'Last activity',
      'Next renewal',
      'Do not contact',
    ]);
    const risk = within(table).getByRole('columnheader', { name: 'Risk' });
    expect(risk.getAttribute('aria-sort')).toBe('descending');
    // The most at risk first, as the Worker reads them.
    const rows = within(table).getAllByRole('row').slice(1);
    // The name (a button), then each column's words.
    const cells = (row: HTMLElement) => {
      const [who, ...rest] = within(row).getAllByRole('cell');
      return [
        within(who!).getByRole('button').textContent,
        ...rest.map((cell) => cell.textContent),
      ];
    };
    expect(rows.map(cells)).toEqual([
      ['Member without a name', '100', 'UrgentLeaving', '$49.00/mo', 'Never', 'Ends Oct 20', ''],
      ['Bruno Petit', '78', 'Inactive', '$49.00/mo', '3 weeks ago', 'Oct 15', ''],
      ['Denis Moreau', '52', 'Active', '$49.00/mo', 'yesterday', 'Oct 15', ''],
      ['Chloé Dubois', '12', 'Inactive', '$49.00/mo', 'Never', 'Oct 15', ''],
      ['Alice Martin', '3', 'Active', '$49.00/mo', 'yesterday', 'Oct 15', ''],
    ]);
    // On a phone, the status and what they pay under the name.
    expect(within(rows[0]!).getAllByRole('cell')[0]!.textContent).toBe(
      'Member without a nameUrgentLeaving$49.00/mo',
    );
    // The ring says the level and the score; the name opens the drawer.
    expect(within(rows[1]!).getByRole('img').getAttribute('aria-label')).toBe('High risk · 78');
    expect(within(rows[0]!).getByRole('img').getAttribute('aria-label')).toBe('Leaving');
    expect(
      within(rows[1]!)
        .getByRole('button', { name: 'Open Bruno Petit' })
        .getAttribute('aria-haspopup'),
    ).toBe('dialog');
    // The state in white words; the red dot only for what is urgent (a payment not recovered).
    const status = within(rows[0]!).getAllByRole('cell')[2]!;
    expect(status.className).toContain('text-fg');
    expect(status.querySelector('[class*="bg-urgent"]')).not.toBeNull();
    expect(
      within(rows[1]!).getAllByRole('cell')[2]!.querySelector('[class*="bg-urgent"]'),
    ).toBeNull();
  });

  it('sorts by every column, the most telling way first, and opens in the order a link asks for', async () => {
    onOct1();
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members');
    const table = await screen.findByRole('table', { name: 'All members' });
    const names = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(within(row).getAllByRole('cell')[0]!).getByRole('button').textContent);
    const sortBy = (column: string) =>
      fireEvent.click(
        within(within(table).getByRole('columnheader', { name: column })).getByRole('button'),
      );
    // By name, A to Z; again, Z to A. Who has none comes last either way.
    sortBy('Member');
    expect(names()).toEqual([
      'Alice Martin',
      'Bruno Petit',
      'Chloé Dubois',
      'Denis Moreau',
      'Member without a name',
    ]);
    expect(
      within(table).getByRole('columnheader', { name: 'Member' }).getAttribute('aria-sort'),
    ).toBe('ascending');
    sortBy('Member');
    expect(names()).toEqual([
      'Denis Moreau',
      'Chloé Dubois',
      'Bruno Petit',
      'Alice Martin',
      'Member without a name',
    ]);
    // The most pressing state first: leaving, then inactive, then active.
    sortBy('Status');
    expect(names()).toEqual([
      'Member without a name',
      'Bruno Petit',
      'Chloé Dubois',
      'Denis Moreau',
      'Alice Martin',
    ]);
    // The most recent first; never active last.
    sortBy('Last activity');
    expect(names()).toEqual([
      'Denis Moreau',
      'Alice Martin',
      'Bruno Petit',
      'Member without a name',
      'Chloé Dubois',
    ]);
    // The soonest renewal first.
    sortBy('Next renewal');
    expect(names()).toEqual([
      'Bruno Petit',
      'Denis Moreau',
      'Chloé Dubois',
      'Alice Martin',
      'Member without a name',
    ]);
    cleanup();
    onOct1();
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members?sort=member&dir=desc');
    const linked = await screen.findByRole('table', { name: 'All members' });
    expect(
      within(linked).getByRole('columnheader', { name: 'Member' }).getAttribute('aria-sort'),
    ).toBe('descending');
    expect(
      within(linked)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('button')[0]!.textContent)[0],
    ).toBe('Denis Moreau');
  });

  it('opens a member’s drawer from their row: why, what to do, the score, the payments, where', async () => {
    onOct1();
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/members/mber_2': [{ status: 200, body: DETAIL_LEAVING }],
    });
    renderAt('/dashboard/biz_A1/members');
    const table = await screen.findByRole('table', { name: 'All members' });
    fireEvent.click(within(table).getAllByRole('row')[1]!);
    const drawer = await screen.findByRole('dialog', { name: 'Member without a name' });
    expect(within(drawer).getByText('Member since Jul 1, 2026')).toBeTruthy();
    // Where they stand: the ring, the level, what they pay, when they leave.
    expect(within(drawer).getByRole('img', { name: 'Leaving' })).toBeTruthy();
    expect(drawer.textContent).toContain('$49.00/mo·Ends Oct 20');
    const section = (name: string) => within(drawer).getByRole('region', { name });
    expect(section('Why').textContent).toBe('WhyLeaves on Oct 20, 2026No activity this week');
    expect(
      within(section('Quick actions'))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Message', 'Pause', 'Offer']);
    // The score day by day, from 0 to 100.
    expect(within(section('Risk over 30 days')).getByRole('img').getAttribute('aria-label')).toBe(
      'Risk score over the last 30 days: from 40 to 100.',
    );
    expect(section('Risk over 30 days').textContent).toContain('Sep 2Oct 1');
    expect(section('Subscription').textContent).toBe(
      'Subscription' +
        'Active · $49.00 per month · ends on Oct 20, 2026' +
        'Since Jul 1, 2026' +
        'Expired · $29.00 per month · ended on Jun 30, 2026',
    );
    // The latest payment failed and was not recovered: the red dot, its reason; not the old one.
    const payments = within(section('Payments')).getAllByRole('listitem');
    expect(payments.map((payment) => payment.textContent)).toEqual([
      'UrgentFailed· Sep 20, 2026$49.00Card declined',
      'Paid· Aug 20, 2026$49.00',
      'Failed· Jul 20, 2026$49.00',
    ]);
    expect(payments[2]!.querySelector('[class*="bg-urgent"]')).toBeNull();
    expect(
      within(section('Activity over 30 days'))
        .getAllByRole('listitem')
        .map((platform) => platform.textContent),
    ).toEqual([
      'Whop0 interactionsNo activity recorded yet.',
      'Discord2 interactionsLast active 2 days ago',
      'Telegram1 interactionAccount not tied yet',
    ]);
    const never = within(drawer).getByRole('switch', { name: 'Do not contact' });
    expect(never.getAttribute('aria-checked')).toBe('false');
    expect(
      within(drawer).getByText('StayPut may contact this member, within your limits.'),
    ).toBeTruthy();
    expect(calls).toContain('/api/creator/biz_A1/members/mber_2');
    // Closed: gone, and the table is still there.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('table', { name: 'All members' })).toBeTruthy();
  });

  it('says in a line when a member’s history did not load, and tries again', async () => {
    onOct1();
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/members/mber_2': [
        new TypeError('offline'),
        { status: 200, body: DETAIL_LEAVING },
      ],
    });
    renderAt('/dashboard/biz_A1/members?member=mber_2');
    const drawer = await screen.findByRole('dialog', { name: 'Member without a name' });
    expect(await within(drawer).findByText('This member’s history did not load.')).toBeTruthy();
    // What the row already says stays: why, what to do, the subscription.
    expect(within(drawer).getByRole('region', { name: 'Why' })).toBeTruthy();
    expect(within(drawer).getByRole('region', { name: 'Subscription' })).toBeTruthy();
    expect(within(drawer).queryByRole('region', { name: 'Payments' })).toBeNull();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }));
    expect(await within(drawer).findByRole('region', { name: 'Payments' })).toBeTruthy();
  });

  it('keeps the facts of Whop before the first scores', async () => {
    mockApi(
      dashboard({
        ...MEMBERS,
        members: MEMBERS.members.map((m) => ({ ...m, risk: null })),
      }),
    );
    renderAt('/dashboard/biz_A1');
    await screen.findByText('Member without a name');
    const attention = screen.getByRole('heading', { name: 'Needs attention' }).closest('section')!;
    expect(attention.textContent).toContain('Payment failed');
    expect(attention.textContent).toContain('Leaves on Oct 20');
    expect(attention.textContent).not.toContain('Bruno Petit');
  });

  it('filters the members by risk level and finds one by name, accents aside', async () => {
    onOct1();
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members');
    await screen.findByRole('table', { name: 'All members' });
    const names = () =>
      [
        'Member without a name',
        'Bruno Petit',
        'Denis Moreau',
        'Chloé Dubois',
        'Alice Martin',
      ].filter((name) => screen.queryByRole('button', { name: `Open ${name}` }) !== null);
    // Each chip says how many it keeps.
    expect(
      within(screen.getByRole('group', { name: 'Show' }))
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['All5', 'Leaving1', 'High1', 'Medium1', 'Low2', 'New inactive1', 'Gone0']);
    fireEvent.click(screen.getByRole('button', { name: /^Leaving/ }));
    await vi.waitFor(() => expect(names()).toEqual(['Member without a name']));
    expect(screen.getByRole('button', { name: /^Leaving/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: /^High/ }));
    await vi.waitFor(() => expect(names()).toEqual(['Bruno Petit']));
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }));
    await vi.waitFor(() => expect(names()).toEqual(['Chloé Dubois', 'Alice Martin']));
    fireEvent.click(screen.getByRole('button', { name: /^New inactive/ }));
    await vi.waitFor(() => expect(names()).toEqual(['Chloé Dubois']));
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a member' }), {
      target: { value: 'ALÎCE' },
    });
    await vi.waitFor(() => expect(names()).toEqual(['Alice Martin']));
    // Its Whop username too.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a member' }), {
      target: { value: '@bpetit' },
    });
    await vi.waitFor(() => expect(names()).toEqual(['Bruno Petit']));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a member' }), {
      target: { value: 'nobody' },
    });
    expect(await screen.findByText('No member matches “nobody”.')).toBeTruthy();
    // One click back to everyone: the words and the filter gone.
    fireEvent.click(screen.getByRole('button', { name: /^High/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear search and filters' }));
    await vi.waitFor(() => expect(names()).toHaveLength(5));
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search a member' }).value).toBe(
      '',
    );
    expect(screen.getByRole('button', { name: /^All/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('applies, in one click, the pause a member said yes to in the support chat', async () => {
    onOct1();
    const waiting = {
      ...DETAIL_BRUNO,
      pauseOffer: { id: 'offer_1', days: 30, expiresAt: '2026-10-08T12:00:00.000Z' },
    };
    const calls = mockApi({
      ...dashboard(),
      // Read again once applied: nothing waits any more.
      '/api/creator/biz_A1/members/mber_3': [
        { status: 200, body: waiting },
        { status: 200, body: DETAIL_BRUNO },
      ],
      'POST /api/creator/biz_A1/members/mber_3/offers/offer_1/apply': [
        { status: 200, body: { actionId: 'a1' } },
      ],
    });
    renderAt('/dashboard/biz_A1/members?filter=high&member=mber_3');
    const drawer = await screen.findByRole('dialog', { name: 'Bruno Petit' });
    expect(
      await within(drawer).findByText(
        /^A 30-day pause is proposed: waiting for their answer in the support chat, until/,
      ),
    ).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'They said yes: apply the pause' }));
    expect(await screen.findByText('Pause applied for Bruno Petit')).toBeTruthy();
    expect(screen.getByText('Tell them in the support chat: it is done.')).toBeTruthy();
    expect(calls).toContain('POST /api/creator/biz_A1/members/mber_3/offers/offer_1/apply');
    await vi.waitFor(() =>
      expect(
        within(drawer).queryByRole('button', { name: 'They said yes: apply the pause' }),
      ).toBeNull(),
    );
  });

  it('keeps a member off every action from their drawer, and says when that was not saved', async () => {
    onOct1();
    const listed: MembersPage = {
      ...MEMBERS,
      members: MEMBERS.members.map((m) => (m.id === 'mber_3' ? { ...m, doNotContact: true } : m)),
    };
    mockApi({
      ...dashboard(),
      // Read again once the switch is saved: Bruno is on the list.
      '/api/creator/biz_A1/members': [
        { status: 200, body: MEMBERS },
        { status: 200, body: listed },
      ],
      '/api/creator/biz_A1/members/mber_3': [{ status: 200, body: DETAIL_BRUNO }],
      'PUT /api/creator/biz_A1/members/mber_3/contact': [
        { status: 200, body: { doNotContact: true } },
        new Error('offline'),
      ],
    });
    // A link opens the drawer at once.
    renderAt('/dashboard/biz_A1/members?filter=high&member=mber_3');
    const drawer = await screen.findByRole('dialog', { name: 'Bruno Petit' });
    // The drawer opens before Bruno's detail is read: his activity comes with it.
    const activity = within(drawer).getByRole('region', { name: 'Activity over 30 days' });
    expect(
      (await within(activity).findAllByRole('listitem', undefined, { timeout: 3_000 })).map(
        (platform) => platform.textContent,
      ),
    ).toEqual(['Whop4 interactionsLast active 3 weeks ago']);
    const never = within(drawer).getByRole('switch', { name: 'Do not contact' });
    expect(never.getAttribute('aria-checked')).toBe('false');
    expect(within(drawer).getByRole('button', { name: 'Message Bruno Petit' })).toBeTruthy();
    fireEvent.click(never);
    await vi.waitFor(() => expect(never.getAttribute('aria-checked')).toBe('true'));
    const put = 'PUT /api/creator/biz_A1/members/mber_3/contact';
    expect(bodies.get(put)).toEqual({ doNotContact: true });
    expect(headersOf.get(put)?.get('x-stayput-csrf')).toBe('1');
    // The one sentence that says what it means, here only; nothing left to do for them.
    expect(
      within(drawer).getByText('StayPut takes no action of any kind for this member.'),
    ).toBeTruthy();
    expect(within(drawer).queryByRole('region', { name: 'Quick actions' })).toBeNull();
    // Not saved: it says so, and the switch stays as it was.
    fireEvent.click(never);
    expect(await within(drawer).findByText('Not saved. Try again.')).toBeTruthy();
    expect(never.getAttribute('aria-checked')).toBe('true');
    // Closed: the members were read again, Bruno's row wears the bell.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const bruno = screen.getByRole('row', { name: /Bruno Petit/ });
    expect(within(bruno).getAllByRole('cell').at(-1)!.textContent).toBe('Do not contact');
    expect(within(bruno).getAllByRole('cell').at(-1)!.querySelector('svg')).not.toBeNull();
  });

  it('exports a member’s data, and deletes it for good once confirmed (SPEC Phase 8.3)', async () => {
    onOct1();
    const exported: MemberDataExport = {
      exportedAt: '2026-10-01T09:00:00.000Z',
      member: { id: 'mber_3', display_name: 'Bruno Petit' },
      tables: { payments: [] },
    };
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/members': [
        { status: 200, body: MEMBERS },
        {
          status: 200,
          body: { ...MEMBERS, members: MEMBERS.members.filter((m) => m.id !== 'mber_3') },
        },
      ],
      '/api/creator/biz_A1/members/mber_3': [{ status: 200, body: DETAIL_BRUNO }],
      '/api/creator/biz_A1/members/mber_3/export': [{ status: 200, body: exported }],
      'POST /api/creator/biz_A1/members/mber_3/delete': [{ status: 200, body: { deleted: true } }],
    });
    const createObjectURL = vi.fn(() => 'blob:stayput-member');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderAt('/dashboard/biz_A1/members?member=mber_3');
      const drawer = await screen.findByRole('dialog', { name: 'Bruno Petit' });
      const data = within(drawer).getByRole('region', { name: 'Their data' });
      fireEvent.click(within(data).getByRole('button', { name: 'Export (JSON)' }));
      await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe(
        'stayput-mber_3-2026-10-01.json',
      );
      fireEvent.click(within(data).getByRole('button', { name: 'Delete their data' }));
      const confirm = await screen.findByRole('dialog', { name: 'Delete Bruno Petit’s data?' });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for good' }));
      expect(await screen.findByText('Bruno Petit’s data is deleted.')).toBeTruthy();
      expect(bodies.get('POST /api/creator/biz_A1/members/mber_3/delete')).toEqual({
        confirm: 'mber_3',
      });
      // The drawer closes; the list, read again, no longer has him.
      await vi.waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Bruno Petit' })).toBeNull(),
      );
      await vi.waitFor(() => expect(screen.queryByRole('row', { name: /Bruno Petit/ })).toBeNull());
    } finally {
      click.mockRestore();
    }
  });

  it('opens on the level a link asks for', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members?filter=medium');
    expect(await screen.findByText('Denis Moreau')).toBeTruthy();
    expect(screen.queryByText('Alice Martin')).toBeNull();
    expect(screen.getByRole('button', { name: /^Medium/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('says so when there is nobody yet, while the history is being imported', async () => {
    mockApi({
      ...dashboard(NOBODY, INTEGRATIONS, {
        ...HOME,
        currency: null,
        saved: {
          thisMonth: { direct: 0, influenced: 0, saves: 0 },
          lastMonth: { direct: 0 },
          otherCurrencies: false,
        },
        monthlyRevenue: null,
        atRisk: { revenue: 0, members: 0, departures: 0, high: 0 },
        retention30: { rate: null, kept: 0, base: 0 },
        members: { total: 0, newLast7Days: 0 },
        memberActivity30d: 0,
        stayputActions30d: {
          total: 0,
          messages: 0,
          paymentRetries: 0,
          offers: 0,
          pauses: 0,
          saved: 0,
        },
        riskHistory: [],
        revenueHistory: REVENUE_HISTORY.map((d) => ({ ...d, saved: 0, atRisk: null })),
        priority: null,
      }),
      '/api/creator/biz_A1/sync': [syncStatus({ backfillDone: false })],
    });
    renderAt('/dashboard/biz_A1');
    expect(
      await screen.findByText(
        'Importing the last 90 days of your community. This can take a few minutes.',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('Nothing needs your attention right now.')).toBeTruthy();
    // No amount yet: a dash, and why behind the « i ».
    expect(await screen.findAllByText('No paying membership yet.')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Nothing urgent today' })).toBeTruthy();
    expect(
      screen.getByText(
        'The chart fills in day after day, as StayPut scores your members and saves revenue.',
      ),
    ).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Dashboard sections' })).getByRole('link', {
        name: 'Members',
      }),
    );
    expect(
      await screen.findByText(
        'No members yet. They appear here once StayPut has read them from Whop.',
      ),
    ).toBeTruthy();
  });

  it('syncs now on demand in Integrations, then reads the members and the sources again', async () => {
    const run = (ran: boolean): { status: number; body: SyncRun } => ({
      status: 200,
      body: {
        ...syncStatus({ lastSyncAt: '2026-10-01T11:00:00.000Z' }).body,
        ran,
        calls: ran ? 3 : 0,
      },
    });
    const calls = mockApi({
      ...dashboard(),
      'POST /api/creator/biz_A1/sync': [run(true), run(false)],
      '/api/creator/biz_A1/members': [
        { status: 200, body: NOBODY },
        { status: 200, body: MEMBERS },
      ],
      '/api/creator/biz_A1/integrations?lang=en': [
        { status: 200, body: INTEGRATIONS },
        { status: 200, body: INTEGRATIONS },
      ],
    });
    renderAt('/dashboard/biz_A1/sources');
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c === '/api/creator/biz_A1/members')).toHaveLength(2),
    );
    expect(headersOf.get('POST /api/creator/biz_A1/sync')?.get('x-stayput-csrf')).toBe('1');
    // « Sync now » reads Discord too: the sources are read again with the members.
    await vi.waitFor(() =>
      expect(calls.filter((c) => c === '/api/creator/biz_A1/integrations?lang=en')).toHaveLength(2),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(
      await screen.findByText('A synchronization just ran. Try again in a minute.'),
    ).toBeTruthy();
  });

  it('names the data StayPut could not read, and why', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/sync': [
        syncStatus({
          streams: [
            {
              stream: 'messages:chat_1',
              backfillDone: false,
              inProgress: false,
              lastPassAt: null,
              error: '403 missing permission chat:read',
            },
            {
              stream: 'messages:chat_2',
              backfillDone: false,
              inProgress: false,
              lastPassAt: null,
              error: '403 missing permission chat:read',
            },
            {
              stream: 'payments',
              backfillDone: false,
              inProgress: true,
              lastPassAt: null,
              error: '503 unavailable',
            },
          ],
        }),
      ],
    });
    renderAt('/dashboard/biz_A1/sources', 'fr');
    expect(
      await screen.findByText("Messages : la permission n'est pas accordée dans Whop."),
    ).toBeTruthy();
    expect(screen.getByText("Paiements : Whop n'a pas répondu. StayPut réessaiera.")).toBeTruthy();
    expect(
      screen.getByText(
        'Dans Whop, ouvrez Settings → Authorized apps, approuvez les permissions de StayPut, puis revenez ici.',
      ),
    ).toBeTruthy();
    expect(
      screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Messages')),
    ).toHaveLength(1);
  });

  it('speaks French', async () => {
    onOct1();
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/members/mber_3': [{ status: 200, body: DETAIL_BRUNO }],
    });
    renderAt('/dashboard/biz_A1/members?member=mber_3', 'fr');
    expect(await screen.findByRole('heading', { name: 'Membres', level: 1 })).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');
    // The sections and the tabs in French too.
    const menu = screen.getByRole('navigation', { name: 'Rubriques du tableau de bord' });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'Tableau de bord',
      'Membres',
      'Automatisations',
      'Analyses',
      'Intégrations',
      'Réglages',
    ]);
    // Each tab with how many members it holds, once they are read.
    await vi.waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Onglets : Membres' }))
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Tous les membres5', 'Ne pas contacter0']),
    );
    // Bruno's drawer: why, in French.
    const drawer = await screen.findByRole('dialog', { name: 'Bruno Petit' });
    expect(within(drawer).getByRole('img', { name: 'Risque élevé · 78' })).toBeTruthy();
    expect(within(drawer).getByRole('region', { name: 'Pourquoi' }).textContent).toBe(
      'PourquoiAucune activité depuis 21 joursDernière leçon terminée : « 3. Charts », il y a 25 jours',
    );
    expect(within(drawer).getByRole('switch', { name: 'Ne pas contacter' })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Fermer' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The table in French: the columns, the states, the amounts.
    const table = screen.getByRole('table', { name: 'Tous les membres' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Membre',
      'Risque',
      'Statut',
      'MRR',
      'Dernière activité',
      'Prochain renouvellement',
      'Ne pas contacter',
    ]);
    const unnamed = screen.getByRole('row', { name: /Membre sans nom/ });
    expect(
      within(unnamed)
        .getAllByRole('cell')
        .slice(2, 6)
        .map((cell) => cell.textContent),
    ).toEqual(['UrgentSur le départ', '49,00\u00a0$/mois', 'Jamais', 'Fin le 20 oct.']);
    expect(
      within(screen.getByRole('row', { name: /Bruno Petit/ }))
        .getAllByRole('cell')
        .slice(2, 5)
        .map((cell) => cell.textContent),
    ).toEqual(['Inactif', '49,00\u00a0$/mois', 'il y a 3 semaines']);
  });

  it('tells a non-admin the dashboard is for the team', async () => {
    mockApi({
      '/api/creator/biz_A1/session': [
        { status: 403, body: { error: { code: 'forbidden', message: 'team only' } } },
      ],
    });
    renderAt('/dashboard/biz_A1');
    expect(
      await screen.findByText('Only the team of this community can open this dashboard.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('lists the members on the « do not contact » list in their own tab, in the same table', async () => {
    onOct1();
    mockApi(
      dashboard({
        ...MEMBERS,
        members: MEMBERS.members.map((m) =>
          m.name === 'Alice Martin' ? { ...m, doNotContact: true } : m,
        ),
      }),
    );
    renderAt('/dashboard/biz_A1/members/never-contact');
    const table = await screen.findByRole('table', { name: 'Do not contact' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByRole('button', { name: 'Open Alice Martin' })).toBeTruthy();
    expect(within(rows[0]!).getAllByRole('cell').at(-1)!.textContent).toBe('Do not contact');
    // The tab's title is not said again inside it (brief v4 §9.1).
    expect(screen.queryByRole('heading', { name: 'Do not contact' })).toBeNull();
    await vi.waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Members tabs' }))
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['All members5', 'Do not contact1']),
    );
    cleanup();
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members/never-contact');
    expect(
      await screen.findByText(
        'No member is on this list. Open a member in All members to add them.',
      ),
    ).toBeTruthy();
  });

  it('opens a section’s first tab for an address it does not know', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members/unknown');
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeTruthy();
    await vi.waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Members tabs' }))
          .getByRole('link', { name: /^All members/ })
          .getAttribute('aria-current'),
      ).toBe('page'),
    );
  });

  it('keeps the member space out of V1: no section, no settings tab, its addresses lead away', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/space');
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
    cleanup();
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/settings/space');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Settings tabs' }))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['General', 'Risk score', 'Automations']);
    expect(await screen.findByRole('radiogroup', { name: 'Language' })).toBeTruthy();
  });

  it('offers to try again after a network failure, and succeeds', async () => {
    mockApi({ '/api/creator/biz_A1/session': [new TypeError('offline'), creatorSession] });
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
  });
});

describe('activity sources', () => {
  const connected: IntegrationsStatus = {
    ...INTEGRATIONS,
    discord: {
      ...INTEGRATIONS.discord,
      servers: [
        {
          guildId: '910000000000000001',
          name: 'Le Club',
          connectedAt: '2026-09-30T10:00:00.000Z',
          channels: [
            {
              id: '920000000000000001',
              backfillDone: true,
              lastReadAt: '2026-10-01T09:00:00.000Z',
              error: null,
            },
            {
              id: '920000000000000003',
              backfillDone: false,
              lastReadAt: null,
              error: '403 Missing Access',
            },
          ],
        },
      ],
      linkedMembers: 12,
      unlinkedAuthors: 3,
    },
    telegram: {
      ...INTEGRATIONS.telegram,
      groups: [
        {
          chatId: '-1009000000001',
          title: 'VIP',
          connectedAt: '2026-09-30T10:00:00.000Z',
          active: true,
          lastMessageAt: null,
        },
      ],
    },
  };

  const NO_ACCOUNTS: AccountsView = { unlinked: [], linked: [], dismissed: [] };
  const NOBODY_THERE: PeopleView = {
    places: [],
    total: 0,
    totals: { discord: 0, telegram: 0 },
    people: [],
  };
  /** The same answer, `count` times: the reads of a block, then its reloads. */
  const times = (count: number, body: unknown) =>
    Array.from({ length: count }, () => ({ status: 200, body }));
  /** The people card's reads: the first, then after news, changes and its own polling. */
  const PEOPLE_READS = (count: number, view: PeopleView = NOBODY_THERE) => times(count, view);
  /** What arrives, read every 10 seconds: the dashboard's « new message » mark. */
  const ACTIVITY: PlatformActivityView = {
    from: '2026-09-02',
    to: '2026-10-01',
    platforms: [
      {
        platform: 'discord',
        messages: 14,
        authors: 3,
        members: 2,
        team: 1,
        guests: 0,
        unlinked: 0,
        lastAt: '2026-10-01T09:00:00.000Z',
        daily: [...Array<number>(27).fill(0), 2, 0, 12],
      },
      {
        platform: 'telegram',
        messages: 3,
        authors: 1,
        members: 1,
        team: 0,
        guests: 0,
        unlinked: 0,
        lastAt: '2026-09-30T08:00:00.000Z',
        daily: [...Array<number>(28).fill(0), 3, 0],
      },
    ],
    places: [],
    topMembers: [],
  };
  const READ_ACTIVITY = (count: number) => times(count, ACTIVITY);
  /** The 30 days counted, Sep 2 to Oct 1. */
  const DAYS = Array.from({ length: 30 }, (_, i) =>
    new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10),
  );
  const ALICE = { id: 'mber_1', name: 'Alice Martin', score: 3, level: 'low' } as const;
  const BRUNO = { id: 'mber_3', name: 'Bruno Petit', score: 78, level: 'high' } as const;
  const DENIS = { id: 'mber_4', name: 'Denis Moreau', score: 52, level: 'medium' } as const;
  /**
   * Discord over 30 days: 14 messages, 2 on Sep 29 and 12 on Oct 1, all in #general; Alice and
   * Bruno wrote these 7 days, Denis went silent. Four scores, one of them gone quiet on Discord.
   */
  const DISCORD_VIEW: PlatformDashboard = {
    platform: 'discord',
    from: DAYS[0]!,
    to: DAYS[29]!,
    hero: { activeMembers7d: 2, silentMembers7d: 1, messages30d: 14, memberMessages30d: 11 },
    daily: DAYS.map((day, i) => ({
      day,
      messages: i === 27 ? 2 : i === 29 ? 12 : 0,
      members: i === 27 ? 2 : i === 29 ? 9 : 0,
      atRisk: i === 29 ? 1 : 0,
    })),
    heatmap: [
      { dow: 2, hour: 9, messages: 10, members: 2 },
      { dow: 4, hour: 21, messages: 4, members: 1 },
    ],
    places: [
      {
        id: '920000000000000001',
        kind: 'channel',
        name: 'general',
        parent: 'Le Club',
        messages: 14,
        members: 2,
        lastAt: '2026-10-01T09:00:00.000Z',
        top: [
          { id: 'mber_1', name: 'Alice Martin', messages: 8 },
          { id: 'mber_3', name: 'Bruno Petit', messages: 3 },
        ],
      },
      {
        id: '920000000000000002',
        kind: 'channel',
        name: 'wins',
        parent: 'Le Club',
        messages: 0,
        members: 0,
        lastAt: null,
        top: [],
      },
    ],
    active: {
      d7: [
        { ...ALICE, messages: 8, lastAt: '2026-10-01T09:00:00.000Z' },
        { ...BRUNO, messages: 3, lastAt: '2026-09-29T18:00:00.000Z' },
      ],
      d14: [
        { ...ALICE, messages: 8, lastAt: '2026-10-01T09:00:00.000Z' },
        { ...BRUNO, messages: 3, lastAt: '2026-09-29T18:00:00.000Z' },
      ],
      d30: [
        { ...ALICE, messages: 8, lastAt: '2026-10-01T09:00:00.000Z' },
        { ...BRUNO, messages: 3, lastAt: '2026-09-29T18:00:00.000Z' },
      ],
    },
    silent: {
      d7: { total: 1, members: [{ ...DENIS, messages: 6, lastAt: '2026-09-12T10:00:00.000Z' }] },
      d14: { total: 1, members: [{ ...DENIS, messages: 6, lastAt: '2026-09-12T10:00:00.000Z' }] },
      d30: { total: 0, members: [] },
    },
    signals: {
      settings: { discord: DEFAULT_PLATFORM_SIGNALS, telegram: DEFAULT_PLATFORM_SIGNALS },
      mediumFrom: 40,
      highFrom: 70,
      // Alice 3, Denis 52 and another member 62 gone quiet on Discord, Bruno 78.
      groups: [
        [3, 0, 0, 0, 1],
        [52, 1, 0, 0, 1],
        [62, 1, 0, 0, 1],
        [78, 0, 0, 0, 1],
      ],
    },
  };
  /** Telegram: one group, its « General » and a topic; 3 messages by Alice. */
  const TELEGRAM_VIEW: PlatformDashboard = {
    ...DISCORD_VIEW,
    platform: 'telegram',
    hero: { activeMembers7d: 1, silentMembers7d: 0, messages30d: 3, memberMessages30d: 3 },
    daily: DAYS.map((day, i) => ({
      day,
      messages: i === 28 ? 3 : 0,
      members: i === 28 ? 3 : 0,
      atRisk: 0,
    })),
    heatmap: [{ dow: 3, hour: 8, messages: 3, members: 1 }],
    places: [
      {
        id: '-1009000000001:2',
        kind: 'topic',
        name: 'Signals',
        parent: 'VIP',
        messages: 2,
        members: 1,
        lastAt: '2026-09-30T08:00:00.000Z',
        top: [{ id: 'mber_1', name: 'Alice Martin', messages: 2 }],
      },
      {
        id: '-1009000000001:',
        kind: 'general',
        name: 'VIP',
        parent: null,
        messages: 1,
        members: 1,
        lastAt: '2026-09-30T07:00:00.000Z',
        top: [{ id: 'mber_1', name: 'Alice Martin', messages: 1 }],
      },
    ],
    active: {
      d7: [{ ...ALICE, messages: 3, lastAt: '2026-09-30T08:00:00.000Z' }],
      d14: [{ ...ALICE, messages: 3, lastAt: '2026-09-30T08:00:00.000Z' }],
      d30: [{ ...ALICE, messages: 3, lastAt: '2026-09-30T08:00:00.000Z' }],
    },
    silent: {
      d7: { total: 0, members: [] },
      d14: { total: 0, members: [] },
      d30: { total: 0, members: [] },
    },
  };
  /**
   * The reads of a platform's tab: its dashboard, what arrives, the accounts to tie and everyone
   * there (`reads` of each: the first, then those after news or a change).
   */
  const platformPage = (
    platform: 'discord' | 'telegram',
    { reads = 3, people = NOBODY_THERE }: { reads?: number; people?: PeopleView } = {},
  ) => ({
    [`/api/creator/biz_A1/platforms/${platform}`]: times(
      reads,
      platform === 'discord' ? DISCORD_VIEW : TELEGRAM_VIEW,
    ),
    'POST /api/creator/biz_A1/platform-activity/refresh': READ_ACTIVITY(reads),
    '/api/creator/biz_A1/accounts': times(reads, NO_ACCOUNTS),
    '/api/creator/biz_A1/people': PEOPLE_READS(reads * 2, people),
  });

  /** The three figures of the platform's hero, once drawn. */
  const heroFigures = () =>
    heroFiguresOf(document.querySelector<HTMLElement>('[data-hero="platform"]')!);

  it('gives Discord a dashboard of its own: connection, figures, days, hours, channels, members', async () => {
    mockApi({ ...dashboard(MEMBERS, connected), ...platformPage('discord') });
    renderAt('/dashboard/biz_A1/sources/discord');
    // A channel the bot cannot read: the connection needs the creator, and says what to do.
    const hero = (await screen.findByText('Needs your attention')).closest<HTMLElement>(
      '[data-hero]',
    )!;
    expect(hero.getAttribute('data-connection')).toBe('problem');
    expect(within(hero).getByText(/^1 channel refused: give StayPut’s role/)).toBeTruthy();
    await vi.waitFor(() => expect(heroFigures()).toEqual(['2', '1', '14']));
    // The 30 days, and when the community writes: said and tabled for screen readers.
    expect(
      within(screen.getByRole('table', { name: 'Messages per day' })).getAllByRole('row'),
    ).toHaveLength(31);
    expect(screen.getByText('The busiest hour: Tuesday at 9 AM, 10 messages.')).toBeTruthy();
    expect(document.querySelector('[data-cell="2:9"]')?.getAttribute('data-step')).toBe('5');
    expect(document.querySelector('[data-cell="4:21"]')?.getAttribute('data-step')).toBe('2');
    expect(document.querySelector('[data-cell="1:0"]')?.getAttribute('data-step')).toBe('0');
    // Each channel: its messages and members, its three most active; one server, no name.
    const general = document.querySelector('[data-place="920000000000000001"]')!;
    expect(general.textContent).toContain('#general');
    expect(general.textContent).toContain('Most active here: Alice Martin 8 · Bruno Petit 3');
    expect(general.textContent).not.toContain('Le Club');
    expect(document.querySelector('[data-place="920000000000000002"]')!.textContent).toContain(
      'No message there over this period.',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Name' }));
    expect(
      Array.from(document.querySelectorAll('[data-place]')).map((p) =>
        p.getAttribute('data-place'),
      ),
    ).toEqual(['920000000000000001', '920000000000000002']);
    // The most active and who went silent, each with their ring.
    const active = document.querySelector<HTMLElement>('[data-list="active"]')!;
    expect(within(active).getByText('Alice Martin')).toBeTruthy();
    expect(within(active).getByText('8 messages')).toBeTruthy();
    const silent = document.querySelector<HTMLElement>('[data-list="silent"]')!;
    expect(within(silent).getByText('Denis Moreau')).toBeTruthy();
    expect(within(silent).getByText(/^Last message \d+ days ago$/)).toBeTruthy();
    expect(within(silent).getByRole('img', { name: 'Medium risk · 52' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    expect(
      within(silent).getByText('Nobody went silent: every member who wrote here still does.'),
    ).toBeTruthy();
    // Who is who, everyone there, and the bot: what it can see, and the channel to fix.
    expect(screen.getByRole('region', { name: 'Discord accounts' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Everyone on Discord' })).toBeTruthy();
    const checks = document.querySelector<HTMLElement>('[data-checks="discord"]')!;
    expect(within(checks).getByText('StayPut’s bot is set up')).toBeTruthy();
    expect(within(checks).getByText('Reads 1 channel')).toBeTruthy();
    expect(checks.querySelector('[data-check="refused"]')?.getAttribute('data-state')).toBe(
      'problem',
    );
    expect(
      screen.getByText('StayPut never reads what members write: only who wrote, where and when.'),
    ).toBeTruthy();
  });

  it('picks a day on the chart: its channels and who wrote, until « Back to 30 days »', async () => {
    const day: PlatformDayView = {
      day: '2026-09-29',
      messages: 2,
      places: [
        {
          ...DISCORD_VIEW.places[0]!,
          messages: 2,
          members: 2,
          top: [
            { id: 'mber_3', name: 'Bruno Petit', messages: 1 },
            { id: 'mber_1', name: 'Alice Martin', messages: 1 },
          ],
        },
      ],
      active: [
        { ...BRUNO, messages: 1, lastAt: '2026-09-29T18:00:00.000Z' },
        { ...ALICE, messages: 1, lastAt: '2026-09-29T09:00:00.000Z' },
      ],
    };
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('discord'),
      '/api/creator/biz_A1/platforms/discord/days/2026-09-29': [{ status: 200, body: day }],
    });
    renderAt('/dashboard/biz_A1/sources/discord');
    const chart = await screen.findByRole('group', { name: 'Messages per day' });
    // From today, two days back with the arrows, then Enter.
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    fireEvent.keyDown(chart, { key: 'Enter' });
    expect(await screen.findAllByText('Showing Tuesday, September 29')).toHaveLength(2);
    expect(calls).toContain('/api/creator/biz_A1/platforms/discord/days/2026-09-29');
    expect(document.querySelector('[data-place="920000000000000001"]')!.textContent).toContain(
      'Most active here: Bruno Petit 1 · Alice Martin 1',
    );
    // A channel nobody wrote in that day is not listed.
    expect(document.querySelector('[data-place="920000000000000002"]')).toBeNull();
    const active = () => document.querySelector<HTMLElement>('[data-list="active"]')!;
    expect(within(active()).getAllByText('1 message')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to 30 days' })[0]!);
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(within(active()).getByText('8 messages')).toBeTruthy();
  });

  it('lists who wrote in an hour of the heatmap, and how much the others wrote', async () => {
    const slot: PlatformSlotView = {
      dow: 2,
      hour: 9,
      messages: 10,
      others: 1,
      members: [
        { ...ALICE, messages: 6, lastAt: '2026-09-29T09:20:00.000Z' },
        { ...BRUNO, messages: 3, lastAt: '2026-09-22T09:40:00.000Z' },
      ],
    };
    mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('discord'),
      '/api/creator/biz_A1/platforms/discord/slots/2/9': [{ status: 200, body: slot }],
    });
    renderAt('/dashboard/biz_A1/sources/discord');
    expect(await screen.findByText('Click an hour to see who wrote then.')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-cell="2:9"]')!);
    expect(await screen.findByText('Tuesday, 9 AM to 10 AM')).toBeTruthy();
    const picked = document.querySelector<HTMLElement>('[data-slot="2/9"]')!;
    expect(await within(picked).findByText('Alice Martin')).toBeTruthy();
    expect(within(picked).getByText('Bruno Petit')).toBeTruthy();
    expect(
      within(picked).getByText('+ 1 message from your team, guests or accounts not tied yet'),
    ).toBeTruthy();
    fireEvent.click(within(picked).getByRole('button', { name: 'Close' }));
    expect(document.querySelector('[data-slot]')).toBeNull();
    expect(screen.getByText('Click an hour to see who wrote then.')).toBeTruthy();
  });

  it('previews what a signal does to the levels before saving it, then saves it', async () => {
    const quiet = { ...DEFAULT_PLATFORM_SIGNALS, silent: { on: true, points: 10 } };
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('discord'),
      'PUT /api/creator/biz_A1/platforms/discord/signals': [
        { status: 200, body: { settings: { discord: quiet, telegram: DEFAULT_PLATFORM_SIGNALS } } },
      ],
      '/api/creator/biz_A1/members': times(3, MEMBERS),
    });
    renderAt('/dashboard/biz_A1/sources/discord');
    const toggle = await screen.findByRole('switch', { name: 'Gone quiet' });
    expect(within(toggle.closest('li')!).getByText('2 members now')).toBeTruthy();
    expect(screen.getByText('No member changes level with these settings.')).toBeTruthy();
    const points = screen.getByRole<HTMLInputElement>('slider', {
      name: /^Points of “Gone quiet”/,
    });
    expect(points.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Save the signals' })).toHaveProperty(
      'disabled',
      true,
    );
    // On, +10 points: the score at 62 crosses 70; the one at 52 stays medium.
    fireEvent.click(toggle);
    expect(screen.getByText('High risk: 1 → 2 · Medium risk: 2 → 1')).toBeTruthy();
    fireEvent.change(points, { target: { value: '20' } });
    expect(screen.getByText('High risk: 1 → 3 · Medium risk: 2 → 0')).toBeTruthy();
    fireEvent.change(points, { target: { value: '10' } });
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save the signals' }));
    expect(await screen.findByText('Signals saved')).toBeTruthy();
    const put = 'PUT /api/creator/biz_A1/platforms/discord/signals';
    expect(bodies.get(put)).toEqual(quiet);
    expect(headersOf.get(put)?.get('x-stayput-csrf')).toBe('1');
    // Every score is due again: the dashboard and the members are read again.
    await vi.waitFor(() => {
      expect(calls.filter((c) => c === '/api/creator/biz_A1/platforms/discord')).toHaveLength(2);
      expect(calls.filter((c) => c === '/api/creator/biz_A1/members').length).toBeGreaterThan(1);
    });
  });

  it('tests the connection: a message written meanwhile shows within seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    try {
      const arrived: PlatformActivityView = {
        ...ACTIVITY,
        platforms: ACTIVITY.platforms.map((p) =>
          p.platform === 'discord' ? { ...p, messages: 15, lastAt: '2026-10-01T12:00:02.000Z' } : p,
        ),
      };
      mockApi({
        ...dashboard(MEMBERS, connected),
        ...platformPage('discord'),
        'POST /api/creator/biz_A1/platform-activity/refresh': [
          { status: 200, body: ACTIVITY },
          ...times(5, arrived),
        ],
        '/api/creator/biz_A1/integrations?lang=en': times(4, connected),
      });
      renderAt('/dashboard/biz_A1/sources/discord');
      const start = await screen.findByRole('button', { name: 'Start the test' });
      await vi.waitFor(() => expect(heroFigures()).toEqual(['2', '1', '14']));
      fireEvent.click(start);
      expect(screen.getByText('Waiting for a message…')).toBeTruthy();
      // Read every 3 seconds meanwhile, not 10: the message shows, its time only.
      await vi.advanceTimersByTimeAsync(3_100);
      expect(await screen.findByText(/^Received: a message at \d{1,2}:\d{2}/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Test again' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says within 5 seconds that a block takes long, with « Retry », never « Loading… »', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockApi({
        ...dashboard(MEMBERS, connected),
        ...platformPage('discord'),
        '/api/creator/biz_A1/platforms/discord': ['never', { status: 200, body: DISCORD_VIEW }],
      });
      renderAt('/dashboard/biz_A1/sources/discord');
      await screen.findByRole('button', { name: 'Start the test' });
      expect(screen.queryByText('This is taking longer than usual.')).toBeNull();
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await screen.findByText('This is taking longer than usual.')).toBeTruthy();
      expect(screen.queryByText('Loading…')).toBeNull();
      // One error for the blocks that share the reading: no empty card, no figure skeleton.
      expect(screen.queryByRole('heading', { name: 'Channels' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await vi.waitFor(() => expect(heroFigures()).toEqual(['2', '1', '14']));
      expect(screen.getByRole('heading', { name: 'Channels' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the former Activity tab to Discord, or to Telegram when only a group is connected', async () => {
    mockApi({ ...dashboard(MEMBERS, connected), ...platformPage('discord') });
    renderAt('/dashboard/biz_A1/sources/activity');
    expect(await screen.findByRole('heading', { name: 'Channels' })).toBeTruthy();
    cleanup();
    const groupOnly: IntegrationsStatus = {
      ...connected,
      discord: { ...connected.discord, servers: [] },
    };
    mockApi({ ...dashboard(MEMBERS, groupOnly), ...platformPage('telegram') });
    renderAt('/dashboard/biz_A1/sources/activity');
    expect(await screen.findByRole('heading', { name: 'Groups and topics' })).toBeTruthy();
    // Its topics by name, « General » for what is outside them; one group, said once above.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-place="-1009000000001:2"]')?.textContent).toContain(
        'Signals',
      ),
    );
    expect(document.querySelector('[data-place="-1009000000001:"]')!.textContent).toContain(
      'General',
    );
    expect(document.querySelector('[data-places]')!.textContent).not.toContain('VIP ›');
  });

  it('ties an account to a member in one click, from what StayPut suggests', async () => {
    const alice = {
      platform: 'telegram',
      accountId: '5550009',
      name: 'Alice',
      username: 'alice_m',
      member: { id: 'mber_1', name: 'Alice Martin' },
      via: 'name',
    } satisfies AccountsView['linked'][number];
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('telegram'),
      '/api/creator/biz_A1/accounts': [
        {
          status: 200,
          body: {
            unlinked: [
              {
                platform: 'telegram',
                accountId: '5550001',
                name: 'Bruno',
                username: 'bruno_p',
                messages: 2,
                lastAt: '2026-10-01T09:00:00.000Z',
                suggestions: [{ memberId: 'mber_3', name: 'Bruno Petit', strong: false }],
              },
            ],
            linked: [alice],
            dismissed: [],
          } satisfies AccountsView,
        },
      ],
      'POST /api/creator/biz_A1/accounts/link': [
        {
          status: 200,
          body: {
            unlinked: [],
            linked: [
              alice,
              {
                platform: 'telegram',
                accountId: '5550001',
                name: 'Bruno',
                username: 'bruno_p',
                member: { id: 'mber_3', name: 'Bruno Petit' },
                via: 'creator',
              },
            ],
            dismissed: [],
          } satisfies AccountsView,
        },
      ],
      '/api/creator/biz_A1/integrations?lang=en': [
        { status: 200, body: connected },
        { status: 200, body: connected },
      ],
      '/api/creator/biz_A1/members': [
        { status: 200, body: MEMBERS },
        { status: 200, body: MEMBERS },
      ],
    });
    renderAt('/dashboard/biz_A1/sources/telegram');
    expect(await screen.findByText('To tie (1)')).toBeTruthy();
    expect(screen.getByText('@bruno_p')).toBeTruthy();
    expect(screen.getByText(/2 messages waiting/)).toBeTruthy();
    expect(screen.getByText('Tied (1)')).toBeTruthy();
    // Alice was recognized by her name; any member can be picked from the list.
    expect(screen.getByText('same name')).toBeTruthy();
    expect(
      within(screen.getByRole('combobox', { name: 'Another member:' })).getByRole('option', {
        name: 'Chloé Dubois',
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tie to Bruno Petit' }));
    expect(await screen.findByText('Every account is tied to a member.')).toBeTruthy();
    const post = 'POST /api/creator/biz_A1/accounts/link';
    expect(bodies.get(post)).toEqual({
      platform: 'telegram',
      accountId: '5550001',
      memberId: 'mber_3',
    });
    expect(headersOf.get(post)?.get('x-stayput-csrf')).toBe('1');
    expect(screen.getByText('by you')).toBeTruthy();
    // The counts of the sources and the group's dashboard are read again.
    await vi.waitFor(() => {
      expect(calls.filter((c) => c === '/api/creator/biz_A1/integrations?lang=en')).toHaveLength(2);
      expect(calls.filter((c) => c === '/api/creator/biz_A1/platforms/telegram')).toHaveLength(2);
    });
  });

  it('ties each platform’s accounts under its own tab, in « Who is who »', async () => {
    // The founder, 2 October: since the tabs, the accounts to tie were only at the bottom of
    // Activity, while the Discord and Telegram tabs said « tie the others below ».
    const kev = {
      platform: 'discord',
      accountId: '940000000000000009',
      name: 'Kev',
      username: 'kev.trades',
      messages: 14,
      lastAt: '2026-10-01T09:00:00.000Z',
      suggestions: [{ memberId: 'mber_3', name: 'Bruno Petit', strong: false }],
    } satisfies AccountsView['unlinked'][number];
    const bruno = {
      platform: 'telegram',
      accountId: '5550001',
      name: 'Bruno',
      username: 'bruno_p',
      messages: 2,
      lastAt: '2026-10-01T08:00:00.000Z',
      suggestions: [],
    } satisfies AccountsView['unlinked'][number];
    const both: AccountsView = { unlinked: [kev, bruno], linked: [], dismissed: [] };
    mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('discord'),
      ...platformPage('telegram'),
      '/api/creator/biz_A1/platforms/discord': times(3, DISCORD_VIEW),
      '/api/creator/biz_A1/accounts': [
        { status: 200, body: both },
        { status: 200, body: both },
      ],
      'POST /api/creator/biz_A1/accounts/link': [
        {
          status: 200,
          body: {
            unlinked: [bruno],
            linked: [
              {
                platform: 'discord',
                accountId: kev.accountId,
                name: 'Kev',
                username: 'kev.trades',
                member: { id: 'mber_3', name: 'Bruno Petit' },
                via: 'creator',
              },
            ],
            dismissed: [],
          } satisfies AccountsView,
        },
      ],
      '/api/creator/biz_A1/integrations?lang=en': [
        { status: 200, body: connected },
        { status: 200, body: connected },
      ],
      '/api/creator/biz_A1/members': [
        { status: 200, body: MEMBERS },
        { status: 200, body: MEMBERS },
      ],
    });
    renderAt('/dashboard/biz_A1/sources/discord');
    // Under « Who is who », Discord's accounts only; the bot's card says where they are.
    const discord = await screen.findByRole('region', { name: 'Discord accounts' });
    expect(screen.getByText(/tie the others under “Who is who”/)).toBeTruthy();
    expect(await within(discord).findByText('To tie (1)')).toBeTruthy();
    expect(within(discord).getByText('@kev.trades')).toBeTruthy();
    expect(within(discord).queryByText('@bruno_p')).toBeNull();
    fireEvent.click(within(discord).getByRole('button', { name: 'Tie to Bruno Petit' }));
    expect(await within(discord).findByText('Every account is tied to a member.')).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/accounts/link')).toEqual({
      platform: 'discord',
      accountId: kev.accountId,
      memberId: 'mber_3',
    });
    expect(within(discord).getByText('Tied (1)')).toBeTruthy();

    // Telegram's tab: its own account, tied from there too.
    fireEvent.click(screen.getByRole('link', { name: 'Telegram' }));
    const telegram = await screen.findByRole('region', { name: 'Telegram accounts' });
    expect(await within(telegram).findByText('@bruno_p')).toBeTruthy();
    expect(within(telegram).queryByText('@kev.trades')).toBeNull();
    expect(within(telegram).getByRole('combobox', { name: 'Another member:' })).toBeTruthy();
  });

  it('sets the creator’s own account aside as the team’s, and brings it back', async () => {
    const mine = {
      platform: 'telegram',
      accountId: '5550002',
      name: 'Mexico 17',
      username: null,
    } as const;
    const waiting = { ...mine, messages: 2, lastAt: '2026-10-01T09:00:00.000Z', suggestions: [] };
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('telegram'),
      '/api/creator/biz_A1/accounts': [
        { status: 200, body: { unlinked: [waiting], linked: [], dismissed: [] } },
      ],
      'POST /api/creator/biz_A1/accounts/dismiss': [
        {
          status: 200,
          body: {
            unlinked: [],
            linked: [],
            dismissed: [{ ...mine, as: 'team', at: '2026-10-01T10:00:00.000Z' }],
          } satisfies AccountsView,
        },
      ],
      'POST /api/creator/biz_A1/accounts/restore': [
        { status: 200, body: { unlinked: [waiting], linked: [], dismissed: [] } },
      ],
      '/api/creator/biz_A1/integrations?lang=en': Array.from({ length: 3 }, () => ({
        status: 200,
        body: connected,
      })),
      '/api/creator/biz_A1/members': Array.from({ length: 3 }, () => ({
        status: 200,
        body: MEMBERS,
      })),
    });
    renderAt('/dashboard/biz_A1/sources/telegram');
    expect(await screen.findByText(/Your own account, or a teammate’s\?/)).toBeTruthy();
    // Only Whop members can be tied: someone invited to Discord alone is not in the list.
    expect(screen.getByText(/Only someone who joined your community on Whop/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'It’s me / my team' }));
    const setAside = await screen.findByText('Set aside (1)');
    expect(bodies.get('POST /api/creator/biz_A1/accounts/dismiss')).toEqual({
      platform: 'telegram',
      accountId: '5550002',
      as: 'team',
    });
    fireEvent.click(setAside);
    expect(screen.getByText('Team')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bring back' }));
    expect(await screen.findByText('To tie (1)')).toBeTruthy();
    expect(calls).toContain('POST /api/creator/biz_A1/accounts/restore');
  });

  it('shows new messages without reloading the page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const later: PlatformActivityView = {
        ...ACTIVITY,
        platforms: ACTIVITY.platforms.map((p) =>
          p.platform === 'telegram'
            ? {
                ...p,
                messages: 4,
                lastAt: '2026-10-01T10:00:00.000Z',
                daily: [...p.daily.slice(0, 29), 1],
              }
            : p,
        ),
      };
      const calls = mockApi({
        ...dashboard(MEMBERS, connected),
        ...platformPage('telegram'),
        '/api/creator/biz_A1/platforms/telegram': [
          { status: 200, body: TELEGRAM_VIEW },
          {
            status: 200,
            body: {
              ...TELEGRAM_VIEW,
              hero: { ...TELEGRAM_VIEW.hero, messages30d: 4, memberMessages30d: 4 },
            },
          },
        ],
        'POST /api/creator/biz_A1/platform-activity/refresh': [
          { status: 200, body: ACTIVITY },
          { status: 200, body: later },
        ],
        '/api/creator/biz_A1/integrations?lang=en': times(2, connected),
      });
      renderAt('/dashboard/biz_A1/sources/telegram');
      expect(await screen.findByText('Live')).toBeTruthy();
      await vi.waitFor(() => expect(heroFigures()).toEqual(['1', '0', '3']));

      // Seconds later, a Telegram message: it shows, and what may have moved is read again.
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
      await vi.waitFor(() => expect(heroFigures()).toEqual(['1', '0', '4']));
      const reads = (path: string) => calls.filter((call) => call === path).length;
      expect(reads('POST /api/creator/biz_A1/platform-activity/refresh')).toBe(2);
      await vi.waitFor(() => expect(reads('/api/creator/biz_A1/accounts')).toBe(2));
      expect(reads('/api/creator/biz_A1/integrations?lang=en')).toBe(2);
      expect(reads('/api/creator/biz_A1/platforms/telegram')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows everyone in the group and on the server, each in its tab, not only who writes', async () => {
    const people: PeopleView = {
      places: [
        {
          platform: 'discord',
          id: '910000000000000001',
          name: 'Le Club',
          total: 12,
          known: 0,
          list: 'blocked',
        },
        {
          platform: 'telegram',
          id: '-1009000000001',
          name: 'VIP',
          total: 34,
          known: 3,
          list: 'joins',
        },
      ],
      total: 3,
      totals: { discord: 0, telegram: 3 },
      people: [
        {
          platform: 'telegram',
          accountId: '7102',
          name: 'Marc Dupont',
          username: 'marcd',
          status: 'unlinked',
          member: null,
          here: true,
          joinedAt: null,
          leftAt: null,
          messages: 2,
          lastMessageAt: '2026-10-01T09:00:00.000Z',
        },
        {
          platform: 'telegram',
          accountId: '7101',
          name: 'Léa',
          username: null,
          status: 'member',
          member: { id: 'mber_1', name: 'Léa Martin' },
          here: true,
          joinedAt: '2026-09-29T09:00:00.000Z',
          leftAt: null,
          messages: 0,
          lastMessageAt: null,
        },
        {
          platform: 'telegram',
          accountId: '7104',
          name: 'Paul',
          username: null,
          status: 'guest',
          member: null,
          here: false,
          joinedAt: '2026-09-20T09:00:00.000Z',
          leftAt: '2026-09-30T09:00:00.000Z',
          messages: 0,
          lastMessageAt: null,
        },
      ],
    };
    mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('telegram', { people }),
      '/api/creator/biz_A1/platforms/discord': times(2, DISCORD_VIEW),
    });
    renderAt('/dashboard/biz_A1/sources/telegram');
    const card = (
      await screen.findByRole('heading', { name: 'Everyone in your Telegram group' })
    ).closest('section')!;
    expect(await within(card).findByText('Marc Dupont')).toBeTruthy();
    expect(within(card).getByText(/Members in the group: 34 · StayPut knows 3/)).toBeTruthy();
    // The server is in Discord's tab, not here.
    expect(within(card).queryByText(/Discord does not give StayPut/)).toBeNull();
    expect(within(card).getByText('Not tied yet')).toBeTruthy();
    expect(within(card).getByText('Member: Léa Martin')).toBeTruthy();
    expect(within(card).getByText(/No message in 30 days · there since/)).toBeTruthy();
    expect(within(card).getByText(/left on Sep 30, 2026/)).toBeTruthy();
    // A name, accents and case aside; a platform.
    fireEvent.change(within(card).getByRole('searchbox', { name: 'Search by name' }), {
      target: { value: 'lea' },
    });
    expect(within(card).queryByText('Marc Dupont')).toBeNull();
    expect(within(card).getByText('Léa')).toBeTruthy();
    fireEvent.change(within(card).getByRole('searchbox', { name: 'Search by name' }), {
      target: { value: 'nobody' },
    });
    expect(within(card).getByText('No one matches this search.')).toBeTruthy();

    // Discord keeps its list until the application turns the Server Members Intent on.
    fireEvent.click(screen.getByRole('link', { name: 'Discord' }));
    const discord = (await screen.findByRole('heading', { name: 'Everyone on Discord' })).closest(
      'section',
    )!;
    expect(
      await within(discord).findByText(/Discord does not give StayPut the member list yet/),
    ).toBeTruthy();
    expect(
      within(discord)
        .getByRole('link', { name: /Open the Discord Developer Portal/ })
        .getAttribute('href'),
    ).toBe('https://discord.com/developers/applications');
    expect(within(discord).getByText(/Members on the server: 12/)).toBeTruthy();
    expect(within(discord).queryByText('Marc Dupont')).toBeNull();
    // The bot's check says it too.
    expect(document.querySelector('[data-check="members"]')?.getAttribute('data-state')).toBe(
      'problem',
    );
  });

  it('offers to connect Discord and Telegram, with the steps', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/sources/discord');
    const discord = await screen.findByRole('link', { name: /Add the bot to my server/ });
    expect(discord.getAttribute('href')).toBe(INTEGRATIONS.discord.install!.url);
    expect(discord.getAttribute('target')).toBe('_blank');
    expect(screen.getByText(/StayPut follows every channel it can read/)).toBeTruthy();
    // Telegram has its own tab.
    fireEvent.click(screen.getByRole('link', { name: 'Telegram' }));
    expect(
      (await screen.findByRole('link', { name: /Add the bot to a group/ })).getAttribute('href'),
    ).toBe(INTEGRATIONS.telegram.addToGroup!.url);
    expect(screen.getByText(/Members link their Telegram from StayPut/)).toBeTruthy();
  });

  it('says when the bot cannot see the messages of its groups', async () => {
    mockApi(
      dashboard(MEMBERS, {
        ...INTEGRATIONS,
        telegram: { ...INTEGRATIONS.telegram, readsAllMessages: false },
      }),
    );
    renderAt('/dashboard/biz_A1/sources/telegram');
    expect(await screen.findByText(/privacy mode is on/)).toBeTruthy();
  });

  it('asks for the links in the interface language, and says how a channel counts', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/integrations?lang=fr': [{ status: 200, body: INTEGRATIONS }],
    });
    renderAt('/dashboard/biz_A1/sources/telegram', 'fr');
    expect(await screen.findByText(/Un canal \? Seuls ses administrateurs/)).toBeTruthy();
    expect(calls).toContain('/api/creator/biz_A1/integrations?lang=fr');
    expect(calls).not.toContain('/api/creator/biz_A1/integrations?lang=en');
  });

  it('chooses the channels of a connected server, then saves them', async () => {
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('discord'),
      '/api/creator/biz_A1/discord/910000000000000001/channels': [
        {
          status: 200,
          body: [
            {
              id: '920000000000000001',
              name: 'general',
              category: null,
              readable: true,
              followed: true,
            },
            {
              id: '920000000000000002',
              name: 'wins',
              category: 'Club',
              readable: true,
              followed: false,
            },
            {
              id: '920000000000000003',
              name: 'staff',
              category: 'Club',
              readable: false,
              followed: false,
            },
          ] satisfies DiscordChannelChoice[],
        },
      ],
      'PUT /api/creator/biz_A1/discord/910000000000000001/channels': [{ status: 200, body: [] }],
      '/api/creator/biz_A1/accounts': [{ status: 200, body: NO_ACCOUNTS }],
      '/api/creator/biz_A1/integrations?lang=en': [
        { status: 200, body: connected },
        { status: 200, body: connected },
      ],
    });
    renderAt('/dashboard/biz_A1/sources/discord');
    // The server's row (« Le Club » is also the community's name, in the side menu).
    const server = (await screen.findByText(/2 channels followed/)).closest('li')!;
    expect(server.textContent).toContain('2 channels followed');
    expect(server.textContent).toContain('1 channel the bot cannot read');
    expect(screen.getByText('12 members recognized')).toBeTruthy();
    expect(screen.getByText('3 recent authors not linked to a member')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Choose channels' }));
    const wins = await screen.findByRole('checkbox', { name: /wins/ });
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /staff/ }).disabled).toBe(true);
    fireEvent.click(wins);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Choose channels' });
    await vi.waitFor(() =>
      expect(calls).toContain('PUT /api/creator/biz_A1/discord/910000000000000001/channels'),
    );
    const put = headersOf.get('PUT /api/creator/biz_A1/discord/910000000000000001/channels')!;
    expect(put.get('x-stayput-csrf')).toBe('1');
    expect(put.get('content-type')).toBe('application/json');
    expect(bodies.get('PUT /api/creator/biz_A1/discord/910000000000000001/channels')).toEqual({
      channelIds: ['920000000000000001', '920000000000000002'],
    });
  });

  it('disconnects a group after asking once more', async () => {
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
      ...platformPage('telegram'),
      'DELETE /api/creator/biz_A1/telegram/-1009000000001': [
        { status: 200, body: { removed: true } },
      ],
      '/api/creator/biz_A1/accounts': [{ status: 200, body: NO_ACCOUNTS }],
      '/api/creator/biz_A1/integrations?lang=en': [
        { status: 200, body: connected },
        { status: 200, body: INTEGRATIONS },
      ],
    });
    renderAt('/dashboard/biz_A1/sources/telegram');
    const group = (await screen.findByText('VIP')).closest('li')!;
    expect(group.textContent).toContain('Listening');
    const disconnect = Array.from(group.querySelectorAll('button')).find(
      (b) => b.textContent === 'Disconnect',
    )!;
    fireEvent.click(disconnect);
    expect(calls).not.toContain('DELETE /api/creator/biz_A1/telegram/-1009000000001');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    await vi.waitFor(() => expect(screen.queryByText('VIP')).toBeNull());
    expect(calls).toContain('DELETE /api/creator/biz_A1/telegram/-1009000000001');
  });
});

describe('analyses', () => {
  const lesson = (n: number, over: Partial<InsightsReport['lessons'][number]> = {}) => ({
    lessonId: `lesn_${n}`,
    courseId: 'cors_1',
    title: `${n}. Lesson`,
    reached: 20,
    stalled: 3,
    rate: 0.15,
    courseAverage: 0.21,
    flagged: false,
    ...over,
  });
  const REPORT: InsightsReport = {
    computedAt: '2026-09-28T07:30:00.000Z',
    cohorts: [
      {
        month: '2026-09-01',
        members: 12,
        rates: { 30: null, 60: null, 90: null },
        alertHorizon: null,
      },
      {
        month: '2026-07-01',
        members: 14,
        rates: { 30: 0.36, 60: 0.43, 90: null },
        alertHorizon: 30,
      },
      {
        month: '2026-06-01',
        members: 20,
        rates: { 30: 0.1, 60: 0.15, 90: 0.2 },
        alertHorizon: null,
      },
    ],
    averages: { 30: 0.2, 60: 0.27, 90: 0.2 },
    lessons: [
      lesson(4, {
        title: '4. Risk management',
        reached: 12,
        stalled: 7,
        rate: 0.583,
        flagged: true,
      }),
      ...[1, 2, 3, 5, 6, 7, 8, 9].map((n) => lesson(n)),
      lesson(10, { title: null }),
    ],
  };

  it('flags the months of arrival that leave faster, and the blocking lessons', async () => {
    const calls = mockApi({
      ...dashboard(),
      // Read by each tab: the cohorts, then the lessons.
      '/api/creator/biz_A1/insights': [
        { status: 200, body: REPORT },
        { status: 200, body: REPORT },
      ],
    });
    renderAt('/dashboard/biz_A1/insights/cohorts');
    expect(
      await screen.findByText(
        'Members who joined in July 2026 left 1.8 times more than your average within 30 days.',
      ),
    ).toBeTruthy();
    expect(calls).toContain('/api/creator/biz_A1/insights');
    const july = screen.getByRole('rowheader', { name: 'July 2026' }).closest('tr')!;
    expect(july.textContent).toContain('36% (Above average)');
    // The flagged month: a turquoise edge, never red (brief v4 §9.5); its curve highlighted.
    expect(july.getAttribute('data-flagged')).toBe('true');
    expect(screen.getByRole('rowheader', { name: 'July 2026' }).className).toContain(
      'border-turq-300',
    );
    expect(screen.getByRole('img', { name: 'Retention by month of arrival' })).toBeTruthy();
    expect(document.querySelectorAll('[data-chart="highlighted"]')).toHaveLength(1);
    expect(document.querySelector('.text-danger, .text-serious')).toBeNull();
    const september = screen.getByRole('rowheader', { name: 'September 2026' }).closest('tr')!;
    expect(september.textContent).toContain('Too early to tell');
    const average = screen.getByRole('rowheader', { name: 'Your average' }).closest('tr')!;
    expect(average.textContent).toBe('Your average20%27%20%');

    // The lessons have their tab.
    fireEvent.click(screen.getByRole('link', { name: 'Lessons' }));
    const blocking = (
      await screen.findByRole('rowheader', { name: /4\. Risk management/ })
    ).closest('tr')!;
    expect(blocking.textContent).toBe('4. Risk managementBlocking7 of 1258%21%');
    // Above the table, a bar per lesson (the first 8), the blocking one in turquoise.
    const bars = document.querySelectorAll('[data-lesson]');
    expect(bars).toHaveLength(8);
    expect(bars[0]!.getAttribute('data-flagged')).toBe('true');
    expect(bars[0]!.textContent).toContain('7 of 12 members stalled after it');
    // The first 8 lessons, then all of them on demand.
    expect(screen.queryByRole('rowheader', { name: 'Lesson without a title' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all (10)' }));
    expect(screen.getByRole('rowheader', { name: 'Lesson without a title' })).toBeTruthy();
  });

  it('says when the first analyses have not run yet', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/insights': [
        {
          status: 200,
          body: { ...REPORT, computedAt: null, cohorts: [], lessons: [] },
        },
      ],
    });
    renderAt('/dashboard/biz_A1/insights/cohorts', 'fr');
    expect(
      await screen.findByText(
        "Les premières analyses tournent dans l'heure qui suit la première synchronisation.",
      ),
    ).toBeTruthy();
  });
});

describe('Analytics › Overview (brief v4 §9.5)', () => {
  const OVERVIEW: InsightsOverview = {
    currency: 'USD',
    revenue: { low: 1000, medium: 200, high: 100, scheduled_departure: 50 },
    stay: { low: 0.95, medium: 0.8, high: 0.5, scheduled_departure: 0.5 },
    calibrated: [],
    saveRate: 0.3,
    saveRateObserved: false,
    reasons: [
      { reason: 'too_expensive', count: 3 },
      { reason: 'no_time', count: 1 },
    ],
    activity: Array.from({ length: 30 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 8, 2 + i)).toISOString().slice(0, 10),
      actions: i === 29 ? 12 : 4,
      members: i === 29 ? 5 : 2,
    })),
  };
  const usd = (value: number) =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

  it('forecasts the 90 days if you act and if you do nothing, and moves with the slider', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/insights/overview': [{ status: 200, body: OVERVIEW }],
    });
    renderAt('/dashboard/biz_A1/insights');
    const forecast = (
      await screen.findByRole('heading', { name: 'Your revenue over the next 90 days' })
    ).closest('section')!;
    const full = forecastRevenue({ ...OVERVIEW, reached: 1 });
    const figures = () =>
      within(forecast)
        .getAllByRole('definition')
        .map((d) => d.textContent);
    await vi.waitFor(() =>
      expect(figures()).toEqual([
        `+${usd(full.gain)}`,
        usd(full.total.act),
        usd(full.total.doNothing),
      ]),
    );
    expect(calls).toContain('/api/creator/biz_A1/insights/overview');
    expect(
      within(forecast).getByRole('group', { name: 'Monthly revenue expected, day by day' }),
    ).toBeTruthy();
    // What the figures rest on, said plainly.
    expect(forecast.textContent).toContain(
      'Each month, a member at low risk stays with a 95% chance, at medium risk 80%, at high risk 50%. Acting saves 30% of the members at risk it reaches',
    );
    expect(forecast.textContent).toContain('StayPut’s starting figures');
    // Half the members at risk reached: half the gain.
    const slider = within(forecast).getByRole('slider');
    expect(slider.getAttribute('aria-valuetext')).toBe('100% of your members at risk');
    fireEvent.change(slider, { target: { value: '50' } });
    const half = forecastRevenue({ ...OVERVIEW, reached: 0.5 });
    await vi.waitFor(() => expect(figures()[0]).toBe(`+${usd(half.gain)}`));
    expect(figures()[2]).toBe(usd(full.total.doNothing));
    expect(forecast.textContent).toContain('50% of your members at risk');
  });

  it('compares retention with the niche once the community shares its own', async () => {
    const shy: BenchmarksView = {
      optedIn: false,
      niche: 'trading',
      minimum: 5,
      horizons: [
        { days: 30, mine: 0.9, niche: null },
        { days: 60, mine: 0.8, niche: null },
        { days: 90, mine: null, niche: null },
      ],
      computedAt: null,
    };
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/insights/overview': [{ status: 200, body: OVERVIEW }],
      '/api/creator/biz_A1/benchmarks': [{ status: 200, body: shy }],
      'PUT /api/creator/biz_A1/benchmarks': [
        {
          status: 200,
          body: {
            ...shy,
            optedIn: true,
            horizons: [
              { days: 30, mine: 0.9, niche: 0.85 },
              { days: 60, mine: 0.8, niche: 0.8 },
              { days: 90, mine: null, niche: 0.7 },
            ],
            computedAt: '2026-10-05T07:30:00.000Z',
          },
        },
      ],
    });
    renderAt('/dashboard/biz_A1/insights');
    const section = (
      await screen.findByRole('heading', { name: 'Communities like yours' })
    ).closest('section')!;
    await vi.waitFor(() =>
      expect(section.textContent).toContain(
        'Share your figures to compare them with your niche’s.',
      ),
    );
    expect(section.textContent).toContain('never a name nor a community’s own figures');
    expect(within(section).queryByRole('table')).toBeNull();
    const toggle = within(section).getByRole('switch', { name: 'Share my figures anonymously' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    expect(bodies.get('PUT /api/creator/biz_A1/benchmarks')).toEqual({ optedIn: true });
    // The figures as a table for screen readers; the bars say how far apart they are.
    const rows = within(within(section).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'After 30 days90%85%',
      'After 60 days80%80%',
      'After 90 daysToo few members old enough yet70%',
    ]);
    expect(section.textContent).toContain('5 pts above');
    expect(section.textContent).toContain('Same as them');
  });

  it('says when too few communities of the niche share yet', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/insights/overview': [{ status: 200, body: OVERVIEW }],
      '/api/creator/biz_A1/benchmarks': [
        {
          status: 200,
          body: {
            optedIn: true,
            niche: 'fitness',
            minimum: 5,
            horizons: [
              { days: 30, mine: 0.9, niche: null },
              { days: 60, mine: 0.8, niche: null },
              { days: 90, mine: 0.7, niche: null },
            ],
            computedAt: null,
          } satisfies BenchmarksView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/insights', 'fr');
    expect(
      await screen.findByText(
        'Pas encore assez de communautés « Fitness » ne partagent leurs chiffres : il en faut au moins 5. Les vôtres comptent dès lundi prochain.',
      ),
    ).toBeTruthy();
  });

  it('shows why members leave as a donut, and what they did over 30 days', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/insights/overview': [{ status: 200, body: OVERVIEW }],
    });
    renderAt('/dashboard/biz_A1/insights');
    const reasons = (await screen.findByRole('heading', { name: 'Why members leave' })).closest(
      'section',
    )!;
    // The headings come at once; the figures with the answer.
    expect(await within(reasons).findByRole('img', { name: 'Reasons for leaving' })).toBeTruthy();
    expect([...reasons.querySelectorAll('[data-reason]')].map((row) => row.textContent)).toEqual([
      'Too expensive3 answers75%',
      'No time1 answer25%',
    ]);
    const activity = screen
      .getByRole('heading', { name: 'Member activity (30d)' })
      .closest('section')!;
    expect(activity.textContent).toContain('128 actions over the last 30 days');
    expect(activity.querySelectorAll('[data-bar]')).toHaveLength(30);
    // Every figure in words for screen readers: the last day, its members.
    expect(within(activity).getByRole('table').textContent).toContain(
      '12 actions · 5 members active',
    );
  });

  it('says what is missing rather than an empty chart', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/insights/overview': [
        {
          status: 200,
          body: {
            ...OVERVIEW,
            currency: null,
            revenue: { low: 0, medium: 0, high: 0, scheduled_departure: 0 },
            reasons: [],
          },
        },
      ],
    });
    renderAt('/dashboard/biz_A1/insights', 'fr');
    expect(
      await screen.findByText(
        'Aucun membre payant pour l’instant : la prévision commence avec le premier.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Aucun questionnaire de départ rempli ces 90 derniers jours.'),
    ).toBeTruthy();
    // Its tabs: the overview, the weekly analyses, then the Monday reports.
    const tabs = screen.getByRole('navigation', { name: 'Onglets : Analyses' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual([
      '/dashboard/biz_A1/insights',
      '/dashboard/biz_A1/insights/cohorts',
      '/dashboard/biz_A1/insights/lessons',
      '/dashboard/biz_A1/insights/reports',
    ]);
  });
});

describe('Analytics › Reports (SPEC Phase 6.9)', () => {
  const SENT: SentWeeklyReport = {
    weekStart: '2026-09-21',
    currency: 'USD',
    saved: { members: 2, direct: 98, influenced: 49 },
    lost: 1,
    reasons: [
      { reason: 'too_expensive', count: 2 },
      { reason: 'no_time', count: 1 },
    ],
    priority: { kind: 'retry', payments: 2, revenue: 98 },
    sentAt: '2026-09-28T06:00:04.000Z',
    failed: false,
  };
  const REFUSED: SentWeeklyReport = {
    weekStart: '2026-09-14',
    currency: 'USD',
    saved: { members: 0, direct: 0, influenced: 0 },
    lost: 0,
    reasons: [],
    priority: null,
    sentAt: null,
    failed: true,
  };
  const VIEW: WeeklyReportsView = {
    enabled: true,
    nextAt: '2026-10-05T06:00:00.000Z',
    timezone: 'Europe/Paris',
    reports: [SENT, REFUSED],
  };

  it('lists the weeks as they were sent, and turns the report off', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/reports': [{ status: 200, body: VIEW }],
      'PUT /api/creator/biz_A1/reports': [{ status: 200, body: { ...VIEW, enabled: false } }],
    });
    renderAt('/dashboard/biz_A1/insights/reports');
    expect(await screen.findByRole('heading', { name: 'Monday report' })).toBeTruthy();
    expect(
      await screen.findByText(
        'Every Monday at 8:00 (Europe/Paris), a Whop notification to your team: members saved and lost, money saved, why members left and the week’s priority.',
      ),
    ).toBeTruthy();
    // When the next one goes, on the community's clock.
    expect(screen.getByText(/^Next one: Monday, October 5 at 8:00/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Monday reports, the newest first' });
    const [sent, refused] = within(list).getAllByRole('article');
    expect(
      within(sent!).getByRole('heading', { name: 'Week of Sep 21 to Sep 27, 2026' }),
    ).toBeTruthy();
    expect(sent!.textContent).toContain('Sent Mon, Sep 28');
    expect(sent!.textContent).toContain('$98.00');
    expect(sent!.textContent).toContain('+ $49.00 influenced');
    expect(sent!.textContent).toContain('Too expensive· 2 answers');
    expect(sent!.textContent).toContain('Retry 2 failed payments: $98.00 at risk');
    expect(refused!.textContent).toContain('Not sent: Whop refused it');
    expect(refused!.textContent).toContain('No departure survey answered that week.');
    expect(refused!.textContent).toContain('Nothing urgent');

    const toggle = screen.getByRole('switch', { name: 'Send it to my team' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(bodies.get('PUT /api/creator/biz_A1/reports')).toEqual({ enabled: false });
    expect(headersOf.get('PUT /api/creator/biz_A1/reports')?.get('x-stayput-csrf')).toBe('1');
    expect(screen.queryByText(/^Next one:/)).toBeNull();
    expect(calls).toContain('PUT /api/creator/biz_A1/reports');
  });

  it('says when the first one arrives, in French too', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/reports': [{ status: 200, body: { ...VIEW, reports: [] } }],
    });
    renderAt('/dashboard/biz_A1/insights/reports', 'fr');
    expect(await screen.findByText(/^Le premier arrive lundi 5 octobre à 8:00\.$/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'L’envoyer à mon équipe' })).toBeTruthy();
  });
});

const NO_ANNOUNCEMENTS: AnnouncementsView = {
  destination: null,
  choices: [
    { platform: 'discord', id: '920000000000000101', name: '#general', place: 'Le Club' },
    { platform: 'telegram', id: '-100900', name: 'Le Club (groupe)', place: 'Telegram' },
  ],
  whopUnavailable: true,
};

const OTHER_GOALS: GoalProposalsView = {
  niche: 'other',
  custom: null,
  defaults: [
    { title: 'Finish the course', unit: '%', category: 'learning', entry: 'total' },
    { title: 'Practice regularly', unit: 'sessions', category: 'practice', entry: 'add' },
    { title: 'Move forward every week', unit: 'steps', category: 'other', entry: 'add' },
  ],
};

const TRADING_GOALS: GoalProposalsView = {
  niche: 'trading',
  custom: null,
  defaults: [
    { title: 'Reach my monthly profit target', unit: '$', category: 'income', entry: 'total' },
    { title: 'Follow my trading plan', unit: 'days', category: 'practice', entry: 'add' },
    { title: 'Improve my win rate', unit: '%', category: 'performance', entry: 'total' },
  ],
};

describe('risk settings', () => {
  const DEFAULTS: RiskSettingsView = {
    niche: 'other',
    weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
    recencyThresholdDays: 14,
    mediumFrom: 40,
    highFrom: 70,
  };
  const TRADING: RiskSettingsView = {
    niche: 'trading',
    weights: { recency: 0.35, frequency: 0.3, progress: 0.1, payment: 0.15, friction: 0.1 },
    recencyThresholdDays: 7,
    mediumFrom: 40,
    highFrom: 70,
  };
  const settings = (answers: Record<string, Answer[]> = {}) =>
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/risk': [{ status: 200, body: DEFAULTS }],
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
      '/api/creator/biz_A1/goals?lang=en&niche=other': [{ status: 200, body: OTHER_GOALS }],
      '/api/creator/biz_A1/goals?lang=fr&niche=other': [{ status: 200, body: OTHER_GOALS }],
      '/api/creator/biz_A1/goals?lang=en&niche=trading': [{ status: 200, body: TRADING_GOALS }],
      '/api/creator/biz_A1/earned-days': [
        { status: 200, body: { enabled: false, at50: 3, at100: 7 } },
      ],
      '/api/creator/biz_A1/announcements': [{ status: 200, body: NO_ANNOUNCEMENTS }],
      '/api/creator/biz_A1/buddies': [
        {
          status: 200,
          body: {
            enabled: false,
            activePairs: 0,
            waitingNewcomers: 2,
            veterans: 0,
            mentors: 0,
          } satisfies BuddiesView,
        },
      ],
      '/api/creator/biz_A1/rescues': [
        {
          status: 200,
          body: { enabled: false, open: 0, rescuedLast30: 0, rescuers: 0 } satisfies RescuesView,
        },
      ],
      ...answers,
    });
  const share = (name: string) =>
    screen.getByRole('slider', { name }).closest('div')!.querySelector('output')!.textContent;

  it('proposes the goals of the niche saved to members', async () => {
    spaceOn();
    const calls = settings({
      // Read by each tab that needs it: the goals, the score, the goals again.
      '/api/creator/biz_A1/settings/risk': [
        { status: 200, body: DEFAULTS },
        { status: 200, body: DEFAULTS },
        { status: 200, body: TRADING },
      ],
      'PUT /api/creator/biz_A1/settings/risk': [{ status: 200, body: TRADING }],
    });
    renderAt('/dashboard/biz_A1/settings/space');
    expect(await screen.findByText('Finish the course')).toBeTruthy();
    expect(screen.getByText('StayPut’s goals for Other, in each member’s language.')).toBeTruthy();
    // The niche is saved in the Risk score tab; the Member space tab proposes its goals.
    const tabs = screen.getByRole('navigation', { name: 'Settings tabs' });
    fireEvent.click(within(tabs).getByRole('link', { name: 'Risk score' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Your niche' }), {
      target: { value: 'trading' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls).toContain('PUT /api/creator/biz_A1/settings/risk'));
    fireEvent.click(within(tabs).getByRole('link', { name: 'Member space' }));
    expect(await screen.findByText('Follow my trading plan')).toBeTruthy();
    expect(calls).toContain('/api/creator/biz_A1/goals?lang=en&niche=trading');
  });

  it('lets the creator write their own goals, and go back to StayPut’s', async () => {
    spaceOn();
    const own = [
      { title: 'Finish the course', unit: '%', category: 'learning', entry: 'total' },
      { title: 'Book 3 calls', unit: 'calls', category: 'clients', entry: 'add' },
    ] satisfies GoalProposalsView['defaults'];
    const calls = settings({
      'PUT /api/creator/biz_A1/goals?lang=en': [
        { status: 200, body: { ...OTHER_GOALS, custom: own } },
        { status: 200, body: OTHER_GOALS },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/space');
    fireEvent.click(await screen.findByRole('button', { name: 'Write my own' }));
    // StayPut's three, to change: the second and third go, one of the creator's comes.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Move forward every week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Practice regularly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a goal' }));
    const titles = screen.getAllByRole('textbox', { name: 'Goal' });
    const units = screen.getAllByRole('textbox', { name: 'Unit' });
    // A goal without a unit is refused.
    fireEvent.change(titles[1]!, { target: { value: 'Book 3 calls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the goals' }));
    expect(await screen.findByText('Each goal needs a title and a unit.')).toBeTruthy();
    fireEvent.change(units[1]!, { target: { value: 'calls' } });
    fireEvent.change(screen.getAllByRole('combobox', { name: 'Kind' })[1]!, {
      target: { value: 'clients' },
    });
    fireEvent.change(screen.getAllByRole('combobox', { name: 'Results' })[1]!, {
      target: { value: 'add' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save the goals' }));
    expect(await screen.findByText('Saved')).toBeTruthy();
    expect(bodies.get('PUT /api/creator/biz_A1/goals?lang=en')).toEqual({ proposals: own });
    expect(screen.getByText('Your own goals, as you wrote them.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back to StayPut’s goals' }));
    await vi.waitFor(() =>
      expect(bodies.get('PUT /api/creator/biz_A1/goals?lang=en')).toEqual({ proposals: null }),
    );
    expect(await screen.findByRole('button', { name: 'Write my own' })).toBeTruthy();
    expect(calls.filter((c) => c === 'PUT /api/creator/biz_A1/goals?lang=en')).toHaveLength(2);
  });

  it('turns the earned days on, with the creator’s numbers', async () => {
    spaceOn();
    settings({
      'PUT /api/creator/biz_A1/earned-days': [
        { status: 200, body: { enabled: true, at50: 5, at100: 7 } },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/space');
    const save = await screen.findByRole('button', { name: 'Save the earned days' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Offer free days at milestones' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Days at 50%' }), {
      target: { value: '15' },
    });
    expect(screen.getByText('From 0 to 14 days.')).toBeTruthy();
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Days at 50%' }), {
      target: { value: '5' },
    });
    fireEvent.click(save);
    expect(await screen.findByText('Saved', { selector: 'span' })).toBeTruthy();
    expect(bodies.get('PUT /api/creator/biz_A1/earned-days')).toEqual({
      enabled: true,
      at50: 5,
      at100: 7,
    });
  });

  it('turns the buddies on, and says when no veteran can take a newcomer yet', async () => {
    spaceOn();
    settings({
      'PUT /api/creator/biz_A1/buddies': [
        {
          status: 200,
          body: {
            enabled: true,
            activePairs: 0,
            waitingNewcomers: 2,
            veterans: 0,
            mentors: 0,
          } satisfies BuddiesView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/space');
    const save = await screen.findByRole('button', { name: 'Save the buddies' });
    expect(screen.getByText('2 newcomers waiting')).toBeTruthy();
    expect(screen.getByText('0 veterans available')).toBeTruthy();
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pair each newcomer with a veteran' }));
    expect(screen.getByText(/No member can be a veteran yet/)).toBeTruthy();
    fireEvent.click(save);
    expect(await screen.findByText('Buddies saved.')).toBeTruthy();
    expect(bodies.get('PUT /api/creator/biz_A1/buddies')).toEqual({ enabled: true });
  });

  it('turns the rescue challenges on', async () => {
    spaceOn();
    settings({
      'PUT /api/creator/biz_A1/rescues': [
        {
          status: 200,
          body: { enabled: true, open: 2, rescuedLast30: 0, rescuers: 0 } satisfies RescuesView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/space');
    const save = await screen.findByRole('button', { name: 'Save the challenges' });
    expect(screen.getByText('0 open challenges')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show rescue challenges to members' }));
    fireEvent.click(save);
    expect(await screen.findByText('Challenges saved.')).toBeTruthy();
    expect(screen.getByText('2 open challenges')).toBeTruthy();
    expect(bodies.get('PUT /api/creator/biz_A1/rescues')).toEqual({ enabled: true });
  });

  it('picks where the milestones are announced, among the places StayPut can post in', async () => {
    spaceOn();
    settings({
      'PUT /api/creator/biz_A1/announcements': [
        {
          status: 200,
          body: {
            ...NO_ANNOUNCEMENTS,
            destination: NO_ANNOUNCEMENTS.choices[0]!,
          } satisfies AnnouncementsView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/space');
    const where = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Where' });
    expect([...where.options].map((o) => o.textContent)).toEqual([
      'Nowhere (off)',
      '#general · Le Club',
      'Le Club (groupe)',
    ]);
    expect(screen.getByText(/Whop’s chats do not show/)).toBeTruthy();
    fireEvent.change(where, { target: { value: 'discord:920000000000000101' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save where' }));
    expect(await screen.findByText('Saved', { selector: 'span' })).toBeTruthy();
    expect(bodies.get('PUT /api/creator/biz_A1/announcements')).toEqual({
      destination: { platform: 'discord', id: '920000000000000101' },
    });
  });

  it('applies a niche, shows what each sign weighs, then saves', async () => {
    const calls = settings({
      'PUT /api/creator/biz_A1/settings/risk': [{ status: 200, body: TRADING }],
    });
    renderAt('/dashboard/biz_A1/settings/risk');
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    expect(share('Recency')).toBe('30%');

    fireEvent.change(screen.getByRole('combobox', { name: 'Your niche' }), {
      target: { value: 'trading' },
    });
    expect(share('Recency')).toBe('35%');
    expect(
      screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Recency threshold' }).value,
    ).toBe('7');
    fireEvent.click(save);
    expect(await screen.findByText('Saved. The scores are being recomputed.')).toBeTruthy();
    expect(calls).toContain('PUT /api/creator/biz_A1/settings/risk');
    expect(headersOf.get('PUT /api/creator/biz_A1/settings/risk')?.get('x-stayput-csrf')).toBe('1');
    expect(bodies.get('PUT /api/creator/biz_A1/settings/risk')).toEqual(TRADING);
    expect(save.hasAttribute('disabled')).toBe(true);
  });

  it('brings the weights back to 100% as they move', async () => {
    settings();
    renderAt('/dashboard/biz_A1/settings/risk');
    const payment = await screen.findByRole('slider', { name: 'Payment' });
    fireEvent.change(payment, { target: { value: '0' } });
    // 30 + 25 + 20 + 0 + 10 = 85 points: recency weighs 30 / 85.
    expect(share('Payment')).toBe('0%');
    expect(share('Recency')).toBe('35%');
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('refuses levels in the wrong order, and a recency out of range', async () => {
    settings();
    renderAt('/dashboard/biz_A1/settings/risk');
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Medium risk from' }), {
      target: { value: '80' },
    });
    expect(screen.getByText('High risk has to start above medium risk.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Medium risk from' }), {
      target: { value: '30' },
    });
    expect(screen.getByText('Low risk: 0 to 29')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Recency threshold' }), {
      target: { value: '120' },
    });
    expect(screen.getByText('A whole number of days, from 1 to 90.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('says when saving did not work', async () => {
    settings({
      'PUT /api/creator/biz_A1/settings/risk': [
        { status: 500, body: { error: { code: 'internal', message: 'boom' } } },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/risk', 'fr');
    fireEvent.change(await screen.findByRole('combobox', { name: 'Votre niche' }), {
      target: { value: 'fitness' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText("Cela n'a pas marché. Réessayez.")).toBeTruthy();
  });
});

describe('back from Discord', () => {
  it('says the server is connected, and that the tab can be closed', async () => {
    renderAt('/connected?source=discord&status=ok&name=Le%20Club&channels=2');
    expect(await screen.findByRole('heading', { name: 'Discord is connected' })).toBeTruthy();
    expect(
      screen.getByText('"Le Club": 2 channels followed. The last 90 days are being read.'),
    ).toBeTruthy();
    expect(screen.getByText(/You can close this tab/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Back to StayPut/ })).toBeNull();
  });

  it('offers the way back when signed in to StayPut outside Whop', async () => {
    renderAt('/connected?source=discord&status=ok&name=Le%20Club&channels=2&company=biz_A1', 'fr');
    expect(
      (await screen.findByRole('link', { name: /Revenir à StayPut/ })).getAttribute('href'),
    ).toBe('/dashboard/biz_A1/sources/discord');
    expect(screen.getByText(/Ou fermez cet onglet/)).toBeTruthy();
    cleanup();
    // Never a link built from anything but a company id.
    renderAt('/connected?source=discord&status=ok&company=https://evil.example');
    expect(await screen.findByRole('heading', { name: 'Discord is connected' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Back to StayPut/ })).toBeNull();
  });

  it('says why it did not work', async () => {
    renderAt('/connected?source=discord&status=failed&reason=expired', 'fr');
    expect(await screen.findByRole('heading', { name: "Discord n'est pas connecté" })).toBeTruthy();
    expect(screen.getByText(/Ce lien a expiré/)).toBeTruthy();
  });
});

describe('signing in with Whop outside the iframe (sandbox)', () => {
  const outside = (login?: string) => ({
    status: 401,
    body: { error: { code: 'unauthenticated', message: 'no token', ...(login ? { login } : {}) } },
  });

  it('offers to sign in, then to come back to the same page', async () => {
    mockApi({ '/api/creator/biz_A1/session': [outside('/auth/login')] });
    renderAt('/dashboard/biz_A1?tab=members');
    const link = await screen.findByRole('link', { name: 'Sign in with Whop' });
    expect(link.getAttribute('href')).toBe(
      '/auth/login?next=%2Fdashboard%2Fbiz_A1%3Ftab%3Dmembers',
    );
    expect(
      screen.getByText(
        'You opened StayPut outside Whop: sign in with your Whop account to continue.',
      ),
    ).toBeTruthy();
  });

  it('says when signing in did not work, and offers it again', async () => {
    mockApi({ '/api/creator/biz_A1/session': [outside('/auth/login')] });
    renderAt('/dashboard/biz_A1?login=failed', 'fr');
    expect(
      await screen.findByText("La connexion avec Whop n'a pas abouti. Réessayez."),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Se connecter avec Whop' });
    expect(link.getAttribute('href')).toBe('/auth/login?next=%2Fdashboard%2Fbiz_A1');
  });

  it('keeps the inside-Whop message where signing in outside is off (production)', async () => {
    mockApi({ '/api/creator/biz_A1/session': [outside()] });
    renderAt('/dashboard/biz_A1');
    expect(await screen.findByText('Open StayPut from Whop to sign in.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with Whop' })).toBeNull();
  });

  it('offers to sign out only to someone who signed in that way', async () => {
    mockApi({
      '/api/creator/biz_A1/session': [
        { status: 200, body: { ...creatorSession.body, via: 'login' } },
        creatorSession,
      ],
    });
    renderAt('/dashboard/biz_A1');
    const signOut = await screen.findByRole('link', { name: 'Sign out' });
    expect(signOut.getAttribute('href')).toBe('/auth/logout');
    cleanup();
    renderAt('/dashboard/biz_A1');
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign out' })).toBeNull();
  });
});

describe('the member space in the dashboard', () => {
  beforeEach(spaceOn);
  const card: TestimonialCard = {
    proofId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    resultId: '5f0c3e1a-9b2d-4e8f-a1c3-d5e7f9b1c3d5',
    level: 'justified',
    url: 'https://stayput.example/v/7c9e6679-7425-40de-944b-e07fc1f90ae7',
    display: {
      community: 'Le Club',
      locale: 'en',
      goal: 'Reach 3,000 € a month',
      unit: '€',
      entry: 'total',
      start: 0,
      target: 3000,
      value: 1650,
      progress: 55,
      recordedAt: '2026-09-30T10:00:00.000Z',
      day: '2026-09-30',
      publishedAt: '2026-10-02T01:42:00.000Z',
      name: 'Léa Moreau',
      affiliateUrl: null,
    },
  };
  const overview: SpaceOverview = {
    goals: { active: 3, achieved: 1 },
    results: { last30: 12, justified30: 4, members30: 3 },
    opens30: 7,
    badges30: 9,
    cards: { online: 8, latest: [card] },
    buddies: { enabled: true, activePairs: 2 },
    rescues: { enabled: false, open: 0, rescuedLast30: 0 },
    whopAppId: 'app_stayput',
  };
  const preview: MemberSpaceView = {
    preview: true,
    known: false,
    goal: null,
    results: [],
    badges: [],
    proposals: [{ title: 'Train regularly', unit: 'sessions', category: 'practice', entry: 'add' }],
    fresh: [],
    rewards: { offered: null, received: [] },
    announce: null,
    cards: [],
    whopAppId: 'app_stayput',
    buddies: { optedOut: false, partners: [] },
    rescues: null,
  };
  const survey: MemberRetentionView = {
    creatorName: 'Le Club',
    whopAppId: 'app_stayput',
    alumniUrl: null,
    preview: { offers: ACTION_SETTINGS.offers, testMode: false },
    payment: null,
    departure: null,
    alumni: null,
    creatorOffer: null,
    locale: 'en',
  };

  it('shows the member space in three tabs: its figures, the cards online, the member view', async () => {
    // A canvas that answers: the card is drawn as members shared it.
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          font: '',
          measureText: (text: string) => ({ width: text.length * 20 }),
          fillText: vi.fn(),
          fillRect: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          arcTo: vi.fn(),
          closePath: vi.fn(),
          fill: vi.fn(),
        }) as never,
    );
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,QUJD');
    try {
      const calls = mockApi({
        ...dashboard(),
        // Read by each tab that shows it: the overview, then the cards.
        '/api/creator/biz_A1/space': [
          { status: 200, body: overview },
          { status: 200, body: overview },
        ],
        '/api/creator/biz_A1/preview/retention': [{ status: 200, body: survey }],
        '/api/creator/biz_A1/preview/space?lang=en': [{ status: 200, body: preview }],
      });
      renderAt('/dashboard/biz_A1/space');
      expect(await screen.findByText('Goals under way')).toBeTruthy();
      const menu = screen.getByRole('navigation', { name: 'Dashboard sections' });
      expect(
        within(menu).getByRole('link', { name: 'Member space' }).getAttribute('aria-current'),
      ).toBe('page');
      expect(screen.getByText('1 goal reached')).toBeTruthy();
      expect(screen.getByText('4 backed by a screenshot')).toBeTruthy();
      expect(screen.getByText('3 noted a result')).toBeTruthy();
      // Members helping members: the buddies on, the challenges off, and where to set them.
      expect(screen.getByText('2 pairs under way')).toBeTruthy();
      expect(screen.getByText('Off')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Set them in Settings' }).getAttribute('href')).toBe(
        '/dashboard/biz_A1/settings/space',
      );

      // The cards online, drawn with their QR code, and the way to their page.
      const tabs = screen.getByRole('navigation', { name: 'Member space tabs' });
      fireEvent.click(within(tabs).getByRole('link', { name: 'Testimonials' }));
      const image = await screen.findByRole('img', {
        name: 'Testimonial card: Reach 3,000 € a month, 55% of the goal',
      });
      expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD');
      expect(screen.getByText('And 7 more online.')).toBeTruthy();
      // « See the page » shows the real public page inside StayPut, in a window that closes:
      // looking at it never leaves Whop.
      fireEvent.click(screen.getByRole('button', { name: 'See the page' }));
      const pageWindow = screen.getByRole('dialog', { name: 'The card’s public page' });
      expect(
        within(pageWindow)
          .getByTitle('Public page of the card: Reach 3,000 € a month')
          .getAttribute('src'),
      ).toBe('/v/7c9e6679-7425-40de-944b-e07fc1f90ae7');
      expect(
        within(pageWindow)
          .getByRole('link', { name: /Open in a new tab/ })
          .getAttribute('href'),
      ).toBe(card.url);
      fireEvent.click(within(pageWindow).getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      // Beside it, a QR code made to be scanned on the screen: whole pixels per module.
      const qr = screen.getByRole('img', {
        name: 'QR code of the card’s page: Reach 3,000 € a month',
      });
      const side = Number(qr.getAttribute('width'));
      const modules = Number(qr.getAttribute('viewBox')!.split(' ')[2]);
      expect(side).toBeGreaterThanOrEqual(220);
      expect(side % modules).toBe(0);
      expect(screen.getByText('Scan it with your phone: the card’s page opens.')).toBeTruthy();
      // The team never takes a member’s card down.
      expect(screen.queryByRole('button', { name: /Take the page down/ })).toBeNull();

      // Their space, to try: the survey and the goals, nothing sent.
      fireEvent.click(within(tabs).getByRole('link', { name: 'Member view' }));
      expect(await screen.findByText('What your members see')).toBeTruthy();
      expect(await screen.findByText('Train regularly')).toBeTruthy();
      expect(calls).toContain('/api/creator/biz_A1/preview/space?lang=en');
      expect(calls.filter((call) => !call.startsWith('/'))).toEqual([]);
    } finally {
      getContext.mockRestore();
      toDataURL.mockRestore();
    }
  });

  it('says how a card comes when none is online yet', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/space': [
        { status: 200, body: { ...overview, cards: { online: 0, latest: [] } } },
      ],
      '/api/creator/biz_A1/preview/retention': [{ status: 200, body: survey }],
      '/api/creator/biz_A1/preview/space?lang=en': [{ status: 200, body: preview }],
    });
    renderAt('/dashboard/biz_A1/space/cards');
    expect(
      await screen.findByText(
        'No card yet. A member makes theirs in their space, from one of their results.',
      ),
    ).toBeTruthy();
  });
});

describe('member view, without a member space (2026-10-08)', () => {
  it('tells a member there is nothing to do here, in the community’s language', async () => {
    const calls = mockApi({
      '/api/member/exp_E1/home': [{ status: 200, body: { dashboard: null, locale: 'fr' } }],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByText('Rien à faire ici')).toBeTruthy();
    expect(
      screen.getByText('Les messages de votre communauté vous arrivent dans son chat de support.'),
    ).toBeTruthy();
    // No survey, no offer, no payment, no Telegram: nothing of a space.
    expect(screen.queryByRole('button')).toBeNull();
    expect(calls).toEqual(['/api/member/exp_E1/home']);
  });

  it('takes the team from their community straight to their dashboard', async () => {
    mockApi({
      ...dashboard(),
      '/api/member/exp_E1/home': [
        { status: 200, body: { dashboard: '/dashboard/biz_A1', locale: 'en' } },
      ],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
    expect(screen.queryByText('Nothing to do here')).toBeNull();
  });

  it('says when Whop could not answer, with « Retry », never « nothing to do » to the team', async () => {
    mockApi({
      ...dashboard(),
      '/api/member/exp_E1/home': [
        { status: 503, body: { error: { code: 'whop_unavailable', message: 'down' } } },
        { status: 200, body: { dashboard: '/dashboard/biz_A1', locale: 'en' } },
      ],
    });
    renderAt('/experiences/exp_E1');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(screen.queryByText('Nothing to do here')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
  });
});

describe('member view (with the member space)', () => {
  // The member view is the member space's: off in V1, these tests turn it on.
  beforeEach(spaceOn);
  const memberSession = {
    status: 200,
    body: { experienceId: 'exp_E1', userId: 'user_m', accessLevel: 'customer', via: 'login' },
  };
  const retention = (over: Partial<MemberRetentionView> = {}) => ({
    status: 200,
    body: {
      creatorName: 'Le Club',
      whopAppId: 'app_stayput',
      alumniUrl: null,
      preview: null,
      payment: null,
      departure: null,
      alumni: null,
      creatorOffer: null,
      locale: 'en',
      ...over,
    } satisfies MemberRetentionView,
  });
  const leaving = (over: Partial<NonNullable<MemberRetentionView['departure']>> = {}) =>
    retention({
      departure: {
        endsAt: '2026-10-20T12:00:00.000Z',
        reason: null,
        offer: null,
        outcome: 'pending',
        result: null,
        ...over,
      },
    });
  const telegram = (over: Partial<MemberTelegramStatus>) => ({
    status: 200,
    body: {
      available: true,
      linked: false,
      link: { url: 'https://t.me/StayPutBot?start=tok', expiresAt: '2026-10-01T13:00:00.000Z' },
      whopAppId: 'app_stayput',
      ...over,
    } satisfies MemberTelegramStatus,
  });

  it('gives every member the privacy policy, in their community’s language', async () => {
    legalOn();
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [retention({ locale: 'fr' })],
      '/api/member/exp_E1/telegram?lang=fr': [telegram({ available: false, link: null })],
    });
    renderAt('/experiences/exp_E1');
    fireEvent.click(await screen.findByRole('button', { name: 'Confidentialité' }));
    const dialog = await screen.findByRole('dialog', { name: 'Politique de confidentialité' });
    expect(
      within(dialog).getByTitle('Politique de confidentialité, la page').getAttribute('src'),
    ).toBe('/privacy?lang=fr&view=app');
  });

  it('offers to link Telegram when the community counts a group, then to unlink it', async () => {
    const calls = mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [retention(), retention()],
      '/api/member/exp_E1/telegram?lang=en': [telegram({}), telegram({ linked: true, link: null })],
      'DELETE /api/member/exp_E1/telegram': [{ status: 200, body: { removed: true } }],
    });
    renderAt('/experiences/exp_E1');
    const link = await screen.findByRole('link', { name: /Link my Telegram/ });
    expect(link.getAttribute('href')).toBe('https://t.me/StayPutBot?start=tok');

    // Back from Telegram: the card reads the status again.
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText('Linked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, unlink' }));
    await vi.waitFor(() => expect(calls).toContain('DELETE /api/member/exp_E1/telegram'));
  });

  it('gives a member who reached their goal their affiliate link, when Whop has one', async () => {
    const accepted = leaving({
      reason: 'goal_reached',
      offer: { type: 'affiliate_invite', keep: 'never' },
      outcome: 'accepted',
      result: { status: 'applied' },
    });
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [accepted],
      '/api/member/exp_E1/telegram?lang=en': [telegram({ available: false, link: null })],
      '/api/member/exp_E1/retention/affiliate': [
        { status: 200, body: { url: 'https://whop.com/le-club/?a=lina' } },
      ],
    });
    renderAt('/experiences/exp_E1');
    expect(
      await screen.findByText(
        'Your affiliate link is ready: share it, every sign-up through it counts for you.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('https://whop.com/le-club/?a=lina')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('tells the member the details will come when Whop gives no affiliate link', async () => {
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [
        leaving({
          reason: 'goal_reached',
          offer: { type: 'affiliate_invite', keep: 'never' },
          outcome: 'accepted',
          result: { status: 'applied' },
        }),
      ],
      '/api/member/exp_E1/telegram?lang=en': [telegram({ available: false, link: null })],
      '/api/member/exp_E1/retention/affiliate': [{ status: 200, body: { url: null } }],
    });
    renderAt('/experiences/exp_E1');
    expect(
      await screen.findByText(
        'Thank you! You will soon get the details to recommend the community.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('asks a leaving member why, and makes the offer for their reason', async () => {
    const calls = mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [leaving()],
      '/api/member/exp_E1/telegram?lang=en': [telegram({ available: false, link: null })],
      'POST /api/member/exp_E1/retention/survey': [
        leaving({ reason: 'no_time', offer: { type: 'pause_offer', days: 30, keep: 'required' } }),
        leaving({
          reason: 'too_expensive',
          offer: { type: 'promo_offer', percentOff: 20, months: 3, keep: 'required' },
        }),
      ],
      'POST /api/member/exp_E1/retention/offer': [
        leaving({
          reason: 'too_expensive',
          offer: { type: 'promo_offer', percentOff: 20, months: 3, keep: 'required' },
          outcome: 'accepted',
          result: { status: 'applied', kept: true, promoApplied: true },
        }),
      ],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByText('Your membership is ending')).toBeTruthy();
    expect(screen.getByText('Your access stays open until Oct 20, 2026.')).toBeTruthy();
    const reasons = screen.getByRole('group', { name: 'Why are you leaving?' });
    expect(
      within(reasons)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'It’s too expensive',
      'I don’t have the time',
      'I’m not getting the results I expected',
      'I reached my goal',
      'Another reason',
    ]);
    fireEvent.click(within(reasons).getByRole('button', { name: 'I don’t have the time' }));
    expect(await screen.findByText('Take a 30-day break instead')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/retention/survey')).toEqual({ reason: 'no_time' });
    expect(headersOf.get('POST /api/member/exp_E1/retention/survey')?.get('x-stayput-csrf')).toBe(
      '1',
    );
    // A pause only with the member's consent to keep their membership.
    const pause = screen.getByRole('button', { name: 'Pause my membership' });
    expect(pause.hasAttribute('disabled')).toBe(true);
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I keep my membership: my cancellation is withdrawn.' }),
    );
    expect(pause.hasAttribute('disabled')).toBe(false);

    // The member changes their answer: too expensive, a discount on the membership, which has
    // to continue: their consent again, and no code to type.
    fireEvent.click(screen.getByRole('button', { name: 'Change my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'It’s too expensive' }));
    expect(await screen.findByText('20% off for 3 months')).toBeTruthy();
    expect(
      screen.getByText(
        'Your membership continues, and the discount comes off your next payments by itself: no code to type.',
      ),
    ).toBeTruthy();
    const discount = screen.getByRole('button', { name: 'Take the discount' });
    expect(discount.hasAttribute('disabled')).toBe(true);
    const consent = screen.getByRole('checkbox', {
      name: 'I keep my membership: my cancellation is withdrawn.',
    });
    expect(
      screen.getByText(
        'Needed for a discount: it comes off the payments of a membership that continues.',
      ),
    ).toBeTruthy();
    fireEvent.click(consent);
    fireEvent.click(discount);
    expect(await screen.findByText('Done: 20% off your next 3 payments.')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/retention/offer')).toEqual({
      accept: true,
      keep: true,
    });
    expect(
      screen.getByText('Your membership continues: your cancellation is withdrawn.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(3);
  });

  it('tells a member what came of their answer, and where to settle a payment', async () => {
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [
        retention({
          payment: {
            kind: 'failed',
            amount: 49,
            currency: 'eur',
            url: 'https://whop.com/manage/mem_1',
          },
          departure: {
            endsAt: null,
            reason: 'other',
            offer: { type: 'extend_offer', days: 7, keep: 'optional' },
            outcome: 'accepted',
            result: { status: 'waiting' },
          },
        }),
      ],
      '/api/member/exp_E1/telegram?lang=en': [telegram({ available: false, link: null })],
    });
    renderAt('/experiences/exp_E1');
    const update = await screen.findByRole('link', { name: /Update my payment method/ });
    expect(update.getAttribute('href')).toBe('https://whop.com/manage/mem_1');
    expect(
      screen.getByText(
        'Your last payment of €49.00 did not go through. Update your payment method to keep your access.',
      ),
    ).toBeTruthy();
    // Manual mode: the creator approves the offer first.
    expect(
      screen.getByText(
        'Noted! Your offer is being prepared: it will show here once it is applied.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Why are you leaving?' })).toBeNull();
  });

  it('shows the team what members see, with the creator’s offers, recording nothing', async () => {
    const calls = mockApi({
      '/api/member/exp_E1/session': [
        { status: 200, body: { ...memberSession.body, accessLevel: 'admin' } },
      ],
      '/api/member/exp_E1/retention': [
        retention({
          preview: {
            offers: {
              pauseDays: 45,
              promoPercent: 20,
              promoMonths: 1,
              extendDays: 1,
              coachingMessage: 'Écris-moi, je te réponds.',
            },
            testMode: true,
          },
        }),
      ],
      '/api/member/exp_E1/telegram?lang=en': [telegram({ available: false, link: null })],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByText('What your members see')).toBeTruthy();
    expect(
      screen.getByText('Test mode is on: your members do not see the survey yet.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'I don’t have the time' }));
    expect(screen.getByText('Take a 45-day break instead')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change my answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'I’m not getting the results I expected' }));
    expect(screen.getByText('Écris-moi, je te réponds.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change my answer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Another reason' }));
    expect(screen.getByText('1 day on us')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take the free days' }));
    expect(
      screen.getByText('Preview: nothing was applied. A member would see the result here.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try another answer' }));
    expect(screen.getByRole('group', { name: 'Why are you leaving?' })).toBeTruthy();
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([]);
    // Folded away on this device, and back; the mark at the top leads nowhere (no dead end).
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByRole('group', { name: 'Why are you leaving?' })).toBeNull();
    expect(
      screen.getByText('Hidden on this device. Your members always see what concerns them.'),
    ).toBeTruthy();
    expect(window.localStorage.getItem('stayput.memberPreview.folded')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Show the preview' }));
    expect(screen.getByRole('group', { name: 'Why are you leaving?' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'StayPut' })).toBeNull();
  });

  it('speaks to a French member in their language', async () => {
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [
        retention({
          locale: 'fr',
          alumniUrl: 'https://whop.com/checkout/plan_Alumni',
          payment: {
            kind: 'action_required',
            amount: 49,
            currency: 'eur',
            url: 'https://whop.com/checkout/3ds',
          },
          departure: {
            endsAt: '2026-10-20T12:00:00.000Z',
            reason: 'too_expensive',
            offer: { type: 'promo_offer', percentOff: 20, months: 3, keep: 'required' },
            outcome: 'pending',
            result: null,
          },
        }),
      ],
      '/api/member/exp_E1/telegram?lang=fr': [telegram({ available: false, link: null })],
    });
    // The interface is in English here: the member reads the community's language all the same.
    renderAt('/experiences/exp_E1');
    expect(await screen.findByRole('link', { name: /Valider mon paiement/ })).toBeTruthy();
    // Leaving all the same: the free Alumni keeps them in touch.
    expect(screen.getByRole('link', { name: /Rejoindre l’Alumni/ }).getAttribute('href')).toBe(
      'https://whop.com/checkout/plan_Alumni',
    );
    expect(screen.getByText('Votre réponse : C’est trop cher')).toBeTruthy();
    expect(screen.getByText('20 % de réduction pendant 3 mois')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Non merci' })).toBeTruthy();
  });

  it('gives a former member in the Alumni their return code, and the way back', async () => {
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [
        retention({
          locale: 'fr',
          alumni: {
            code: {
              code: 'STAY-K7QM2XPA',
              percentOff: 20,
              months: 3,
              expiresAt: '2026-10-08T17:00:00.000Z',
            },
            returnUrl: 'https://whop.com/checkout/plan_Club',
          },
        }),
      ],
      '/api/member/exp_E1/telegram?lang=fr': [telegram({ available: false, link: null })],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByText('Bienvenue dans l’Alumni')).toBeTruthy();
    expect(screen.getByText('20 % de réduction pendant 3 mois')).toBeTruthy();
    expect(screen.getByText('STAY-K7QM2XPA')).toBeTruthy();
    expect(screen.getByText('Saisissez-le au moment du paiement.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /Revenir dans la communauté/ }).getAttribute('href'),
    ).toBe('https://whop.com/checkout/plan_Club');
  });

  it('explains a refused access in member words', async () => {
    mockApi({
      '/api/member/exp_E1/session': [
        { status: 403, body: { error: { code: 'forbidden', message: 'no access' } } },
      ],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByText('You do not have access to this space.')).toBeTruthy();
  });
});

describe('member space', () => {
  beforeEach(spaceOn);
  const memberSession = {
    status: 200,
    body: { experienceId: 'exp_E1', userId: 'user_m', accessLevel: 'customer', via: 'iframe' },
  };
  const noRetention = {
    status: 200,
    body: {
      creatorName: 'Le Club',
      whopAppId: 'app_stayput',
      alumniUrl: null,
      preview: null,
      payment: null,
      departure: null,
      alumni: null,
      creatorOffer: null,
      locale: 'en',
    } satisfies MemberRetentionView,
  };
  const noTelegram = {
    status: 200,
    body: {
      available: false,
      linked: false,
      link: null,
      whopAppId: 'app_stayput',
    } satisfies MemberTelegramStatus,
  };
  const PROPOSALS: MemberSpaceView['proposals'] = [
    { title: 'Reach my target weight', unit: 'kg', category: 'body', entry: 'total' },
    { title: 'Train regularly', unit: 'sessions', category: 'practice', entry: 'add' },
  ];
  const WEIGHT = {
    id: '0b9d4c8e-3f2a-4c1d-9e8f-7a6b5c4d3e2f',
    title: 'Reach my target weight',
    category: 'body',
    unit: 'kg',
    entry: 'total',
    start: 92,
    target: 85,
    current: 92,
    progress: 0,
    targetDate: '2026-12-31',
    status: 'active',
    createdAt: '2026-10-01T08:00:00.000Z',
    milestones: [],
  } satisfies NonNullable<MemberSpaceView['goal']>;
  const space = (over: Partial<MemberSpaceView> = {}): MemberSpaceView => ({
    preview: false,
    known: true,
    goal: null,
    results: [],
    badges: [],
    proposals: PROPOSALS,
    fresh: [],
    rewards: { offered: null, received: [] },
    announce: null,
    cards: [],
    whopAppId: 'app_stayput',
    buddies: { optedOut: false, partners: [] },
    rescues: null,
    ...over,
  });
  const open = (answers: Record<string, Answer[]>, locale: Locale = 'en') => {
    const calls = mockApi({
      '/api/member/exp_E1/session': [memberSession],
      // The community's language is its members' (never their browser's).
      '/api/member/exp_E1/retention': [{ ...noRetention, body: { ...noRetention.body, locale } }],
      [`/api/member/exp_E1/telegram?lang=${locale}`]: [noTelegram],
      ...answers,
    });
    renderAt('/experiences/exp_E1', locale);
    return calls;
  };

  it('lets the member choose a goal, record a result, and celebrates the milestone', async () => {
    const after: ResultAnswer = {
      milestones: [25],
      badges: ['first_result', 'milestone_25'],
      achieved: false,
      proof: null,
      earnedDays: 0,
      space: space({
        goal: {
          ...WEIGHT,
          current: 90.25,
          progress: 25,
          milestones: [{ percent: 25, reachedAt: '2026-10-01T09:00:00.000Z' }],
        },
        results: [{ id: 'r1', value: 90.25, recordedAt: '2026-10-01T09:00:00.000Z', proof: null }],
        badges: [
          { code: 'first_result', awardedAt: '2026-10-01T09:00:00.000Z' },
          { code: 'milestone_25', awardedAt: '2026-10-01T09:00:00.000Z' },
        ],
      }),
    };
    open({
      '/api/member/exp_E1/space?lang=en': [{ status: 200, body: space() }],
      'POST /api/member/exp_E1/space/goal?lang=en': [
        { status: 200, body: space({ goal: WEIGHT }) },
      ],
      'POST /api/member/exp_E1/space/result?lang=en': [{ status: 200, body: after }],
    });
    fireEvent.click(await screen.findByRole('button', { name: /Reach my target weight/ }));
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Your goal' }).value).toBe(
      'Reach my target weight',
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Where you are today' }), {
      target: { value: '92' },
    });
    // Nothing goes without a target different from the start.
    fireEvent.change(screen.getByRole('textbox', { name: 'Your target' }), {
      target: { value: '92' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set my goal' }));
    expect(screen.getByText('Your target must differ from where you start.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Your target' }), {
      target: { value: '85' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set my goal' }));

    expect(await screen.findByRole('heading', { name: 'Reach my target weight' })).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/goal?lang=en')).toEqual({
      title: 'Reach my target weight',
      unit: 'kg',
      category: 'body',
      entry: 'total',
      start: 92,
      target: 85,
      targetDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as unknown,
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('No result yet: record your first one!')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Where are you now?' }), {
      target: { value: '90.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('Milestone reached: 25% of your goal!')).toBeTruthy();
    expect(screen.getByText('New badge: First result')).toBeTruthy();
    expect(screen.getByText('New badge: A quarter of the way')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/result?lang=en')).toEqual({
      goalId: WEIGHT.id,
      value: 90.25,
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('25% of the way')).toBeTruthy();
    expect(screen.getByText('25%, reached')).toBeTruthy();
    expect(screen.getAllByText(/^Earned /)).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Milestone reached: 25% of your goal!')).toBeNull();
  });

  it('adds one in a tap for a goal counted, with French numbers', async () => {
    const sessions = { ...WEIGHT, title: 'M’entraîner', unit: 'séances', entry: 'add' as const };
    open(
      {
        '/api/member/exp_E1/space?lang=fr': [
          { status: 200, body: space({ goal: { ...sessions, start: 0, target: 20, current: 3 } }) },
        ],
        'POST /api/member/exp_E1/space/result?lang=fr': [
          {
            status: 200,
            body: {
              milestones: [],
              badges: [],
              achieved: false,
              proof: null,
              earnedDays: 0,
              space: space({ goal: { ...sessions, start: 0, target: 20, current: 4 } }),
            } satisfies ResultAnswer,
          },
          {
            status: 200,
            body: {
              milestones: [25],
              badges: [],
              achieved: false,
              proof: null,
              earnedDays: 0,
              space: space({ goal: { ...sessions, start: 0, target: 20, current: 5.5 } }),
            } satisfies ResultAnswer,
          },
        ],
      },
      'fr',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter 1' }));
    expect(await screen.findByText('C’est noté. Continuez comme ça !')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/result?lang=fr')).toEqual({
      goalId: WEIGHT.id,
      value: 1,
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Combien de plus ?' }), {
      target: { value: '1,5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByText('Jalon atteint : 25 % de votre objectif !')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/result?lang=fr')).toEqual({
      goalId: WEIGHT.id,
      value: 1.5,
    });
  });

  it('celebrates seven days in a row on opening, and a goal reached', async () => {
    open({
      '/api/member/exp_E1/space?lang=en': [
        {
          status: 200,
          body: space({
            goal: { ...WEIGHT, current: 85, progress: 100, status: 'achieved' },
            fresh: ['streak_7_days'],
            badges: [{ code: 'streak_7_days', awardedAt: '2026-10-01T08:00:00.000Z' }],
          }),
        },
      ],
    });
    expect(await screen.findByText('New badge: 7 days in a row')).toBeTruthy();
    expect(screen.getByText('Goal reached!')).toBeTruthy();
    // The text matcher reads a no-break space as a space.
    expect(screen.getByText(/You reached 85 kg\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set a new goal' }));
    expect(screen.getByRole('button', { name: /Train regularly/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Create my own goal/ })).toBeTruthy();
  });

  it('lets a member write their own goal, counted as they add', async () => {
    open({
      '/api/member/exp_E1/space?lang=en': [{ status: 200, body: space() }],
      'POST /api/member/exp_E1/space/goal?lang=en': [
        { status: 200, body: space({ goal: { ...WEIGHT, title: 'Write 3 articles' } }) },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: /Create my own goal/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your goal' }), {
      target: { value: 'Write 3 articles' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind of goal' }), {
      target: { value: 'practice' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /What I add each time/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Unit' }), {
      target: { value: 'articles' },
    });
    // « Already done » starts at 0 for a goal counted.
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Already done' }).value).toBe('0');
    fireEvent.change(screen.getByRole('textbox', { name: 'Your target' }), {
      target: { value: '3' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set my goal' }));
    expect(await screen.findByRole('heading', { name: 'Write 3 articles' })).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/goal?lang=en')).toMatchObject({
      title: 'Write 3 articles',
      unit: 'articles',
      category: 'practice',
      entry: 'add',
      start: 0,
      target: 3,
    });
  });

  it('lets the team try the space in their browser, where nothing is recorded', async () => {
    const calls = open({
      '/api/member/exp_E1/space?lang=en': [
        { status: 200, body: space({ preview: true, known: false }) },
      ],
    });
    expect(await screen.findByText(/Nothing is recorded/)).toBeTruthy();
    expect(screen.getByText(/Your members choose their goal from this list/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Train regularly/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your target' }), {
      target: { value: '8' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set my goal' }));
    expect(await screen.findByRole('heading', { name: 'Train regularly' })).toBeTruthy();
    // 2 of 8 sessions: a quarter of the way, as StayPut would count it.
    fireEvent.change(screen.getByRole('textbox', { name: 'How many more?' }), {
      target: { value: '2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Milestone reached: 25% of your goal!')).toBeTruthy();
    expect(screen.getByText('New badge: First result')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1' }));
    expect(await screen.findByText('Recorded. Keep it up!')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('37');
    expect(calls.filter((c) => !c.startsWith('/'))).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Start the trial again' }));
    expect(screen.getByRole('button', { name: /Train regularly/ })).toBeTruthy();
    expect(screen.queryByText(/^Earned /)).toBeNull();
  });

  it('shows the newcomer their buddy, and lets them do without one', async () => {
    const sam = {
      pairId: 'a1b2c3d4-0000-4000-8000-000000000001',
      role: 'veteran' as const,
      name: 'Sam Lee',
      joinedAt: '2026-06-01T10:00:00.000Z',
      pairedAt: '2026-10-01T08:00:00.000Z',
      sameCategory: 'body' as const,
    };
    open({
      '/api/member/exp_E1/space?lang=en': [
        {
          status: 200,
          body: space({ goal: WEIGHT, buddies: { optedOut: false, partners: [sam] } }),
        },
      ],
      'POST /api/member/exp_E1/space/buddies': [
        { status: 200, body: { optedOut: true, partners: [] } },
        { status: 200, body: { optedOut: false, partners: [] } },
      ],
    });
    expect(await screen.findByRole('heading', { name: 'Your buddy' })).toBeTruthy();
    expect(screen.getByText('Sam Lee')).toBeTruthy();
    expect(screen.getByText('Member since Jun 1, 2026')).toBeTruthy();
    expect(screen.getByText('Same kind of goal: Body and health')).toBeTruthy();
    expect(screen.getByText('StayPut shows each of you only the other’s name.')).toBeTruthy();
    // No Mentor badge ahead for a newcomer.
    expect(screen.queryByText('Mentor')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'No buddy for me' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, stop' }));
    expect(await screen.findByText('You asked not to be paired with a buddy.')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/buddies')).toEqual({ optOut: true });
    fireEvent.click(screen.getByRole('button', { name: 'Accept a buddy again' }));
    await vi.waitFor(() =>
      expect(bodies.get('POST /api/member/exp_E1/space/buddies')).toEqual({ optOut: false }),
    );
    // Nobody paired yet: the card goes until a buddy comes.
    await vi.waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Your buddy' })).toBeNull(),
    );
  });

  it('shows the rescue challenges, never who, and lets the member take one up', async () => {
    const challenge = (n: number, over: Partial<RescueChallenge> = {}): RescueChallenge => ({
      id: `b1c2d3e4-0000-4000-8000-00000000000${n}`,
      platform: 'discord',
      place: 'Le Club Discord',
      url: `https://discord.com/channels/1/2/${n}`,
      lastMessageAt: '2026-09-15T08:00:00.000Z',
      createdAt: '2026-10-01T08:00:00.000Z',
      helpers: 0,
      joined: false,
      ...over,
    });
    const whop = challenge(2, { platform: 'whop', place: null, url: null, helpers: 2 });
    open({
      '/api/member/exp_E1/space?lang=en': [
        {
          status: 200,
          body: space({ rescues: { challenges: [challenge(1), whop], rescued: 1 } }),
        },
      ],
      [`POST /api/member/exp_E1/space/rescues/${challenge(1).id}`]: [
        {
          status: 200,
          body: { challenges: [challenge(1, { joined: true, helpers: 1 }), whop], rescued: 1 },
        },
      ],
    });
    expect(await screen.findByRole('heading', { name: 'Rescue challenges' })).toBeTruthy();
    expect(screen.getByText('You helped 1 member come back.')).toBeTruthy();
    expect(
      screen.getAllByText('Help a member who stalled: answer their last message.'),
    ).toHaveLength(2);
    expect(screen.getByText(/^On Discord · Le Club Discord · /)).toBeTruthy();
    expect(screen.getByText(/^In the Whop chat · /)).toBeTruthy();
    expect(screen.getByText('2 members on it')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open their last message/ }).getAttribute('href')).toBe(
      'https://discord.com/channels/1/2/1',
    );
    expect(screen.queryByText('Rescuer')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'I’ll take it' })[0]!);
    expect(
      await screen.findByText(
        'You took it up: if this member comes back, you earn the Rescuer badge.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('1 member on it')).toBeTruthy();
    // The badge to earn shows among those ahead.
    expect(screen.getByText('Rescuer')).toBeTruthy();
  });

  it('shows the veteran the newcomers they welcome, and the Mentor badge ahead', async () => {
    const newcomer = (n: number, name: string) => ({
      pairId: `a1b2c3d4-0000-4000-8000-00000000000${n}`,
      role: 'newcomer' as const,
      name,
      joinedAt: '2026-09-29T10:00:00.000Z',
      pairedAt: '2026-10-01T08:00:00.000Z',
      sameCategory: null,
    });
    open({
      '/api/member/exp_E1/space?lang=en': [
        {
          status: 200,
          body: space({
            buddies: { optedOut: false, partners: [newcomer(1, 'Léa'), newcomer(2, 'Tom')] },
          }),
        },
      ],
    });
    expect(await screen.findByRole('heading', { name: 'The newcomers you welcome' })).toBeTruthy();
    expect(screen.getByText(/you earn the Mentor badge/)).toBeTruthy();
    expect(screen.getByText('Léa')).toBeTruthy();
    expect(screen.getByText('Tom')).toBeTruthy();
    expect(screen.getByText('Mentor')).toBeTruthy();
  });

  it('makes a testimonial card of a result, with the affiliate link Whop gives', async () => {
    const result = {
      id: '5f0c3e1a-9b2d-4e8f-a1c3-d5e7f9b1c3d5',
      value: 90.25,
      recordedAt: '2026-10-01T09:00:00.000Z',
      proof: 'justified' as const,
    };
    const card: TestimonialCard = {
      proofId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      resultId: result.id,
      level: 'justified',
      url: 'https://stayput.test/v/7c9e6679-7425-40de-944b-e07fc1f90ae7',
      display: {
        community: 'Le Club',
        locale: 'en',
        goal: 'Reach my target weight',
        unit: 'kg',
        entry: 'total',
        start: 92,
        target: 85,
        value: 90.25,
        progress: 25,
        recordedAt: result.recordedAt,
        day: '2026-10-01',
        publishedAt: '2026-10-01T10:00:00.000Z',
        name: 'Lina',
        affiliateUrl: 'https://whop.com/le-club/?a=lina',
      },
    };
    const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    open({
      '/api/member/exp_E1/space?lang=en': [
        {
          status: 200,
          body: space({ goal: { ...WEIGHT, current: 90.25, progress: 25 }, results: [result] }),
        },
      ],
      '/api/member/exp_E1/space/affiliate': [
        { status: 200, body: { url: 'https://whop.com/le-club/?a=lina' } },
      ],
      'POST /api/member/exp_E1/space/card': [{ status: 200, body: card }],
      [`DELETE /api/member/exp_E1/space/card/${card.proofId}`]: [
        { status: 200, body: { removed: true } },
      ],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Make a card' }));
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'The result on the card' }).value,
    ).toBe(result.id);
    const link = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Your affiliate link (optional)',
    });
    expect(await screen.findByText('Your affiliate link, found on Whop.')).toBeTruthy();
    expect(link.value).toBe('https://whop.com/le-club/?a=lina');
    // A link elsewhere than Whop: refused before anything is sent.
    fireEvent.change(link, { target: { value: 'https://evil.example/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make my card' }));
    expect(screen.getByText('Paste a whop.com link (https://whop.com/…).')).toBeTruthy();
    expect(bodies.has('POST /api/member/exp_E1/space/card')).toBe(false);
    fireEvent.change(link, { target: { value: ' https://whop.com/le-club/?a=lina ' } });
    // The name shows only when the member ticks it.
    const name = screen.getByRole<HTMLInputElement>('checkbox', { name: /Show my name/ });
    expect(name.checked).toBe(false);
    fireEvent.click(name);
    fireEvent.click(screen.getByRole('button', { name: 'Make my card' }));

    expect(await screen.findByRole('heading', { name: 'Your cards online' })).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/card')).toEqual({
      resultId: result.id,
      showName: true,
      affiliateUrl: 'https://whop.com/le-club/?a=lina',
    });
    // This browser draws no canvas: the page's link is there to share.
    expect(
      await screen.findByText(
        'This browser cannot draw the card. Its page is online: share its link.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(card.url)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'See the page' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the link' }));
    expect(await screen.findByText('Link copied')).toBeTruthy();
    expect(clipboard.writeText).toHaveBeenCalledWith(card.url);

    fireEvent.click(screen.getByRole('button', { name: 'Take the page down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, take it down' }));
    expect(await screen.findByText('Page taken down: its QR code leads nowhere now.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your cards online' })).toBeNull();
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('draws the team a card in the trial, with its QR code, and publishes nothing', async () => {
    // A canvas that draws nothing but answers, its letters as wide as Inter's (about 0.6 of the
    // font's size): the card's drawing runs to its end.
    const drawn: string[] = [];
    const context = {
      font: '',
      measureText(text: string) {
        return { width: text.length * Number(/(\d+)px/.exec(this.font)?.[1] ?? 16) * 0.6 };
      },
      fillText: (text: string) => drawn.push(text),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      arcTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
    };
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => context as never);
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/png;base64,QUJD');
    try {
      const calls = open({
        '/api/member/exp_E1/space?lang=en': [
          { status: 200, body: space({ preview: true, known: false }) },
        ],
      });
      fireEvent.click(await screen.findByRole('button', { name: /Train regularly/ }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Your target' }), {
        target: { value: '8' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Set my goal' }));
      fireEvent.change(await screen.findByRole('textbox', { name: 'How many more?' }), {
        target: { value: '2' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Make a card' }));
      fireEvent.click(screen.getByRole('checkbox', { name: /Show my name/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Make my card' }));

      const image = await screen.findByRole('img', {
        name: 'Testimonial card: Train regularly, 25% of the goal',
      });
      expect(image.getAttribute('src')).toBe('data:image/png;base64,QUJD');
      const download = screen.getByRole('link', { name: 'Download (PNG)' });
      expect(download.getAttribute('href')).toBe('data:image/png;base64,QUJD');
      expect(download.getAttribute('download')).toMatch(/^stayput-card-\d{4}-\d{2}-\d{2}\.png$/);
      // The card writes its numbers with their unit joined by a no-break space.
      expect(drawn.map((text) => text.replace(/\u00a0/g, ' '))).toEqual(
        expect.arrayContaining([
          'Train regularly',
          '0 sessions → 2 sessions',
          '25% of the goal (8 sessions)',
          'Declared by the member',
          'Scan to check it',
          'StayPut',
        ]) as unknown,
      );
      expect(drawn.some((text) => text.startsWith('By Your name · '))).toBe(true);
      expect(screen.getByText('Trial: the card is drawn, its page is not published.')).toBeTruthy();
      // Nothing published, no page to open.
      expect(screen.queryByRole('button', { name: 'See the page' })).toBeNull();
      expect(calls.filter((c) => !c.startsWith('/'))).toEqual([]);
    } finally {
      getContext.mockRestore();
      toDataURL.mockRestore();
    }
  });

  it('reads a screenshot in the browser, and sends only its fingerprint and numbers', async () => {
    const read = { sha256: 'a'.repeat(64), numbers: [12, 90.25] };
    vi.mocked(readScreenshot).mockImplementation((_file, onProgress) => {
      onProgress('reading', 0.5);
      return Promise.resolve(read);
    });
    open({
      '/api/member/exp_E1/space?lang=en': [{ status: 200, body: space({ goal: WEIGHT }) }],
      'POST /api/member/exp_E1/space/result?lang=en': [
        {
          status: 200,
          body: {
            milestones: [25],
            badges: ['first_result', 'first_proof', 'milestone_25'],
            achieved: false,
            proof: 'justified',
            earnedDays: 0,
            space: space({
              goal: { ...WEIGHT, current: 90.25, progress: 25 },
              results: [
                {
                  id: 'r1',
                  value: 90.25,
                  recordedAt: '2026-10-01T09:00:00.000Z',
                  proof: 'justified',
                },
              ],
            }),
          } satisfies ResultAnswer,
        },
      ],
    });
    const picker = await screen.findByLabelText('Add a screenshot');
    fireEvent.change(picker, {
      target: { files: [new File(['png'], 'dashboard.png', { type: 'image/png' })] },
    });
    // The numbers read, the closest to where the member stands chosen.
    expect(await screen.findByText('Numbers read on your screenshot: tap yours.')).toBeTruthy();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Where are you now?' });
    expect(input.value).toBe('90.25');
    expect(screen.getByRole('button', { name: '90.25' }).getAttribute('aria-pressed')).toBe('true');
    // A number not on it would be the member's word only.
    fireEvent.change(input, { target: { value: '91' } });
    expect(
      screen.getByText('This number is not on the screenshot: it will be recorded as declared.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '90.25' }));
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('Your screenshot backs this result.')).toBeTruthy();
    expect(screen.getByText('New badge: First proof')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/result?lang=en')).toEqual({
      goalId: WEIGHT.id,
      value: 90.25,
      proof: read,
    });
    expect(screen.getByText('Backed by a screenshot')).toBeTruthy();
    // The screenshot is gone with the result: the next one starts afresh.
    expect(screen.getByLabelText('Add a screenshot')).toBeTruthy();
  });

  it('says when a screenshot cannot be read', async () => {
    vi.mocked(readScreenshot).mockRejectedValue(new Error('not an image'));
    open({ '/api/member/exp_E1/space?lang=en': [{ status: 200, body: space({ goal: WEIGHT }) }] });
    fireEvent.change(await screen.findByLabelText('Add a screenshot'), {
      target: { files: [new File(['?'], 'notes.txt', { type: 'image/png' })] },
    });
    expect(
      await screen.findByText(
        'This screenshot could not be read. Try another one, or type your result.',
      ),
    ).toBeTruthy();
  });

  it('shows the free days ahead, and celebrates those a milestone brings', async () => {
    const offered = { at50: 3, at100: 7 };
    open({
      '/api/member/exp_E1/space?lang=en': [
        {
          status: 200,
          body: space({
            goal: { ...WEIGHT, current: 89, progress: 42 },
            rewards: { offered, received: [] },
          }),
        },
      ],
      'POST /api/member/exp_E1/space/result?lang=en': [
        {
          status: 200,
          body: {
            milestones: [50],
            badges: ['milestone_50'],
            achieved: false,
            proof: null,
            earnedDays: 3,
            space: space({
              goal: { ...WEIGHT, current: 88.5, progress: 50 },
              rewards: {
                offered,
                received: [{ percent: 50, days: 3, at: '2026-10-01T09:00:00.000Z' }],
              },
            }),
          } satisfies ResultAnswer,
        },
      ],
    });
    expect(await screen.findByText('3 free days at 50% · 7 free days at 100%')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Where are you now?' }), {
      target: { value: '88.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('A gift: 3 free days added to your access!')).toBeTruthy();
    expect(screen.getByText('7 free days at 100%')).toBeTruthy();
    expect(screen.getByText(/^3 free days received on .+ \(50% reached\)$/)).toBeTruthy();
  });

  it('offers to share a milestone, with the exact words, and says what came of it', async () => {
    const announce = { locale: 'fr' as const, firstName: 'Lina', place: '#wins' };
    open({
      '/api/member/exp_E1/space?lang=en': [
        {
          status: 200,
          body: space({ goal: { ...WEIGHT, current: 90.5, progress: 21 }, announce }),
        },
      ],
      'POST /api/member/exp_E1/space/result?lang=en': [
        {
          status: 200,
          body: {
            milestones: [25],
            badges: [],
            achieved: false,
            proof: null,
            earnedDays: 0,
            space: space({ goal: { ...WEIGHT, current: 90.25, progress: 25 }, announce }),
          } satisfies ResultAnswer,
        },
      ],
      'POST /api/member/exp_E1/space/share': [
        { status: 200, body: { status: 'sent' } satisfies ShareAnswer },
      ],
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Where are you now?' }), {
      target: { value: '90.25' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('Share it with the community?')).toBeTruthy();
    // The community's words, French here, whatever the member's language (the matcher reads
    // the no-break space as a space).
    expect(
      screen.getByText('🎉 Lina a atteint 25 % de son objectif : « Reach my target weight » !'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share it' }));
    expect(await screen.findByText('Shared in #wins!')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/space/share')).toEqual({
      goalId: WEIGHT.id,
      percent: 25,
    });
  });

  it('tells a member not read yet that their space comes', async () => {
    open({
      '/api/member/exp_E1/space?lang=en': [{ status: 200, body: space({ known: false }) }],
    });
    expect(await screen.findByText('Your space is getting ready')).toBeTruthy();
  });
});

describe('shell', () => {
  it('opens in English, whatever the browser says, without a switch on the page', async () => {
    renderAt('/');
    expect(
      await screen.findByRole('heading', { name: 'Retention for Whop communities' }),
    ).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Language' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Language' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Theme' })).toBeNull();
  });

  it('shows a not-found page for an unknown path', async () => {
    renderAt('/nowhere');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

describe('the views Whop opens', () => {
  it('serves each at the path the Whop app’s settings name (WHOP_VIEW_PATHS)', () => {
    const served = (path: string) =>
      matchRoutes(routes, path)
        ?.map((match) => match.route.path)
        .filter(Boolean)
        .join(' > ');
    // Whop replaces the bracketed part with the community or the experience.
    const filled = (path: string) =>
      path.replace('[experienceId]', 'exp_E1').replace('[companyId]', 'biz_A1');
    expect(served(filled(WHOP_VIEW_PATHS.experience_path))).toBe('experiences/:experienceId/*');
    expect(served(filled(WHOP_VIEW_PATHS.dashboard_path))).toBe('dashboard/:companyId');
    expect(served(filled(WHOP_VIEW_PATHS.discover_path))).toBe('discover');
  });

  it('shows the Discover view without any call, nothing leaving Whop’s frame', async () => {
    legalOn();
    const calls = mockApi({});
    renderAt('/discover');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Keep your members, and see the revenue you saved.',
      }),
    ).toBeTruthy();
    expect(
      screen.getByText('Predict churn. Recover failed payments. Win members back.'),
    ).toBeTruthy();
    for (const step of [
      'Know who is about to leave',
      'Act before they go',
      'See the money saved',
    ]) {
      expect(screen.getByRole('heading', { name: step })).toBeTruthy();
    }
    expect(screen.getByText(/starts in test mode/)).toBeTruthy();
    // The demo is StayPut's own page, in the same frame.
    const demo = screen.getByRole('link', { name: 'See the live demo' });
    expect(demo.getAttribute('href')).toBe('/demo');
    expect(demo.getAttribute('target')).toBeNull();
    // The legal texts open in a window, never in another tab.
    fireEvent.click(screen.getByRole('button', { name: 'Privacy policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'Privacy policy' });
    expect(dialog.querySelector('iframe')?.getAttribute('src')).toBe('/privacy?lang=en&view=app');
    expect(calls).toEqual([]);
  });

  it('speaks French when the interface does', async () => {
    mockApi({});
    renderAt('/discover', 'fr');
    expect(
      await screen.findByText(
        'Anticipez les départs. Récupérez les paiements échoués. Faites revenir vos membres.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voir la démo' })).toBeTruthy();
  });
});

describe('the creator’s frame', () => {
  it('folds the menu to its icons, and remembers it', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse the menu' }));
    expect(window.localStorage.getItem('stayput.menu.collapsed')).toBe('1');
    // The sections keep their names for screen readers, and say them beside the icon on hover.
    const menu = screen.getByRole('navigation', { name: 'Dashboard sections' });
    const members = within(menu).getByRole('link', { name: 'Members' });
    expect(
      members.querySelector('[aria-hidden="true"].group-hover\\:opacity-100')?.textContent,
    ).toBe('Members');
    fireEvent.click(screen.getByRole('button', { name: 'Expand the menu' }));
    expect(window.localStorage.getItem('stayput.menu.collapsed')).toBe('0');
  });

  it('finds a member from the top bar, accents aside, and opens their drawer in Members', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/members/mber_5': [{ status: 200, body: DETAIL_EMPTY('mber_5') }],
    });
    renderAt('/dashboard/biz_A1');
    await screen.findByText('Bruno Petit');
    const search = screen.getByRole('combobox', { name: 'Find a member' });
    fireEvent.change(search, { target: { value: 'chloe' } });
    const option = await screen.findByRole('option', { name: 'Chloé Dubois' });
    fireEvent.click(within(option).getByRole('button'));
    const drawer = await screen.findByRole('dialog', { name: 'Chloé Dubois' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Members', level: 1 })).toBeTruthy();
    // Nobody by that name: Enter searches the words in Members.
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(await screen.findByText('No member by that name.')).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(await screen.findByText('No member matches “zzz”.')).toBeTruthy();
    expect(screen.getByPlaceholderText<HTMLInputElement>('Search a member').value).toBe('zzz');
  });

  it('changes the language in Settings › General only, at once, and remembers it', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/integrations?lang=fr': [{ status: 200, body: INTEGRATIONS }],
    });
    renderAt('/dashboard/biz_A1/settings');
    const languages = await screen.findByRole('radiogroup', { name: 'Language' });
    expect(
      within(languages)
        .getAllByRole('radio')
        .map((radio) => `${radio.textContent} ${radio.getAttribute('aria-checked')}`),
    ).toEqual(['English true', 'Français false']);
    fireEvent.click(within(languages).getByRole('radio', { name: 'Français' }));
    // At once, without reloading: the words, and the menu around them.
    expect(await screen.findByRole('heading', { name: 'Réglages', level: 1 })).toBeTruthy();
    // Kept for this community's app alone (brief v4 §3), never for the demo.
    expect(window.localStorage.getItem('stayput.locale.biz_A1')).toBe('fr');
    expect(
      within(screen.getByRole('radiogroup', { name: 'Langue' }))
        .getByRole('radio', { name: 'Français' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    // The arrows move the choice too, as in any radio group.
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Français' }), { key: 'ArrowLeft' });
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
  });

  it('opens the demo in English whatever was chosen elsewhere, and keeps no choice made there', async () => {
    // A creator chose French in their own app (brief v4 §3): that choice is theirs alone.
    window.localStorage.setItem('stayput.locale.biz_A1', 'fr');
    expect(detectLocale('/dashboard/biz_A1/settings')).toBe('fr');
    expect(detectLocale('/demo')).toBe('en');
    expect(detectLocale('/')).toBe('en');
    vi.stubGlobal('fetch', vi.fn());
    // Even a page still in French turns English on entering the demo.
    renderAt('/demo/settings', 'fr');
    expect(
      await screen.findByRole('heading', { name: 'Settings', level: 1 }, { timeout: 3_000 }),
    ).toBeTruthy();
    // French is there, second, and works for the visit…
    const languages = await screen.findByRole('radiogroup', { name: 'Language' });
    expect(
      within(languages)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['English', 'Français']);
    fireEvent.click(within(languages).getByRole('radio', { name: 'Français' }));
    expect(await screen.findByRole('heading', { name: 'Réglages', level: 1 })).toBeTruthy();
    // …but is not kept: the demo opens in English again.
    const kept = Array.from({ length: window.localStorage.length }, (_, i) =>
      window.localStorage.key(i),
    ).filter((key) => key?.startsWith('stayput.locale'));
    expect(kept).toEqual(['stayput.locale.biz_A1']);
    expect(detectLocale('/demo')).toBe('en');
  });

  it('opens another page at its top, not where the page left was scrolled', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/settings');
    await screen.findByRole('radiogroup', { name: 'Language' });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    try {
      const menu = screen.getByRole('navigation', { name: 'Dashboard sections' });
      fireEvent.click(within(menu).getByRole('link', { name: 'Dashboard' }));
      await vi.waitFor(() =>
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' }),
      );
    } finally {
      scrollTo.mockRestore();
    }
  });

  it('has no theme to choose in Settings › General, and gives the company ID to copy', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/settings');
    // Dark is StayPut's only theme (brief v3 §4).
    await screen.findByRole('radiogroup', { name: 'Language' });
    expect(screen.queryByRole('combobox', { name: 'Theme' })).toBeNull();
    // The raw ID only here, for Whop's support or an integration.
    const developer = screen.getByRole('heading', { name: 'Developer' }).closest('section')!;
    expect(within(developer).getByText('biz_A1')).toBeTruthy();
    expect(within(developer).getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('links to no legal page while they are off: not in Settings, not on Discover', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/settings');
    expect(await screen.findByRole('heading', { name: 'Developer' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Legal' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Privacy policy/ })).toBeNull();
    cleanup();
    renderAt('/discover');
    expect(await screen.findByRole('link', { name: 'See the live demo' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Legal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Privacy policy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Terms of service' })).toBeNull();
  });

  it('reads the privacy policy, the terms and the DPA inside StayPut, in its language', async () => {
    legalOn();
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/settings');
    const legal = (await screen.findByRole('heading', { name: 'Legal' })).closest('section')!;
    expect(
      within(legal)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Read · Privacy policy',
      'Read · Terms of service',
      'Read · Data processing agreement',
    ]);
    fireEvent.click(within(legal).getByRole('button', { name: 'Read · Terms of service' }));
    const dialog = await screen.findByRole('dialog', { name: 'Terms of service' });
    // The Worker's page, never a page outside StayPut, with no script and no way out.
    const frame = within(dialog).getByTitle<HTMLIFrameElement>('Terms of service, the page');
    expect(frame.getAttribute('src')).toBe('/terms?lang=en&view=app');
    expect(frame.getAttribute('sandbox')).toBe('');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // In French, the French page.
    const languages = screen.getByRole('radiogroup', { name: 'Language' });
    fireEvent.click(within(languages).getByRole('radio', { name: 'Français' }));
    const juridique = (await screen.findByRole('heading', { name: 'Documents légaux' })).closest(
      'section',
    )!;
    fireEvent.click(
      within(juridique).getByRole('button', { name: 'Lire · Accord de traitement des données' }),
    );
    const accord = await screen.findByRole('dialog', { name: 'Accord de traitement des données' });
    expect(
      within(accord).getByTitle('Accord de traitement des données, la page').getAttribute('src'),
    ).toBe('/dpa?lang=fr&view=app');
  });

  it('turns the verified retention badge on, shows it, and gives the code to paste', async () => {
    const OFF: BadgeView = {
      enabled: false,
      retention: 0.85,
      members: 40,
      locale: 'en',
      badgeUrl: 'https://stayput.example/badge/biz_A1.svg',
      verifyUrl: 'https://stayput.example/verify/biz_A1',
    };
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/badge': [{ status: 200, body: OFF }],
      'PUT /api/creator/biz_A1/badge': [{ status: 200, body: { ...OFF, enabled: true } }],
    });
    renderAt('/dashboard/biz_A1/settings');
    const card = (await screen.findByRole('heading', { name: 'Verified retention badge' })).closest(
      'section',
    )!;
    expect(await within(card).findByText('Off: the badge and its page show nothing.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('switch', { name: 'Show my badge' }));
    // The badge as it shows on a sales page: drawn here, the same as the Worker serves.
    const image = await within(card).findByRole<HTMLImageElement>('img', {
      name: 'Verified retention: 85% at 90 days',
    });
    expect(image.src).toMatch(/^data:image\/svg\+xml/);
    expect(bodies.get('PUT /api/creator/biz_A1/badge')).toEqual({ enabled: true });
    expect(
      within(card).getByRole<HTMLTextAreaElement>('textbox', {
        name: 'Code to paste on your sales page',
      }).value,
    ).toBe(
      '<a href="https://stayput.example/verify/biz_A1" target="_blank" rel="noopener"><img src="https://stayput.example/badge/biz_A1.svg" alt="Verified retention: 85% at 90 days" height="20"></a>',
    );
    expect(within(card).getByRole('button', { name: 'Copy the code' })).toBeTruthy();
    expect(card.textContent).toContain('40 of them more than 90 days ago');
  });

  it('says when the badge will appear, with too few members yet', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/badge': [
        {
          status: 200,
          body: {
            enabled: true,
            retention: null,
            members: 4,
            locale: 'fr',
            badgeUrl: 'https://stayput.example/badge/biz_A1.svg',
            verifyUrl: 'https://stayput.example/verify/biz_A1',
          } satisfies BadgeView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/settings', 'fr');
    expect(
      await screen.findByText(
        'Votre badge apparaît dès qu’au moins 10 membres sont arrivés il y a plus de 90 jours (4 pour l’instant).',
      ),
    ).toBeTruthy();
  });

  it('lists the Whop team, and who opened StayPut', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/team': [
        {
          status: 200,
          body: {
            members: [
              {
                userId: 'user_alice',
                name: 'Alice Martin',
                username: 'alice',
                openedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
              },
              { userId: 'user_bob', name: null, username: null, openedAt: null },
            ],
          } satisfies TeamView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/settings');
    const team = within(await screen.findByRole('list', { name: 'Team' }));
    // The lines each row shows (the avatar's initials are decoration).
    const rows = team
      .getAllByRole('listitem')
      .map((row) => [...row.querySelectorAll('p')].map((line) => line.textContent));
    expect(rows).toEqual([
      ['Alice Martin', '@alice', 'Opened StayPut 2 days ago'],
      ['A team member', 'Has not opened StayPut yet'],
    ]);
  });

  it('exports the community’s data as a file, and deletes it once its name is typed again', async () => {
    const exported: DataExport = {
      exportedAt: '2026-10-05T09:00:00.000Z',
      company: { id: 'biz_A1', name: 'Le Club' },
      team: [],
      tables: { members: { rows: [], truncated: false } },
    };
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/export': [{ status: 200, body: exported }],
      'POST /api/creator/biz_A1/data/delete': [{ status: 200, body: { deleted: true } }],
    });
    const createObjectURL = vi.fn(() => 'blob:stayput-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderAt('/dashboard/biz_A1/settings');
      const card = (await screen.findByRole('heading', { name: 'Your data' })).closest('section')!;
      fireEvent.click(within(card).getByRole('button', { name: 'Export my data (JSON)' }));
      await vi.waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      const link = click.mock.contexts[0] as HTMLAnchorElement;
      expect(link.download).toBe('stayput-biz_A1-2026-10-05.json');
      const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
      expect(JSON.parse(await blob.text())).toEqual(exported);

      fireEvent.click(within(card).getByRole('button', { name: 'Delete all data' }));
      const dialog = await screen.findByRole('dialog', {
        name: 'Delete all of your community’s data?',
      });
      const confirm = within(dialog).getByRole('button', { name: 'Delete everything' });
      const field = within(dialog).getByRole('textbox', { name: 'Type “Le Club” to confirm' });
      fireEvent.change(field, { target: { value: 'Le Clu' } });
      expect(confirm.hasAttribute('disabled')).toBe(true);
      fireEvent.change(field, { target: { value: 'Le Club' } });
      expect(confirm.hasAttribute('disabled')).toBe(false);
      fireEvent.click(confirm);
      expect(
        await screen.findByText(
          'Everything is deleted. Reopen StayPut to start again from Whop’s data.',
        ),
      ).toBeTruthy();
      expect(bodies.get('POST /api/creator/biz_A1/data/delete')).toEqual({ confirm: 'biz_A1' });
    } finally {
      click.mockRestore();
    }
  });

  it('lists the other sections under « More » on a phone', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    const phone = await screen.findByRole('navigation', { name: 'Main sections' });
    fireEvent.click(within(phone).getByRole('button', { name: 'More' }));
    const more = await screen.findByRole('dialog', { name: 'More' });
    expect(
      within(more)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Integrations', 'Settings']);
  });

  it('shows the demo’s one Whop-shaped id in Settings › Developer, as its badge does', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/settings');
    const developer = (
      await screen.findByText('Company ID', undefined, { timeout: 3_000 })
    ).closest('dl')!;
    expect(developer.querySelector('code')?.textContent).toBe('biz_AtlasTradingClub');
    const code = await screen.findByRole<HTMLTextAreaElement>(
      'textbox',
      { name: 'Code to paste on your sales page' },
      { timeout: 3_000 },
    );
    expect(code.value).toContain('/badge/biz_AtlasTradingClub.svg');
  });
});

describe('the internal status page (SPEC Phase 8.5)', () => {
  const STATUS: OperatorStatus = {
    checkedAt: '2026-10-05T09:00:00.000Z',
    whopEnv: 'sandbox',
    database: 'ok',
    migration: '0042_operations.sql',
    jobs: [
      {
        job: 'sync',
        everyMinutes: 10,
        state: 'ok',
        lastFinishedAt: '2026-10-05T08:50:01.000Z',
        lastOkAt: '2026-10-05T08:50:01.000Z',
        lastFailedAt: null,
        lastError: null,
        lastDurationMs: 820,
        runs: 120,
        failures: 0,
      },
      {
        job: 'actions',
        everyMinutes: 60,
        state: 'failing',
        lastFinishedAt: '2026-10-05T08:00:03.000Z',
        lastOkAt: '2026-10-05T07:00:02.000Z',
        lastFailedAt: '2026-10-05T08:00:03.000Z',
        lastError: 'Whop 500 for user_…',
        lastDurationMs: 3100,
        runs: 20,
        failures: 1,
      },
      {
        job: 'benchmarks',
        everyMinutes: 10080,
        state: 'never',
        lastFinishedAt: null,
        lastOkAt: null,
        lastFailedAt: null,
        lastError: null,
        lastDurationMs: null,
        runs: 0,
        failures: 0,
      },
    ],
    webhooks: {
      lastDay: { processed: 12, ignored: 3, failed: 1 },
      lastReceivedAt: '2026-10-05T08:58:00.000Z',
      failedCount: 1,
      failed: [
        {
          id: 'msg_Bad1',
          type: 'payment.failed',
          companyId: 'biz_A1',
          companyName: 'Le Club',
          attempts: 5,
          retrying: false,
          lastError: 'invalid input syntax for type timestamp',
          receivedAt: '2026-10-05T07:00:00.000Z',
        },
      ],
    },
    companies: { active: 3, accessLost: 0, uninstalled: 1 },
    syncErrors: [],
    failedActions: [],
    errors: [
      {
        source: 'job:actions',
        companyId: null,
        message: 'Whop 500 for user_…',
        count: 2,
        firstAt: '2026-10-05T07:00:03.000Z',
        lastAt: '2026-10-05T08:00:03.000Z',
      },
    ],
  };
  const operatorSession = { ...creatorSession, body: { ...creatorSession.body, operator: true } };

  it('shows the operator the jobs, the deliveries and the errors, and replays a delivery', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/session': [operatorSession],
      '/api/creator/biz_A1/operator/status': [
        { status: 200, body: STATUS },
        {
          status: 200,
          body: { ...STATUS, webhooks: { ...STATUS.webhooks, failedCount: 0, failed: [] } },
        },
      ],
      'POST /api/creator/biz_A1/operator/webhooks/replay': [
        { status: 200, body: { counts: { processed: 1 } } satisfies WebhookReplay },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/status');
    const tabs = await screen.findByRole('navigation', { name: /Settings/ });
    expect(within(tabs).getByRole('link', { name: 'Status' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Something needs a look' })).toBeTruthy();
    const jobs = screen.getByRole('list', { name: 'Scheduled jobs' });
    expect(
      within(jobs)
        .getAllByRole('listitem')
        .map((row) => [
          row.querySelector('.font-mono')?.textContent,
          row.querySelector('span.rounded-full')?.textContent,
        ]),
    ).toEqual([
      ['sync', 'OK'],
      ['actions', 'Failing'],
      ['benchmarks', 'Never ran'],
    ]);
    expect(within(jobs).getByText(/Last error, .*: Whop 500 for user_…/)).toBeTruthy();
    expect(screen.getByText('Given up after 5 attempts', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replay payment.failed' }));
    expect(await screen.findByText('1 processed')).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/operator/webhooks/replay')).toEqual({
      id: 'msg_Bad1',
    });
    expect(await screen.findByText('No failed delivery.')).toBeTruthy();
    expect(screen.getByText('Whop 500 for user_…', { selector: 'p.font-mono' })).toBeTruthy();
  });

  it('is not there for any other community', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/settings/status');
    // The address leads back to Settings › General, and no tab says Status.
    expect(await screen.findByRole('radiogroup', { name: 'Language' })).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: /Settings/ });
    expect(within(tabs).queryByRole('link', { name: 'Status' })).toBeNull();
  });
});

describe('the guide (brief v4 §10)', () => {
  it('opens five cards in the validated words, then four shortcuts and the tour', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    const guide = await screen.findByRole('dialog', { name: 'How StayPut works' });
    expect(
      within(guide)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'Who is about to leave',
      'Keep them, automatically',
      'See the money you kept',
      'You stay in control',
      'Connect Discord and Telegram',
      'What do you want to do?',
    ]);
    expect(guide.textContent).toContain(
      'StayPut watches every member for you. When someone goes quiet, misses a payment or schedules a cancellation, they show up here with the reason. You never have to dig.',
    );
    expect(guide.textContent).toContain(
      'StayPut never reads what members write: only who wrote, where and when.',
    );
    expect(within(guide).getAllByRole('button', { name: 'Show me' })).toHaveLength(5);
    // Each card loops its picture while on screen; nothing here says how StayPut computes.
    expect(guide.querySelectorAll('[data-loop]')).toHaveLength(5);
    expect(guide.textContent).not.toMatch(/Test mode|direct|influenced|Guardrails/i);
    expect(
      [
        'See who is about to leave',
        'Turn on payment retries',
        'Connect Discord or Telegram',
        'Set my limits',
      ].map((name) => within(guide).getByRole('button', { name }).textContent),
    ).toHaveLength(4);
    expect(within(guide).getByRole('button', { name: 'Replay the tour' })).toBeTruthy();
    // From a real dashboard, the way into the demo stays, at the bottom.
    expect(
      within(guide).getByRole('link', { name: 'Explore with demo data' }).getAttribute('href'),
    ).toBe('/demo?from=%2Fdashboard%2Fbiz_A1');
    fireEvent.click(within(guide).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('runs the tour: five places, Next, Back and the arrows, its last two on their pages, Done back home', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/dashboard': [
        { status: 200, body: HOME },
        { status: 200, body: HOME },
      ],
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
    });
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replay the tour' }));
    // Each place has its own tooltip: read the one on screen.
    const tour = () => screen.getByRole('dialog', { name: 'Tour of StayPut' });
    await screen.findByRole('dialog', { name: 'Tour of StayPut' });
    expect(tour().textContent).toContain('1 of 5');
    expect(within(tour()).getByRole('heading').textContent).toBe('Revenue saved · This month');
    expect(tour().textContent).toContain(
      'This is what StayPut earned you this month. It starts at $0.00 and grows with every member saved.',
    );
    // Its places on the dashboard: the exact elements, one each.
    for (const place of ['hero-amount', 'priority-action', 'risk-ring']) {
      await vi.waitFor(() =>
        expect(document.querySelectorAll(`[data-tour="${place}"]`), place).toHaveLength(1),
      );
    }
    // The amount, its label and its change: not the chart below them.
    expect(
      document.querySelector('[data-tour="hero-amount"]')!.querySelector('svg, canvas'),
    ).toBeNull();
    expect(within(tour()).queryByRole('button', { name: 'Back' })).toBeNull();
    fireEvent.click(within(tour()).getByRole('button', { name: 'Next' }));
    expect(tour().textContent).toContain('2 of 5');
    expect(tour().textContent).toContain(
      'One thing to do today. Click it, StayPut handles the rest.',
    );
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(tour().textContent).toContain('0 means safe, 100 means leaving. Hover to see why.');
    fireEvent.click(within(tour()).getByRole('button', { name: 'Back' }));
    expect(tour().textContent).toContain('2 of 5');
    fireEvent.click(within(tour()).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(tour()).getByRole('button', { name: 'Next' }));
    // Step 4 on Automations, at the payment retries' rule.
    expect(await screen.findByRole('heading', { name: 'Automations', level: 1 })).toBeTruthy();
    expect(within(tour()).getByRole('heading').textContent).toBe('Automations');
    expect(tour().textContent).toContain('4 of 5');
    expect(tour().textContent).toContain(
      'Decide what StayPut does on its own. Start with payment retries: zero risk, instant results.',
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-tour="rule-payment-retry"]')).not.toBeNull(),
    );
    // Step 5 on Integrations › Discord, at the button that connects it.
    fireEvent.click(within(tour()).getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Integrations', level: 1 })).toBeTruthy();
    expect(tour().textContent).toContain('5 of 5');
    expect(tour().textContent).toContain(
      'Connect Discord or Telegram: that’s where your members talk. Without it, StayPut only sees half of what’s going on.',
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-tour="connect-discord"]')).not.toBeNull(),
    );
    // Back with ←: the rule again, on its page.
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(await screen.findByRole('heading', { name: 'Automations', level: 1 })).toBeTruthy();
    expect(tour().textContent).toContain('4 of 5');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(await screen.findByRole('heading', { name: 'Integrations', level: 1 })).toBeTruthy();
    fireEvent.click(within(tour()).getByRole('button', { name: 'Done' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Done: the dashboard again, where the tour began.
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
  });

  it('ends the tour on the page it began from, whichever way it ends', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/members': [
        { status: 200, body: MEMBERS },
        { status: 200, body: MEMBERS },
        { status: 200, body: MEMBERS },
      ],
    });
    renderAt('/dashboard/biz_A1/members');
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replay the tour' }));
    // The tour starts on the dashboard…
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeTruthy();
    const tour = await screen.findByRole('dialog', { name: 'Tour of StayPut' });
    expect(tour.textContent).toContain('1 of 5');
    // …and Escape brings back Members.
    fireEvent.keyDown(window, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeTruthy();
  });

  it('stops the tour on Skip or Escape', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replay the tour' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replay the tour' }));
    const tour = await screen.findByRole('dialog', { name: 'Tour of StayPut' });
    fireEvent.click(within(tour).getByRole('button', { name: 'Skip' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a card’s place on its page, and goes straight to a shortcut’s screen', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/actions': [
        { status: 200, body: ACTION_SETTINGS },
        { status: 200, body: ACTION_SETTINGS },
      ],
    });
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    const guide = await screen.findByRole('dialog', { name: 'How StayPut works' });
    fireEvent.click(within(guide).getAllByRole('button', { name: 'Show me' })[1]!);
    // « Keep them, automatically »: Automations › Rules, at the payment retries, in the tour's
    // words — never a title alone.
    const shown = await screen.findByRole('dialog', { name: 'Keep them, automatically' });
    expect(await screen.findByRole('heading', { name: 'Automations', level: 1 })).toBeTruthy();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-tour="rule-payment-retry"]')).not.toBeNull(),
    );
    expect(within(shown).getByRole('heading').textContent).toBe('Keep them, automatically');
    expect(shown.textContent).toContain(
      'Decide what StayPut does on its own. Start with payment retries: zero risk, instant results.',
    );
    expect(shown.textContent).not.toMatch(/of 5/);
    fireEvent.click(within(shown).getByRole('button', { name: 'Got it' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // « You stay in control »: no tour step shows its place, so its caption goes in the light.
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'How StayPut works' })).getAllByRole(
        'button',
        {
          name: 'Show me',
        },
      )[3]!,
    );
    const control = await screen.findByRole('dialog', { name: 'You stay in control' });
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector('[data-tour="limits"]')).not.toBeNull());
    expect(document.querySelector('[data-tour="retries"] input')).not.toBeNull();
    expect(control.textContent).toContain(
      'StayPut never spams. One message per member every 5 days, no messages at night, a cap on discounts, and a list of members it must never contact. Change any of this in Settings.',
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    fireEvent.click(await screen.findByRole('button', { name: 'See who is about to leave' }));
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('welcomes a new community in four steps, saves the mode, reveals the audit, then tours', async () => {
    const risk: RiskSettingsView = {
      niche: 'other',
      weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
      recencyThresholdDays: 14,
      mediumFrom: 45,
      highFrom: 75,
    };
    const alumni: AlumniView = {
      offer: {
        name: 'Alumni',
        url: 'https://whop.com/checkout/plan_Alu1',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: '2026-10-01T10:00:05.000Z',
      },
      entered: 0,
      left: 0,
      returned: 0,
      returnRate: null,
      recovered: null,
      problem: null,
    };
    const calls = mockApi({
      ...dashboard(MEMBERS, INTEGRATIONS, { ...HOME, welcomed: false }),
      '/api/creator/biz_A1/alumni': [
        { status: 200, body: NO_ALUMNI },
        { status: 200, body: NO_ALUMNI },
      ],
      '/api/creator/biz_A1/settings/risk': [{ status: 200, body: risk }],
      'PUT /api/creator/biz_A1/settings/risk': [{ status: 200, body: risk }],
      'POST /api/creator/biz_A1/alumni': [{ status: 200, body: alumni }],
      'POST /api/creator/biz_A1/mode': [
        { status: 200, body: { ...ACTION_SETTINGS, mode: 'auto' } },
      ],
      'POST /api/creator/biz_A1/getting-started/welcomed': [{ status: 200, body: { done: true } }],
    });
    renderAt('/dashboard/biz_A1');
    const welcome = await screen.findByRole('dialog', { name: 'Welcome to StayPut' });
    expect(welcome.textContent).toContain('Who is about to leave');
    // What the community is about: its niche's weights and inactivity threshold, applied on
    // « Get started », its risk thresholds kept.
    const niches = within(welcome).getByRole('radiogroup', { name: 'Your community is about' });
    fireEvent.click(within(niches).getByRole('radio', { name: 'Fitness' }));
    expect(
      within(niches).getByRole('radio', { name: 'Fitness' }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(within(welcome).getByRole('button', { name: 'Get started' }));
    // Discord or Telegram, optional, each in one tap; what StayPut reads, said as everywhere.
    expect(
      await within(welcome).findByRole('heading', { name: 'Connect Discord or Telegram' }),
    ).toBeTruthy();
    expect(bodies.get('PUT /api/creator/biz_A1/settings/risk')).toEqual({
      niche: 'fitness',
      weights: { recency: 0.25, frequency: 0.2, progress: 0.3, payment: 0.15, friction: 0.1 },
      recencyThresholdDays: 10,
      mediumFrom: 45,
      highFrom: 75,
    });
    expect(welcome.textContent).toContain('Optional');
    expect(
      within(welcome).getByRole('link', { name: 'Connect Discord' }).getAttribute('href'),
    ).toBe(INTEGRATIONS.discord.install!.url);
    expect(
      within(welcome).getByRole('link', { name: 'Connect Telegram' }).getAttribute('href'),
    ).toBe(INTEGRATIONS.telegram.addToGroup!.url);
    expect(welcome.textContent).toContain(
      'StayPut never reads what members write: only who wrote, where and when.',
    );
    fireEvent.click(within(welcome).getByRole('button', { name: 'Next' }));
    // Automatic or manual: the community's mode first, the choice saved on Next.
    const choice = await within(welcome).findByRole('radiogroup', { name: 'Automatic or manual?' });
    expect(within(choice).getByRole<HTMLInputElement>('radio', { name: /^Manual/ }).checked).toBe(
      true,
    );
    fireEvent.click(within(choice).getByRole('radio', { name: /^Automatic/ }));
    fireEvent.click(within(welcome).getByRole('button', { name: 'Next' }));
    // The first audit: the dashboard's own figures.
    expect(await within(welcome).findByRole('heading', { name: 'Your first audit' })).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/mode')).toEqual({ mode: 'auto' });
    await vi.waitFor(() => expect(welcome.textContent).toContain('$98.00'));
    expect(welcome.textContent).toContain('members at risk');
    expect(welcome.textContent).toContain('threatened');
    expect(welcome.textContent).toContain('The most urgent come first on your dashboard.');
    // Former members: the Alumni offer in a click, then Whop's « User left » message to paste.
    const former = await within(welcome).findByRole('region', { name: 'Former members' });
    fireEvent.click(within(former).getByRole('button', { name: 'Create the Alumni offer' }));
    expect(
      (await within(former).findByRole<HTMLTextAreaElement>('textbox', { name: /User left/ }))
        .value,
    ).toContain('join the Alumni: https://whop.com/checkout/plan_Alu1');
    expect(bodies.get('POST /api/creator/biz_A1/alumni')).toEqual({ name: 'Alumni' });
    fireEvent.click(within(welcome).getByRole('button', { name: 'Take the tour' }));
    expect(await screen.findByRole('dialog', { name: 'Tour of StayPut' })).toBeTruthy();
    // Seen: it never opens by itself again.
    expect(calls).toContain('POST /api/creator/biz_A1/getting-started/welcomed');
  });

  it('closes the welcome for good on Skip, and never opens it in the demo unless asked', async () => {
    const calls = mockApi({
      ...dashboard(MEMBERS, INTEGRATIONS, { ...HOME, welcomed: false }),
      'POST /api/creator/biz_A1/getting-started/welcomed': [{ status: 200, body: { done: true } }],
    });
    renderAt('/dashboard/biz_A1');
    const welcome = await screen.findByRole('dialog', { name: 'Welcome to StayPut' });
    fireEvent.click(within(welcome).getByRole('button', { name: 'Skip' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toContain('POST /api/creator/biz_A1/getting-started/welcomed');
    cleanup();

    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo');
    expect(await screen.findByText('Atlas Trading Club')).toBeTruthy();
    await screen.findByRole('heading', { name: 'Needs attention' }, { timeout: 3_000 });
    expect(screen.queryByRole('dialog', { name: 'Welcome to StayPut' })).toBeNull();
    cleanup();
    renderAt('/demo?welcome');
    expect(
      await screen.findByRole('dialog', { name: 'Welcome to StayPut' }, { timeout: 3_000 }),
    ).toBeTruthy();
  });

  it('says what StayPut misses without Discord or Telegram, with the two ways to connect', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/sources');
    const invite = (
      await screen.findByRole('heading', { name: 'StayPut only sees what happens on Whop.' })
    ).closest('section')!;
    expect(invite.textContent).toContain(
      'Connect Discord or Telegram to spot members who are drifting away where they actually talk.',
    );
    for (const benefit of [
      'Earlier detection',
      'Messages at the right time',
      'A more accurate score',
    ]) {
      expect(invite.textContent).toContain(benefit);
    }
    expect(within(invite).getByRole('link', { name: 'Connect Discord' }).getAttribute('href')).toBe(
      INTEGRATIONS.discord.install!.url,
    );
    expect(
      within(invite).getByRole('link', { name: 'Connect Telegram' }).getAttribute('href'),
    ).toBe(INTEGRATIONS.telegram.addToGroup!.url);
  });
});

/** Every page of the demo's menu but its home, each tab included. */
const DEMO_PAGES = [
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
  'insights/reports',
  'sources',
  'sources/discord',
  'sources/telegram',
  'settings',
  'settings/risk',
  'settings/actions',
];

describe('the demo (/demo)', () => {
  it('shows an imaginary community, said as such, without calling StayPut', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/demo');
    expect(await screen.findByText('Atlas Trading Club')).toBeTruthy();
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        'You are exploring an imaginary community. Nothing here is real, and nothing you do is sent.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Leave the demo' }).getAttribute('href')).toBe('/');
    // Its figures, as a real community's: computed from its members.
    const hero = (await screen.findByRole('heading', { name: 'Your money this month' })).closest(
      'section',
    )!;
    await vi.waitFor(() =>
      expect(within(hero).getAllByRole('definition')[1]!.textContent).toBe('$731.17'),
    );
    expect(within(hero).getAllByRole('definition')[2]!.textContent).toBe('9');
    expect(await screen.findByText('Hugo Bernard')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^Getting started/ })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs the action of the day in the demo, and moves on, never calm', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo');
    const next = async (sentence: string, button: string, toast: string) => {
      await screen.findByRole('heading', { name: sentence }, { timeout: 3_000 });
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(await screen.findByText(toast, undefined, { timeout: 3_000 })).toBeTruthy();
    };
    // Manual mode: what waits for approval first, as on Automations.
    await next(
      'Approve the 6 actions StayPut prepared: $384.17 at risk',
      'Approve all',
      '6 actions approved',
    );
    // Then the failed payments, the members leaving, the member nobody reached.
    await next('Retry 3 failed payments: $347.00 at risk', 'Retry now', '3 payments retried now');
    await next(
      'Offer a pause to 3 members leaving: $237.17 at risk',
      'Offer a pause',
      'A pause offered to 3 members',
    );
    await next(
      'Message 1 high-risk member nobody reached: $49.00 at risk',
      'Send the message',
      '1 message queued',
    );
    // Three payments still unpaid: never « nothing urgent ».
    await screen.findByRole(
      'heading',
      { name: '3 members still have a failed payment: $347.00 at risk' },
      { timeout: 3_000 },
    );
    expect(screen.getByRole('link', { name: 'See who' }).getAttribute('href')).toBe(
      '/demo/members?filter=high',
    );
    expect(screen.queryByRole('heading', { name: 'Nothing urgent today' })).toBeNull();
  }, 20_000);

  it('brings a creator back to their own dashboard', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo?from=%2Fdashboard%2Fbiz_A1');
    expect(
      (
        await screen.findByRole('link', { name: 'Leave the demo' }, { timeout: 3_000 })
      ).getAttribute('href'),
    ).toBe('/dashboard/biz_A1');
  });

  it('fills every page of the demo: none stops on an error', async () => {
    vi.stubGlobal('fetch', vi.fn());
    for (const page of DEMO_PAGES) {
      renderAt(`/demo/${page}`);
      await screen.findByRole('heading', { level: 1 }, { timeout: 3_000 });
      // Each page's own data, read by the demo (its loading done), and never an error panel.
      await vi.waitFor(
        () => {
          expect(screen.queryByText('Loading…')).toBeNull();
          expect(document.querySelector('.skeleton')).toBeNull();
        },
        { timeout: 3_000 },
      );
      expect(screen.queryByRole('alert'), page).toBeNull();
      cleanup();
    }
    // Automations opens on its rules, the payment retries first; what waits is under To approve.
    renderAt('/demo/actions');
    const rules = await screen.findAllByRole('article', undefined, { timeout: 3_000 });
    expect(
      rules.map((rule) => within(rule).getByRole('heading', { level: 3 }).textContent),
    ).toEqual([
      'Payment retries',
      'Card update request',
      'Departure survey',
      'Check-in message',
      'Welcome message',
    ]);
    expect(rules[0]!.getAttribute('data-tour')).toBe('rule-payment-retry');
    cleanup();
    renderAt('/demo/actions/queue');
    expect(await screen.findByText('Margaux Picard', undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByText('Before you go')).toBeTruthy();
    cleanup();
    renderAt('/demo/insights/cohorts');
    expect(
      await screen.findByText(/left 1\.\d times more than your average within 30 days/, undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();
  }, 40_000);

  it('turns a rule off in the demo, answered in the browser', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/demo/actions');
    const toggle = await screen.findByRole(
      'switch',
      { name: 'Welcome message' },
      { timeout: 3_000 },
    );
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(toggle.getAttribute('aria-busy')).toBeNull(), {
      timeout: 3_000,
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // Read again, the community remembers it.
    cleanup();
    renderAt('/demo/actions');
    const again = await screen.findByRole(
      'switch',
      { name: 'Welcome message' },
      { timeout: 3_000 },
    );
    expect(again.getAttribute('aria-checked')).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ties a Discord account from its own tab, and the source’s count follows', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/sources/discord');
    expect(
      await screen.findByText('2 recent authors not linked to a member', undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();
    const accounts = await screen.findByRole('region', { name: 'Discord accounts' });
    expect(await within(accounts).findByText('To tie (2)')).toBeTruthy();
    fireEvent.click(within(accounts).getByRole('button', { name: /^Tie to Margaux Picard/ }));
    expect(await within(accounts).findByText('To tie (1)')).toBeTruthy();
    expect(await screen.findByText('1 recent author not linked to a member')).toBeTruthy();
  });

  it('says calmly when a screen has no demo data, never as an error', async () => {
    const { ApiError } = await import('../src/api');
    render(
      <I18nProvider initialLocale="fr">
        <RouterProvider
          router={createMemoryRouter([
            {
              path: '/',
              element: (
                <ErrorPanel
                  error={new ApiError('demo', 'no demo data')}
                  forbiddenKey="error.forbidden.creator"
                />
              ),
            },
          ])}
        />
      </I18nProvider>,
    );
    expect(
      screen.getByText('Cet écran se remplit avec les données de votre propre communauté.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Cette page n’a pas pu s’ouvrir')).toBeNull();
  });
});

describe('the demo tells one story (fix prompt v4.1, block 4)', () => {
  const number = (text: string | null | undefined) => /(\d+)\)?\s*$/.exec(text ?? '')?.[1] ?? '';

  it('shows a paused member as paused, and a member gone as ended', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/members');
    const table = await screen.findByRole('table', { name: 'All members' }, { timeout: 3_000 });
    const row = (name: string) =>
      within(table)
        .getAllByRole('row')
        .find((r) => r.textContent?.includes(name))!;
    await within(table).findByText('Juliette Caron', undefined, { timeout: 3_000 });
    expect(row('Juliette Caron').textContent).toMatch(/Paused · resumes \w{3} \d{1,2}/);
    // Paul Henry has no score among the others: he left, at the end of the month he paid.
    expect(row('Paul Henry').textContent).toContain('Gone');
    expect(within(row('Paul Henry')).queryByRole('img')).toBeNull();
    // Her drawer says the pause too; Paul's, that his membership ended.
    fireEvent.click(within(row('Juliette Caron')).getByRole('button', { name: /^Open/ }));
    const juliette = await screen.findByRole('dialog', { name: 'Juliette Caron' });
    await within(juliette).findByText(/^Paused · \$149\.00 per month · resumes on /);
    expect(within(juliette).getByText(/^Paused · resumes /)).toBeTruthy();
    fireEvent.click(within(juliette).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(row('Paul Henry')).getByRole('button', { name: /^Open/ }));
    const paul = await screen.findByRole('dialog', { name: 'Paul Henry' });
    const line = await within(paul).findByText(/^Canceled · \$49\.00 per month · /);
    expect(line.textContent).toMatch(/ended on/);
    expect(paul.textContent).not.toMatch(/renews/i);
  }, 20_000);

  it('says what came of each action in the History, the proof of value', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/actions/queue/history');
    await screen.findByText('Clara Faure', undefined, { timeout: 3_000 });
    const badge = (name: string) =>
      [...document.querySelectorAll<HTMLElement>('[data-outcome]')]
        .filter((b) => b.closest('li')?.textContent?.includes(name))
        .map((b) => b.textContent);
    expect(badge('Clara Faure')).toContain('Recovered $49.00');
    expect(badge('Elena Novak')).toContain('Still failing');
    expect(badge('Juliette Caron')[0]).toMatch(/^Paused until \w{3} \d{1,2}/);
    expect(badge('Victor Leclerc')).toContain('Came back');
    expect(badge('Lou Marchand')).toContain('No reply yet');
    expect(badge('Sabrina Aït')).toContain('Left');
    // What was blocked says so, as before.
    const tom = screen
      .getAllByText('Tom Barbier')
      .map((name) => name.closest('li')!)
      .find((li) => li.textContent?.includes('Blocked'));
    expect(tom).toBeTruthy();
  }, 20_000);

  it('moves the tab and « Approve all » together when one action is approved', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/actions/queue');
    const all = await screen.findByRole('button', { name: /^Approve all/ }, { timeout: 3_000 });
    const tab = () => screen.getByRole('link', { name: /^To approve/ });
    await vi.waitFor(() => expect(number(tab().textContent)).toBe('6'));
    expect(all.textContent).toBe('Approve all (6)');
    // Every change the page shows, the two counts side by side: never one without the other.
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const button = screen.queryByRole('button', { name: /^Approve all/ });
      seen.push(`${number(tab().textContent)}|${number(button?.textContent)}`);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
    await vi.waitFor(
      () =>
        expect(screen.getByRole('button', { name: /^Approve all/ }).textContent).toBe(
          'Approve all (5)',
        ),
      { timeout: 3_000 },
    );
    expect(number(tab().textContent)).toBe('5');
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.disconnect();
    expect(seen.length).toBeGreaterThan(0);
    for (const pair of seen) {
      const [inTab, inButton] = pair.split('|');
      if (inButton) expect(inTab, pair).toBe(inButton);
    }
  }, 20_000);

  it('says since when a failed payment is unpaid, never a renewal still to come', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo');
    const attention = await screen.findByRole(
      'region',
      { name: 'Needs attention' },
      {
        timeout: 3_000,
      },
    );
    const sarah = (await within(attention).findByText('Sarah Cohen')).closest('li')!;
    expect(sarah.textContent).toMatch(/Unpaid since \w{3} \d{1,2}/);
    expect(sarah.textContent).not.toMatch(/Renews/);
  }, 20_000);

  it('gives Discord and Telegram each a dashboard of its own, live, from the demo’s members', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/demo/sources/telegram');
    const hero = await vi.waitFor(
      () => {
        const found = document.querySelector<HTMLElement>('[data-hero="platform"]');
        if (!found) throw new Error('no hero yet');
        return found;
      },
      { timeout: 3_000 },
    );
    expect(hero.getAttribute('data-connection')).toBe('live');
    await vi.waitFor(() => expect(heroFiguresOf(hero).every((f) => /^\d+$/.test(f))).toBe(true), {
      timeout: 3_000,
    });
    // Its group's topics by name, its members with their rings; nothing asked of StayPut.
    expect(await screen.findByRole('heading', { name: 'Groups and topics' })).toBeTruthy();
    expect(document.querySelectorAll('[data-place][data-kind="topic"]').length).toBe(2);
    expect(document.querySelector('[data-list="active"] [data-member]')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    // The former Activity tab leads to Discord's.
    cleanup();
    renderAt('/demo/sources/activity');
    expect(
      await screen.findByRole('heading', { name: 'Channels' }, { timeout: 3_000 }),
    ).toBeTruthy();
  }, 20_000);
});

describe('the demo leads nowhere outside StayPut (fix prompt v4.1, block 5)', () => {
  /** The words an element's `aria-describedby` points at. */
  const description = (element: Element) =>
    (element.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .map((id) => (id ? (document.getElementById(id)?.textContent ?? '') : ''))
      .join(' ')
      .trim();

  /**
   * Nothing on the screen leads outside StayPut: links within it only, none to a new tab, and
   * every button that would open a page outside said disabled.
   */
  const expectNoWayOut = (where: string) => {
    for (const link of document.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') ?? '';
      expect(href.startsWith('/') && !href.startsWith('//'), `${where}: ${href}`).toBe(true);
      expect(link.getAttribute('target'), `${where}: ${href}`).toBeNull();
    }
    for (const button of document.querySelectorAll('[data-demo-disabled]')) {
      expect(button.getAttribute('aria-disabled'), where).toBe('true');
      expect(description(button), where).toBe('Disabled in the demo');
    }
  };

  it('shows the Alumni link as an example, « Open » said disabled', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/actions/queue/alumni');
    expect(
      await screen.findByText('https://whop.com/your-community/alumni', undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();
    expect(screen.getByText('Example')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Open/ })).toBeNull();
    const open = screen.getByRole('button', { name: 'Open' });
    expect(open.getAttribute('aria-disabled')).toBe('true');
    expect(description(open)).toBe('Disabled in the demo');
    // Tapped (a phone has no hover), it opens nothing and takes the focus: its tip shows.
    fireEvent.click(open);
    expect(document.activeElement).toBe(open);
    expect(screen.getByText('https://whop.com/your-community/alumni')).toBeTruthy();
    // Whop's « User left » message carries the example too.
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /User left/ }).value).toContain(
      'join the Alumni: https://whop.com/your-community/alumni',
    );
    expectNoWayOut('actions/queue/alumni');
  });

  it('says it in French too', async () => {
    render(
      <I18nProvider initialLocale="fr">
        <DemoMode on>
          <AlumniCard api={`/api/creator/${DEMO_COMPANY_ID}`} whopAppId={null} />
        </DemoMode>
      </I18nProvider>,
    );
    expect(
      await screen.findByText('https://whop.com/your-community/alumni', undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();
    expect(screen.getByText('Exemple')).toBeTruthy();
    const open = screen.getByRole('button', { name: 'Ouvrir' });
    expect(open.getAttribute('aria-disabled')).toBe('true');
    expect(description(open)).toBe('Désactivé dans la démo');
  });

  it('shows the buttons that connect Discord and Telegram, said disabled', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/sources/discord');
    const discord = await screen.findByRole(
      'button',
      { name: 'Add another server' },
      { timeout: 3_000 },
    );
    expect(discord.getAttribute('aria-disabled')).toBe('true');
    expect(description(discord)).toBe('Disabled in the demo');
    // The dashboard's « Reconnect » too: where the tour's last step lights up.
    const reconnect = screen.getByRole('button', { name: 'Reconnect' });
    expect(reconnect.getAttribute('aria-disabled')).toBe('true');
    expect(reconnect.getAttribute('data-tour')).toBe('connect-discord');
    expect(description(reconnect)).toBe('Disabled in the demo');
    cleanup();
    renderAt('/demo/sources/telegram');
    const telegram = await screen.findByRole(
      'button',
      { name: 'Add another group' },
      { timeout: 3_000 },
    );
    expect(telegram.getAttribute('aria-disabled')).toBe('true');
    expect(description(telegram)).toBe('Disabled in the demo');
  });

  it('leads nowhere outside StayPut from any page, the guide and a member’s drawer', async () => {
    vi.stubGlobal('fetch', vi.fn());
    for (const page of ['', ...DEMO_PAGES]) {
      renderAt(`/demo${page ? `/${page}` : ''}`);
      await screen.findByRole('heading', { level: 1 }, { timeout: 3_000 });
      await vi.waitFor(
        () => {
          expect(screen.queryByText('Loading…')).toBeNull();
          expect(document.querySelector('.skeleton')).toBeNull();
        },
        { timeout: 3_000 },
      );
      expectNoWayOut(page || 'home');
      cleanup();
    }
    renderAt('/demo');
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }, { timeout: 3_000 }));
    await screen.findByRole('dialog', { name: 'How StayPut works' });
    expectNoWayOut('guide');
    cleanup();
    renderAt('/demo/members');
    const table = await screen.findByRole('table', { name: 'All members' }, { timeout: 3_000 });
    const hugo = await within(table).findByText('Hugo Bernard', undefined, { timeout: 3_000 });
    fireEvent.click(
      within(hugo.closest('[role=row]')!).getByRole('button', { name: /^Open Hugo Bernard/ }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'Hugo Bernard' });
    await within(drawer).findByRole('button', { name: /^Offer Hugo Bernard/ });
    expectNoWayOut('drawer');
  }, 40_000);

  it('keeps the real link outside the demo', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [
        {
          status: 200,
          body: {
            view: 'queue',
            counts: { queue: 0, scheduled: 0, history: 0 },
            actions: [],
            mode: 'manual',
            dryRun: false,
            killSwitch: false,
          } satisfies ActionsPage,
        },
      ],
      '/api/creator/biz_A1/alumni': [
        {
          status: 200,
          body: {
            offer: {
              name: 'Alumni du Club',
              url: 'https://whop.com/le-club/alumni-du-club/',
              createdAt: '2026-10-01T10:00:00.000Z',
              completedAt: '2026-10-01T10:05:00.000Z',
            },
            entered: 3,
            left: 0,
            returned: 1,
            returnRate: 0.25,
            recovered: { amount: 49, currency: 'usd', otherCurrencies: false },
          } satisfies AlumniView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/actions/queue/alumni');
    const open = await screen.findByRole('link', { name: /^Open/ });
    expect(open.getAttribute('href')).toBe('https://whop.com/le-club/alumni-du-club/');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(screen.queryByText('Example')).toBeNull();
    expect(document.querySelector('[data-demo-disabled]')).toBeNull();
  });
});

describe('the Alumni’s figures (SPEC Phase 6.13)', () => {
  const offer = {
    name: 'Alumni du Club',
    url: 'https://whop.com/le-club/alumni-du-club/',
    createdAt: '2026-10-01T10:00:00.000Z',
    completedAt: '2026-10-01T10:05:00.000Z',
  };
  const figures = () =>
    Array.from(document.querySelectorAll('[data-alumni-figures] dd')).map((dd) => dd.textContent);
  const caption = () => document.querySelector('[data-alumni-figures] > p')?.textContent;

  it('shows who is in it, the share who came back and what they paid since', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/alumni': [
        {
          status: 200,
          body: {
            offer,
            entered: 9,
            left: 1,
            returned: 2,
            returnRate: 2 / 12,
            recovered: { amount: 147, currency: 'usd', otherCurrencies: false },
          } satisfies AlumniView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/actions/queue/alumni');
    await vi.waitFor(() => expect(figures()).toEqual(['9', '17%', '$147.00']));
    expect(caption()).toBe('12 former members entered the Alumni. Came back: 2 · left it: 1.');
    // What each counts is its label's tooltip.
    expect(
      within(document.querySelector<HTMLElement>('[data-alumni-figures]')!)
        .getAllByRole('tooltip')
        .map((tip) => tip.textContent),
    ).toEqual([
      'Former members in the Alumni now, who do not pay yet.',
      'Of all the former members who ever entered the Alumni, the share who pay again.',
      'What the former members who came back paid since they entered the Alumni. Refunds are left out.',
    ]);
  });

  it('says « not yet » before anyone entered, in French too', async () => {
    window.localStorage.setItem('stayput.locale.biz_A1', 'fr');
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/alumni': [
        {
          status: 200,
          body: {
            offer,
            entered: 0,
            left: 0,
            returned: 0,
            returnRate: null,
            recovered: null,
          } satisfies AlumniView,
        },
      ],
    });
    renderAt('/dashboard/biz_A1/actions/queue/alumni');
    await vi.waitFor(() => expect(figures()).toEqual(['0', 'Pas encore', 'Pas encore']));
    expect(caption()).toBe(
      'Aucun ancien membre n’est encore entré dans l’Alumni. On y entre par le lien ci-dessous.',
    );
  });
});

describe('the words (fix prompt v4.1, block 6)', () => {
  it('lists English first among the messages’ languages', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo/settings/actions');
    const languages = await screen.findByRole<HTMLSelectElement>(
      'combobox',
      { name: 'Language of the messages' },
      { timeout: 3_000 },
    );
    expect([...languages.options].map((option) => option.textContent)).toEqual([
      'English',
      'French',
    ]);
  });

  it('calls the guide « How StayPut works », in English and in French', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderAt('/demo');
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }, { timeout: 3_000 }));
    expect(await screen.findByRole('dialog', { name: 'How StayPut works' })).toBeTruthy();
    cleanup();
    // French chosen in the demo's Settings, for the visit.
    renderAt('/demo/settings');
    const languages = await screen.findByRole('radiogroup', { name: 'Language' });
    fireEvent.click(within(languages).getByRole('radio', { name: 'Français' }));
    await screen.findByRole('heading', { name: 'Réglages', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Guide' }));
    expect(await screen.findByRole('dialog', { name: 'Comment marche StayPut' })).toBeTruthy();
  });
});

describe('the actions (SPEC Phase 4)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const row = (over: Partial<ActionRow> = {}): ActionRow => ({
    id: ID,
    type: 'welcome_message',
    status: 'proposed',
    trigger: 'activation_radar',
    member: { id: 'mber_1', name: 'Ana Lopez' },
    sendAt: '2026-10-01T10:00:00.000Z',
    sentAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    blockedReason: null,
    message: { title: 'Welcome, Ana', body: 'Glad to have you in Le Club.' },
    note: null,
    offer: null,
    ...over,
  });
  const page = (
    view: ActionsPage['view'],
    actions: ActionRow[],
    over: Partial<ActionsPage> = {},
  ): { status: number; body: ActionsPage } => ({
    status: 200,
    body: {
      view,
      counts: { queue: 1, scheduled: 0, history: 4 },
      actions,
      mode: 'manual',
      dryRun: false,
      killSwitch: false,
      ...over,
    },
  });

  it('opens on its rules: a switch each, the mode, the limits, the messages (brief v4 §9.4)', async () => {
    const never = MEMBERS.members.map((m, i) => (i === 0 ? { ...m, doNotContact: true } : m));
    mockApi({
      ...dashboard({ ...MEMBERS, members: never }),
      '/api/creator/biz_A1/settings/actions': [
        {
          status: 200,
          body: { ...ACTION_SETTINGS, maxPaymentRetries: 0, rulesOff: ['welcome'] },
        },
      ],
    });
    renderAt('/dashboard/biz_A1/actions');
    const rules = await screen.findAllByRole('article');
    expect(
      rules.map((rule) => within(rule).getByRole('heading', { level: 3 }).textContent),
    ).toEqual([
      'Payment retries',
      'Card update request',
      'Departure survey',
      'Check-in message',
      'Welcome message',
    ]);
    // Each rule: when → if → then, and its own switch, named after it.
    const retries = rules[0]!;
    expect(retries.textContent).toContain('A payment fails');
    // On, but the limits allow no retry: it says so.
    expect(retries.textContent).toContain('Nothing for now: your limits allow no retry');
    const switchOf = (rule: HTMLElement) =>
      within(rule).getByRole('switch', {
        name: within(rule).getByRole('heading', { level: 3 }).textContent,
      });
    expect(rules.map((rule) => switchOf(rule).getAttribute('aria-checked'))).toEqual([
      'true',
      'true',
      'true',
      'true',
      'false',
    ]);
    // A retry writes nothing: no preview; every message has one, in the members' language.
    expect(within(retries).queryByRole('button', { name: /Preview message/ })).toBeNull();
    const welcome = rules[4]!;
    const preview = within(welcome).getByRole('button', { name: /^Preview message/ });
    expect(preview.textContent).toContain('EN');
    expect(within(welcome).getByText('Sent in English')).toBeTruthy();
    expect(preview.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(preview);
    expect(preview.getAttribute('aria-expanded')).toBe('true');
    expect(await within(welcome).findByText('Welcome, Alex')).toBeTruthy();
    expect(
      within(welcome).getByText(
        'Glad to have you in Le Club. The best first step: say hello to the community, then start the first lesson.',
      ),
    ).toBeTruthy();
    expect(within(welcome).getByText('Example for a member named Alex')).toBeTruthy();
    expect(within(welcome).getByRole('link', { name: 'Edit the text' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/settings/actions',
    );
    // Who decides, on the page itself.
    const mode = screen.getByRole('radiogroup', { name: 'Mode' });
    expect(within(mode).getByRole('radio', { name: 'Manual' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByText('StayPut asks you first: you approve each action.')).toBeTruthy();
    // The limits every rule stays within.
    const limits = screen.getByRole('region', { name: 'Your limits' });
    expect(within(limits).getByText('1 per member every 5 days, 4 a month at most')).toBeTruthy();
    expect(within(limits).getByText('22:00 to 08:00')).toBeTruthy();
    expect(within(limits).getByText('10 a month at most')).toBeTruthy();
    expect(within(limits).getByRole('link', { name: '1 member' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/members/never-contact',
    );
    expect(
      within(limits)
        .getByRole('link', { name: /Change my limits/ })
        .getAttribute('href'),
    ).toBe('/dashboard/biz_A1/settings/actions');
    expect(document.body.textContent).not.toMatch(/guardrail/i);
    // Two tabs: the rules, and the queue (history and the Alumni offer are its filters).
    const tabs = screen.getByRole('navigation', { name: 'Automations tabs' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['Rules', '/dashboard/biz_A1/actions'],
      ['Queue', '/dashboard/biz_A1/actions/queue'],
    ]);
  });

  it('turns a rule off and on from its switch, and says when it could not', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
      'PUT /api/creator/biz_A1/rules/check_in': [
        { status: 200, body: { ...ACTION_SETTINGS, rulesOff: ['check_in'] } },
        { status: 500, body: { error: { code: 'internal', message: 'boom' } } },
      ],
    });
    renderAt('/dashboard/biz_A1/actions');
    const toggle = await screen.findByRole('switch', { name: 'Check-in message' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    // At once, before the Worker answers.
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await vi.waitFor(() => expect(calls).toContain('PUT /api/creator/biz_A1/rules/check_in'));
    expect(bodies.get('PUT /api/creator/biz_A1/rules/check_in')).toEqual({ on: false });
    await vi.waitFor(() => expect(toggle.getAttribute('aria-busy')).toBeNull());
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    // The Worker fails: the switch goes back, and the page says it.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByText('This rule did not change. Try again.')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('changes the mode on the page, as the welcome does', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
      'POST /api/creator/biz_A1/mode': [
        { status: 200, body: { ...ACTION_SETTINGS, mode: 'auto' } },
      ],
    });
    renderAt('/dashboard/biz_A1/actions');
    const mode = await screen.findByRole('radiogroup', { name: 'Mode' });
    fireEvent.click(within(mode).getByRole('radio', { name: 'Automatic' }));
    expect(
      within(mode).getByRole('radio', { name: 'Automatic' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(screen.getByText('StayPut acts on its own, within your limits.')).toBeTruthy();
    expect(
      await screen.findByText('Automatic mode: actions leave on their own, within your limits.'),
    ).toBeTruthy();
    expect(calls).toContain('POST /api/creator/biz_A1/mode');
    expect(bodies.get('POST /api/creator/biz_A1/mode')).toEqual({ mode: 'auto' });
  });

  it('offers three ready-made rules when every rule is off (brief v4 §9.4)', async () => {
    const allOff = {
      ...ACTION_SETTINGS,
      rulesOff: ['check_in', 'exit_survey', 'payment_notice', 'payment_retry', 'welcome'],
    } satisfies ActionSettingsView;
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: allOff }],
      'PUT /api/creator/biz_A1/rules/payment_retry': [
        {
          status: 200,
          body: { ...allOff, rulesOff: ['check_in', 'exit_survey', 'payment_notice', 'welcome'] },
        },
      ],
      'PUT /api/creator/biz_A1/rules/payment_notice': [
        { status: 200, body: { ...allOff, rulesOff: ['check_in', 'exit_survey', 'welcome'] } },
      ],
      'PUT /api/creator/biz_A1/rules/exit_survey': [
        { status: 200, body: { ...allOff, rulesOff: ['check_in', 'welcome'] } },
      ],
    });
    renderAt('/dashboard/biz_A1/actions');
    expect(await screen.findByText('No rule is on')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
    const ready = screen.getByText('Payment retries').closest('ul')!;
    const items = within(ready).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-ready'))).toEqual([
      'payment_retry',
      'payment_notice',
      'exit_survey',
    ]);
    expect(items.map((li) => li.querySelector('.font-medium')?.textContent)).toEqual([
      'Payment retries',
      'Card update request',
      'Departure survey',
    ]);
    // The page's one primary button.
    expect(document.querySelectorAll('.button-primary')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on these 3 rules' }));
    const rules = await screen.findAllByRole('article');
    expect(
      rules.map((rule) => within(rule).getByRole('switch').getAttribute('aria-checked')),
    ).toEqual(['true', 'true', 'true', 'false', 'false']);
    for (const rule of ['payment_retry', 'payment_notice', 'exit_survey']) {
      expect(calls).toContain(`PUT /api/creator/biz_A1/rules/${rule}`);
      expect(bodies.get(`PUT /api/creator/biz_A1/rules/${rule}`)).toEqual({ on: true });
    }
  });

  it('keeps the scheduled, the history and the Alumni offer as filters of the queue', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [page('queue', [row()])],
      '/api/creator/biz_A1/actions?view=history': [page('history', [])],
    });
    renderAt('/dashboard/biz_A1/actions/queue');
    expect(await screen.findByText('Welcome, Ana')).toBeTruthy();
    const filters = screen.getByRole('navigation', { name: 'Show' });
    const links = () =>
      within(filters)
        .getAllByRole('link')
        .map((link) => [
          link.textContent,
          link.getAttribute('href'),
          link.getAttribute('aria-current'),
        ]);
    expect(links()).toEqual([
      ['To approve1', '/dashboard/biz_A1/actions/queue', 'page'],
      ['Scheduled0', '/dashboard/biz_A1/actions/queue/scheduled', null],
      ['History4', '/dashboard/biz_A1/actions/queue/history', null],
      ['Alumni offer', '/dashboard/biz_A1/actions/queue/alumni', null],
    ]);
    // The section's Queue tab counts what waits for approval.
    const tabs = screen.getByRole('navigation', { name: 'Automations tabs' });
    expect(within(tabs).getByRole('link', { name: /^Queue/ }).textContent).toBe('Queue1');
    // One primary button for the page; each row's « Approve » and « Skip » are ghosts.
    expect([...document.querySelectorAll('.button-primary')].map((b) => b.textContent)).toEqual([
      'Approve all (1)',
    ]);
    expect(screen.getByRole('button', { name: 'Approve' }).className).toContain('button-ghost');
    expect(screen.getByRole('button', { name: 'Skip' }).className).not.toContain('button-primary');
    // A filter keeps the Queue tab open.
    fireEvent.click(within(filters).getByRole('link', { name: /^History/ }));
    expect(await screen.findByText('No action yet.')).toBeTruthy();
    expect(
      within(tabs)
        .getByRole('link', { name: /^Queue/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      within(filters)
        .getByRole('link', { name: /^History/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('opens the filters’ former addresses on their filter', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=history': [
        page('history', [row({ status: 'sent', sentAt: '2026-10-01T11:00:00.000Z' })]),
      ],
    });
    renderAt('/dashboard/biz_A1/actions/history');
    expect(await screen.findByText('Welcome, Ana')).toBeTruthy();
    const filters = screen.getByRole('navigation', { name: 'Show' });
    expect(
      within(filters)
        .getByRole('link', { name: /^History/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('opens an older link to the queue on its tab', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [page('queue', [row()])],
    });
    renderAt('/dashboard/biz_A1/actions?view=queue');
    expect(await screen.findByText('Welcome, Ana')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('shows each action to approve with its message as it will read, and approves it', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [page('queue', [row()]), page('queue', [])],
      'POST /api/creator/biz_A1/actions/approve': [{ status: 200, body: { approved: 1 } }],
    });
    renderAt('/dashboard/biz_A1/actions/queue');
    expect(await screen.findByText('Welcome, Ana')).toBeTruthy();
    expect(screen.getByText('Glad to have you in Le Club.')).toBeTruthy();
    expect(screen.getByText('Sends as soon as you approve it')).toBeTruthy();
    expect(screen.getByText('Manual mode: nothing leaves without your approval.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve all (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await vi.waitFor(() => expect(calls).toContain('POST /api/creator/biz_A1/actions/approve'));
    expect(bodies.get('POST /api/creator/biz_A1/actions/approve')).toEqual({ ids: [ID] });
    expect(
      await screen.findByText(
        'Nothing to approve. StayPut proposes an action as soon as a member needs one.',
      ),
    ).toBeTruthy();
  });

  it('says when each message leaves, in plain words, with « Skip » beside « Approve »', async () => {
    // Fix prompt v4.1, block 6: never « golden hour », never « Cancel » for an action to approve.
    const inTwoHours = new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString();
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [
        page('queue', [
          row({ id: '22222222-2222-4222-8222-222222222222', sendAt: null }),
          row({ status: 'scheduled', sendAt: inTwoHours }),
        ]),
      ],
    });
    renderAt('/dashboard/biz_A1/actions/queue');
    expect(await screen.findByText('Sends at the hour they’re usually online')).toBeTruthy();
    expect(screen.getByText('Sends in 2 hours')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Skip' }).length).toBe(2);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/golden/i);
  });

  it('tells what happened: simulated in test mode, blocked with the reason, failed, cancelled', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [page('queue', [row()], { dryRun: true })],
      '/api/creator/biz_A1/actions?view=history': [
        page(
          'history',
          [
            row({ id: 'a', status: 'simulated', sentAt: '2026-10-01T11:00:00.000Z' }),
            row({
              id: 'b',
              type: 'high_risk_message',
              trigger: 'score_high',
              status: 'blocked_by_guardrail',
              blockedReason: 'message_spacing',
              message: null,
            }),
            row({ id: 'c', status: 'failed', note: '403 forbidden: missing permission' }),
            row({
              id: 'd',
              type: 'payment_retry',
              trigger: 'payment_failed',
              status: 'cancelled',
              note: 'payment_no_longer_failed',
              message: null,
            }),
            row({
              id: 'e',
              type: 'alumni_followup',
              trigger: 'alumni',
              alumniStep: 30,
              status: 'cancelled',
              note: 'member_returned',
              message: null,
            }),
          ],
          { dryRun: true },
        ),
      ],
    });
    renderAt('/dashboard/biz_A1/actions/queue');
    expect(
      await screen.findByText(
        'Test mode: every action is computed and kept, nothing is sent to your members.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /History/ }));
    expect(await screen.findByText('Another message within 5 days')).toBeTruthy();
    expect(calls).toContain('/api/creator/biz_A1/actions?view=history');
    expect(screen.getByText('Simulated')).toBeTruthy();
    expect(screen.getByText('Error: 403 forbidden: missing permission')).toBeTruthy();
    expect(screen.getByText('The payment went through in the meantime')).toBeTruthy();
    expect(screen.getByText('Check-in message')).toBeTruthy();
    // An Alumni follow-up: its step, and why it no longer goes.
    expect(screen.getByText('· 30 days after leaving, in the Alumni')).toBeTruthy();
    expect(screen.getByText('The member came back to a paid offer')).toBeTruthy();
    // Done: nothing to approve or cancel any more.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });

  it('shows an offer a member accepted: their reason, the offer, the discount and consent', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [page('queue', [])],
      '/api/creator/biz_A1/actions?view=history': [
        page('history', [
          row({
            id: 'p',
            type: 'promo_offer',
            trigger: 'exit_survey',
            status: 'sent',
            sentAt: '2026-10-01T11:00:00.000Z',
            message: null,
            offer: {
              reason: 'too_expensive',
              percentOff: 20,
              months: 3,
              keep: true,
              promoApplied: true,
            },
          }),
          // Before discounts went on the membership: a code to type, kept as it was.
          row({
            id: 'o',
            type: 'promo_offer',
            trigger: 'exit_survey',
            status: 'sent',
            sentAt: '2026-09-20T11:00:00.000Z',
            message: null,
            offer: {
              reason: 'too_expensive',
              percentOff: 20,
              months: 3,
              keep: false,
              promoCode: 'STAY-ABCD2345',
              expiresAt: '2026-09-27T12:00:00.000Z',
            },
          }),
          row({
            id: 'q',
            type: 'coaching_offer',
            trigger: 'exit_survey',
            status: 'sent',
            sentAt: '2026-10-01T11:00:00.000Z',
            message: null,
            offer: { reason: 'no_results', keep: true },
          }),
        ]),
      ],
    });
    renderAt('/dashboard/biz_A1/actions?view=history');
    expect(
      await screen.findByText('Applied to the membership: it comes off the next payments'),
    ).toBeTruthy();
    expect(screen.getByText('Code STAY-ABCD2345, valid until Sep 27, 2026')).toBeTruthy();
    expect(screen.getAllByText('Reason: “It’s too expensive”')).toHaveLength(2);
    expect(screen.getAllByText('20% off for 3 months')).toHaveLength(2);
    expect(screen.getAllByText('· Answer to the departure survey')).toHaveLength(3);
    expect(screen.getByText('Reason: “I’m not getting the results I expected”')).toBeTruthy();
    expect(screen.getAllByText('Membership kept, with the member’s consent')).toHaveLength(2);
    expect(screen.getByText('Your turn: write to the member on Whop.')).toBeTruthy();
    // Applied to the membership, not sent.
    expect(screen.getAllByText('Applied')).toHaveLength(3);
    expect(screen.queryByText('Sent')).toBeNull();
  });

  it('creates the Alumni offer, says which permission is missing, then gives its link', async () => {
    const stopped: AlumniView = {
      offer: {
        name: 'Alumni du Club',
        url: 'https://whop.com/checkout/plan_Alu1',
        createdAt: '2026-10-01T10:00:00.000Z',
        completedAt: null,
      },
      entered: 0,
      left: 0,
      returned: 0,
      returnRate: null,
      recovered: null,
      problem: { step: 'experience', permission: 'experience:create' },
    };
    const ready: AlumniView = {
      ...stopped,
      offer: { ...stopped.offer!, completedAt: '2026-10-01T10:05:00.000Z' },
      entered: 3,
      returned: 1,
      returnRate: 0.25,
      recovered: { amount: 49, currency: 'usd', otherCurrencies: false },
      problem: null,
    };
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [page('queue', [])],
      'POST /api/creator/biz_A1/alumni': [
        { status: 200, body: stopped },
        { status: 200, body: ready },
      ],
    });
    renderAt('/dashboard/biz_A1/actions/alumni');
    const name = await screen.findByRole<HTMLInputElement>('textbox', {
      name: 'Name of the offer',
    });
    expect(name.value).toBe('Alumni');
    fireEvent.change(name, { target: { value: 'Alumni du Club' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the Alumni offer' }));
    expect(
      await screen.findByText(/StayPut does not have the “experience:create” permission/),
    ).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/alumni')).toEqual({ name: 'Alumni du Club' });
    fireEvent.click(screen.getByRole('button', { name: 'Finish creating it' }));
    expect(await screen.findByText('Your Alumni offer “Alumni du Club” is ready.')).toBeTruthy();
    expect(screen.getByText('https://whop.com/checkout/plan_Alu1')).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /User left/ }).value).toContain(
      'join the Alumni: https://whop.com/checkout/plan_Alu1',
    );
    expect(
      screen.getByText('4 former members entered the Alumni. Came back: 1 · left it: 0.'),
    ).toBeTruthy();
    expect(calls.filter((c) => c === 'POST /api/creator/biz_A1/alumni')).toHaveLength(2);
  });

  it('sets the creator’s own offers, without the departure survey’s (no member space)', async () => {
    mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/risk': [
        {
          status: 200,
          body: {
            niche: 'other',
            weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
            recencyThresholdDays: 14,
            mediumFrom: 40,
            highFrom: 70,
          },
        },
      ],
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
    });
    renderAt('/dashboard/biz_A1/settings/actions');
    expect(await screen.findByRole('spinbutton', { name: 'Pause, in days' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Discount, in %' })).toBeTruthy();
    expect(screen.getByText(/A pause is proposed in the support chat/)).toBeTruthy();
    // The departure survey's answers belong to a space members no longer have.
    expect(screen.queryByRole('spinbutton', { name: /Free days \(/ })).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: /Your words to a member without results/ }),
    ).toBeNull();
  });

  it('sets the departure offers, within their limits (with the member space)', async () => {
    spaceOn();
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/risk': [
        {
          status: 200,
          body: {
            niche: 'other',
            weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
            recencyThresholdDays: 14,
            mediumFrom: 40,
            highFrom: 70,
          },
        },
      ],
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
      'PUT /api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
    });
    renderAt('/dashboard/biz_A1/settings/actions');
    const pause = await screen.findByRole('spinbutton', {
      name: 'Break, in days (“I don’t have the time”)',
    });
    const save = () => screen.getByRole('button', { name: 'Save the action settings' });
    expect(save().hasAttribute('disabled')).toBe(true);
    fireEvent.change(pause, { target: { value: '120' } });
    expect(save().hasAttribute('disabled')).toBe(true);
    fireEvent.change(pause, { target: { value: '45' } });
    // More free days than the limit: said, since members would never get them.
    const free = screen.getByRole('spinbutton', { name: 'Free days (“Another reason”)' });
    fireEvent.change(
      screen.getByRole('spinbutton', { name: 'Free days per member, over 90 days' }),
      {
        target: { value: '5' },
      },
    );
    fireEvent.change(free, { target: { value: '7' } });
    expect(
      screen.getByText('More than your limit of free days (5): members will not get this offer.'),
    ).toBeTruthy();
    fireEvent.change(free, { target: { value: '5' } });
    expect(screen.queryByText(/More than your limit of free days/)).toBeNull();
    fireEvent.change(
      screen.getByRole('textbox', {
        name: 'Your words to a member without results (“I’m not getting the results I expected”)',
      }),
      { target: { value: '  Write to me, I answer in person.  ' } },
    );
    fireEvent.click(save());
    await vi.waitFor(() => expect(calls).toContain('PUT /api/creator/biz_A1/settings/actions'));
    expect(bodies.get('PUT /api/creator/biz_A1/settings/actions')).toMatchObject({
      maxFreeDaysPerQuarter: 5,
      offers: {
        pauseDays: 45,
        promoPercent: 20,
        promoMonths: 3,
        extendDays: 5,
        coachingMessage: 'Write to me, I answer in person.',
      },
    });
  });

  it('saves the action settings, within the limits, with the creator’s words', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/risk': [
        {
          status: 200,
          body: {
            niche: 'other',
            weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
            recencyThresholdDays: 14,
            mediumFrom: 40,
            highFrom: 70,
          },
        },
      ],
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
      'PUT /api/creator/biz_A1/settings/actions': [
        { status: 200, body: { ...ACTION_SETTINGS, mode: 'auto', maxMessagesPerMonth: 2 } },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/actions');
    const automatic = await screen.findByRole('radio', { name: /Automatic/ });
    const save = () => screen.getByRole('button', { name: 'Save the action settings' });
    expect(save().hasAttribute('disabled')).toBe(true);
    fireEvent.click(automatic);
    const month = screen.getByRole('spinbutton', { name: 'Messages per member, over 30 days' });
    fireEvent.change(month, { target: { value: '5' } });
    // Looser than StayPut's limit: not saved.
    expect(save().hasAttribute('disabled')).toBe(true);
    fireEvent.change(month, { target: { value: '2' } });
    const title = screen.getAllByRole('textbox', { name: 'Title' })[4]!;
    fireEvent.change(title, { target: { value: 'Hi {firstname}' } });
    expect(screen.getByText('Unknown variable or unclosed [[ ]]: {firstname}')).toBeTruthy();
    expect(save().hasAttribute('disabled')).toBe(true);
    fireEvent.change(title, { target: { value: 'Hi {first_name}' } });
    fireEvent.click(save());
    await vi.waitFor(() => expect(calls).toContain('PUT /api/creator/biz_A1/settings/actions'));
    expect(bodies.get('PUT /api/creator/biz_A1/settings/actions')).toMatchObject({
      mode: 'auto',
      maxMessagesPerMonth: 2,
      templates: { en: { welcome_message: { title: 'Hi {first_name}', body: '' } } },
    });
    // The zone was not touched: it does not go along.
    expect(bodies.get('PUT /api/creator/biz_A1/settings/actions')).not.toHaveProperty('timezone');
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('never sends the browser’s time zone: a new community keeps New York’s', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/session': [
        { status: 200, body: { ...creatorSession.body, timezoneSet: false } },
      ],
    });
    renderAt('/dashboard/biz_A1');
    expect(await screen.findByText('Revenue saved · This month')).toBeTruthy();
    expect(calls.filter((call) => call.endsWith('/timezone'))).toEqual([]);
  });

  it('changes the time zone of the hours by hand, without suggesting the browser’s', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/settings/risk': [
        {
          status: 200,
          body: {
            niche: 'other',
            weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
            recencyThresholdDays: 14,
            mediumFrom: 40,
            highFrom: 70,
          },
        },
      ],
      '/api/creator/biz_A1/settings/actions': [{ status: 200, body: ACTION_SETTINGS }],
      'PUT /api/creator/biz_A1/settings/actions': [
        { status: 200, body: { ...ACTION_SETTINGS, timezone: 'Asia/Tokyo' } },
      ],
    });
    renderAt('/dashboard/biz_A1/settings/actions');
    const zone = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Time zone' });
    expect(zone.value).toBe('Europe/Paris');
    // The United States, the United Kingdom and France first; the zone in effect shows as such.
    const suggested = zone.querySelector('optgroup');
    expect(suggested?.getAttribute('label')).toBe('Suggested');
    expect([...(suggested?.querySelectorAll('option') ?? [])].map((o) => o.textContent)).toEqual([
      'United States · New York (Eastern)',
      'United States · Chicago (Central)',
      'United States · Denver (Mountain)',
      'United States · Los Angeles (Pacific)',
      'United Kingdom · London',
      'France · Paris',
    ]);
    expect(zone.selectedOptions[0]?.textContent).toBe('France · Paris');
    expect(within(zone).getByRole('option', { name: 'America/New York' })).toBeTruthy();
    const save = () => screen.getByRole('button', { name: 'Save the action settings' });
    fireEvent.change(zone, { target: { value: 'Asia/Tokyo' } });
    fireEvent.click(save());
    await vi.waitFor(() => expect(calls).toContain('PUT /api/creator/biz_A1/settings/actions'));
    expect(bodies.get('PUT /api/creator/biz_A1/settings/actions')).toMatchObject({
      timezone: 'Asia/Tokyo',
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /browser/i })).toBeNull();
  });
});
