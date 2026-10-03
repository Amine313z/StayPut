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
  InsightsReport,
  IntegrationsStatus,
  MemberRetentionView,
  MemberRisk,
  MemberRow,
  MemberTelegramStatus,
  MembersPage,
  PeopleView,
  RevenueDay,
  RiskSettingsView,
  SyncRun,
  SyncStatus,
} from '@stayput/core';
import type { Locale } from '@stayput/i18n';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/App';
import { resetDemo } from '../src/demo/api';
import { readScreenshot } from '../src/ocr';
import { LIVE_REFRESH_MS } from '../src/components/PlatformActivityCard';
import { I18nProvider, detectLocale } from '../src/i18n';
import { ErrorPanel } from '../src/components/Status';
import { ToastProvider } from '../src/ui/Toast';

// Tesseract reads screenshots in a real browser only: the tests say what it read.
vi.mock('../src/ocr', () => ({ readScreenshot: vi.fn() }));

type Answer = { status: number; body: unknown } | Error;

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
};

const NO_ALUMNI: AlumniView = { offer: null, entered: 0, left: 0, returned: 0 };

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

afterEach(() => {
  cleanup();
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
    // The top bar: StayPut's « S », the community by its name (never its id), the member search
    // (⌘K) and the guide; the language is in Settings only, and there is no theme to choose
    // (dark is the only one).
    expect(screen.getByRole('link', { name: 'StayPut' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1',
    );
    expect(screen.getByText('Le Club')).toBeTruthy();
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
      'Saved: added up from the 1st of each month, so today is this month’s amount. At risk: what members at risk paid a month.',
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

  it('writes to a member in one click, and says it is queued', async () => {
    mockApi({
      ...dashboard(),
      'POST /api/creator/biz_A1/members/message': [{ status: 200, body: { queued: 1 } }],
    });
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Message Bruno Petit' }));
    expect(await screen.findByText('1 message queued')).toBeTruthy();
    expect(
      screen.getByText('Each one passes your limits, then leaves at the member’s best hour.'),
    ).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/members/message')).toEqual({
      memberIds: ['mber_3'],
    });
    // Done stays done: the row says it.
    expect(
      (await screen.findByRole('button', { name: 'Message Bruno Petit' })).textContent,
    ).toContain('Queued');
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
    expect(dialog.textContent).toContain('accepts it in their space within 7 days');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Offer the pause' }));
    expect(await screen.findByText('Pause offered to Bruno Petit')).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/members/mber_3/offer')).toEqual({
      kind: 'pause_offer',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Pause offered')).toBeTruthy();

    // A member who already has an open offer: said in words, never a code.
    fireEvent.click(screen.getByRole('button', { name: 'Make Member without a name an offer' }));
    const second = await screen.findByRole('dialog', {
      name: 'Make Member without a name an offer?',
    });
    expect(
      await within(second).findByText('20% off for 3 months, with a promo code of their own.'),
    ).toBeTruthy();
    fireEvent.click(within(second).getByRole('button', { name: 'Make the offer' }));
    expect(
      await screen.findByText('Already under way: an offer is waiting for this member’s answer.'),
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
    expect(rows.map((li) => li.querySelector('p')?.textContent)).toEqual([
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
    // Today the line ends on the hero's figure: the month's balance, from its 1st.
    const rows = () => within(chart).getAllByRole('row');
    expect(rows()).toHaveLength(31);
    expect(rows()[30]!.textContent).toBe('Oct 1, 2026$98.00$98.00');
    expect(rows()[29]!.textContent).toBe('Sep 30, 2026$198.00$147.00');
    // Before the first scores, no risk figure rather than a zero.
    fireEvent.click(within(periods).getByRole('radio', { name: '90D' }));
    expect(rows()).toHaveLength(91);
    expect(rows()[1]!.textContent).toBe('Jul 4, 2026$0.00—');
    fireEvent.click(within(periods).getByRole('radio', { name: '7D' }));
    expect(summary()).toBe(
      'Over the last 7 days, StayPut saved $247.00; the revenue at risk went from $147.00 to $98.00 a month.',
    );
    // The keyboard walks the days, and each day's figures are said.
    const plot = within(chart).getByRole('group', { name: 'Revenue saved vs at risk' });
    const said = () => chart.querySelector('[aria-live]')?.textContent;
    fireEvent.focus(plot);
    expect(said()).toBe('Oct 1, 2026: Saved $98.00, At risk $98.00');
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(said()).toBe('Sep 30, 2026: Saved $198.00, At risk $147.00');
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(said()).toBe('Sep 25, 2026: Saved $49.00, At risk $147.00');
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

  it('shows what StayPut collected about each member, and the risk with why', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members');
    const alice = (await screen.findByText('Alice Martin')).closest('li')!;
    expect(alice.textContent).toContain('Low risk · 3');
    expect(alice.textContent).toContain('No reaction in 14 days');
    expect(alice.textContent).toContain('Active · $49.00 per month · renews on Oct 15, 2026');
    expect(alice.textContent).toContain('Last payment: $49.00 on Sep 15, 2026');
    expect(alice.textContent).toContain('Last 30 days: 6 messages, 1 reaction, 0 posts, 0 lessons');
    const unnamed = screen.getByText('Member without a name').closest('li')!;
    expect(unnamed.textContent).toContain('Leaving');
    expect(unnamed.textContent).toContain('ends on Oct 20, 2026');
    expect(screen.getByText('Payment failed: $49.00 on Sep 20, 2026').className).toContain(
      'text-danger',
    );
    expect(unnamed.textContent).toContain('No activity recorded yet.');
    const denis = screen.getByText('Denis Moreau').closest('li')!;
    expect(denis.textContent).toContain('Medium risk · 52');
    expect(denis.textContent).toContain('Activity down 56% this week');
    expect(denis.textContent).toContain('Support ticket open for 3 days');
    const chloe = screen.getByText('Chloé Dubois').closest('li')!;
    expect(chloe.textContent).toContain('New, not started yet');
    expect(chloe.textContent).toContain('No activity since joining, 4 days ago');
    expect(chloe.textContent).toContain('No lesson or result for 4 days');
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
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members');
    await screen.findByText('Alice Martin');
    const names = () =>
      [
        'Member without a name',
        'Bruno Petit',
        'Denis Moreau',
        'Chloé Dubois',
        'Alice Martin',
      ].filter((name) => screen.queryByText(name) !== null);
    fireEvent.click(screen.getByRole('button', { name: /^Leaving/ }));
    expect(names()).toEqual(['Member without a name']);
    fireEvent.click(screen.getByRole('button', { name: /^High/ }));
    expect(names()).toEqual(['Bruno Petit']);
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }));
    expect(names()).toEqual(['Chloé Dubois', 'Alice Martin']);
    fireEvent.click(screen.getByRole('button', { name: /^New, inactive/ }));
    expect(names()).toEqual(['Chloé Dubois']);
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a member' }), {
      target: { value: 'ALÎCE' },
    });
    expect(names()).toEqual(['Alice Martin']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a member' }), {
      target: { value: 'nobody' },
    });
    expect(screen.getByText('No member matches.')).toBeTruthy();
  });

  it('keeps a member off every action, and says when that was not saved', async () => {
    mockApi({
      ...dashboard(),
      'PUT /api/creator/biz_A1/members/mber_3/contact': [
        { status: 200, body: { doNotContact: true } },
        new Error('offline'),
      ],
    });
    renderAt('/dashboard/biz_A1/members?filter=high');
    await screen.findByText('Bruno Petit');
    const never = screen.getByRole('button', { name: 'Never contact' });
    expect(never.getAttribute('aria-pressed')).toBe('false');
    expect(
      screen.getByText('StayPut may contact this member, within the guardrails.'),
    ).toBeTruthy();
    fireEvent.click(never);
    await vi.waitFor(() => expect(never.getAttribute('aria-pressed')).toBe('true'));
    const put = 'PUT /api/creator/biz_A1/members/mber_3/contact';
    expect(bodies.get(put)).toEqual({ doNotContact: true });
    expect(headersOf.get(put)?.get('x-stayput-csrf')).toBe('1');
    expect(screen.getByText('StayPut takes no action of any kind for this member.')).toBeTruthy();
    // Not saved: it says so, and the switch stays as it was.
    fireEvent.click(never);
    expect(await screen.findByText('Not saved. Try again.')).toBeTruthy();
    expect(never.getAttribute('aria-pressed')).toBe('true');
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
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members', 'fr');
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
      ).toEqual(['Tous les membres5', 'Ne jamais contacter0']),
    );
    const alice = (await screen.findByText('Alice Martin')).closest('li')!;
    expect(alice.textContent).toContain('Active · 49,00 $ par mois');
    expect(alice.textContent).toContain(
      '30 derniers jours : 6 messages, 1 réaction, 0 post, 0 leçon',
    );
    const bruno = screen.getByText('Bruno Petit').closest('li')!;
    expect(bruno.textContent).toContain('Risque élevé · 78');
    expect(bruno.textContent).toContain('Aucune activité depuis 21 jours');
    expect(bruno.textContent).toContain('Dernière leçon terminée : « 3. Charts », il y a 25 jours');
    const unnamed = screen.getByText('Membre sans nom').closest('li')!;
    expect(unnamed.textContent).toContain('Départ programmé');
    expect(unnamed.textContent).toContain('Part le 20 oct. 2026');
    expect(unnamed.textContent).toContain('Aucune activité cette semaine');
    expect(screen.getByText('Denis Moreau').closest('li')!.textContent).toMatch(
      /Activité en baisse de 56\s% cette semaine/,
    );
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

  it('lists the members on the « never contact » list in their own tab', async () => {
    mockApi(
      dashboard({
        ...MEMBERS,
        members: MEMBERS.members.map((m) =>
          m.name === 'Alice Martin' ? { ...m, doNotContact: true } : m,
        ),
      }),
    );
    renderAt('/dashboard/biz_A1/members/never-contact');
    const list = (await screen.findByRole('heading', { name: 'Never contact', level: 2 })).closest(
      'section',
    )!;
    expect(within(list).getByText('Alice Martin')).toBeTruthy();
    expect(within(list).queryByText('Bruno Petit')).toBeNull();
    await vi.waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: 'Members tabs' }))
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['All members5', 'Never contact1']),
    );
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
  const NOBODY_THERE: PeopleView = { places: [], total: 0, people: [] };
  /** The people card's reads: the first, then after news, changes and its own polling. */
  const PEOPLE_READS = (times: number, view: PeopleView = NOBODY_THERE) =>
    Array.from({ length: times }, () => ({ status: 200, body: view }));
  /** The live card's reads: the first, then one after each change. */
  const READ_ACTIVITY = (times: number) =>
    Array.from({ length: times }, () => ({ status: 200, body: ACTIVITY }));
  const ACTIVITY: PlatformActivityView = {
    from: '2026-09-02',
    to: '2026-10-01',
    platforms: [
      {
        platform: 'discord',
        messages: 12,
        authors: 3,
        members: 1,
        team: 1,
        guests: 0,
        unlinked: 1,
        lastAt: '2026-10-01T09:00:00.000Z',
        daily: [...Array<number>(29).fill(0), 12],
      },
      {
        platform: 'telegram',
        messages: 2,
        authors: 1,
        members: 0,
        team: 1,
        guests: 0,
        unlinked: 0,
        lastAt: '2026-09-30T08:00:00.000Z',
        daily: [...Array<number>(28).fill(0), 2, 0],
      },
    ],
    places: [
      {
        platform: 'discord',
        id: '910000000000000001',
        name: 'Le Club',
        messages: 12,
        lastAt: '2026-10-01T09:00:00.000Z',
      },
      {
        platform: 'telegram',
        id: '-1009000000001',
        name: 'VIP',
        messages: 2,
        lastAt: '2026-09-30T08:00:00.000Z',
      },
    ],
    topMembers: [
      {
        id: 'mber_1',
        name: 'Alice Martin',
        discord: 8,
        telegram: 0,
        lastAt: '2026-10-01T09:00:00.000Z',
      },
    ],
  };

  it('shows what StayPut saw on Discord and Telegram: per day, author, place and member', async () => {
    mockApi({
      ...dashboard(MEMBERS, connected),
      '/api/creator/biz_A1/people': PEOPLE_READS(4),
      'POST /api/creator/biz_A1/platform-activity/refresh': READ_ACTIVITY(3),
      '/api/creator/biz_A1/accounts': [{ status: 200, body: NO_ACCOUNTS }],
    });
    renderAt('/dashboard/biz_A1/sources/activity');
    const places = (await screen.findByText('Servers and groups')).closest('section')!;
    const card = places.parentElement!.parentElement!;
    expect(within(card).getByText('12 messages')).toBeTruthy();
    expect(within(card).getByText('1 member')).toBeTruthy();
    expect(within(card).getAllByText('1 of the team')).toHaveLength(2);
    expect(within(card).getByText('1 to tie')).toBeTruthy();
    // Each chart says its last day, and holds its figures for screen readers.
    expect(within(card).getByText('Messages per day on Discord')).toBeTruthy();
    expect(within(card).getByText(/· 12 messages$/)).toBeTruthy();
    expect(within(places).getByText('Le Club')).toBeTruthy();
    expect(within(places).getByText('VIP')).toBeTruthy();
    expect(within(card).getByText('Alice Martin')).toBeTruthy();
    expect(within(card).getByText('8 on Discord')).toBeTruthy();
  });

  it('ties an account to a member in one click, from what StayPut suggests', async () => {
    const alice = {
      platform: 'discord',
      accountId: '940000000000000001',
      name: 'Alice',
      username: 'alice.m',
      member: { id: 'mber_1', name: 'Alice Martin' },
      via: 'name',
    } satisfies AccountsView['linked'][number];
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
      '/api/creator/biz_A1/people': PEOPLE_READS(4),
      'POST /api/creator/biz_A1/platform-activity/refresh': READ_ACTIVITY(3),
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
    renderAt('/dashboard/biz_A1/sources/activity');
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
    // The counts of the sources and the members' activity are read again.
    await vi.waitFor(() =>
      expect(calls.filter((c) => c === '/api/creator/biz_A1/integrations?lang=en')).toHaveLength(2),
    );
  });

  it('ties each platform’s accounts under its own tab, where its card says « below »', async () => {
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
    // Under the server's card, Discord's accounts only.
    const discord = await screen.findByRole('region', { name: 'Discord accounts' });
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
      '/api/creator/biz_A1/people': PEOPLE_READS(4),
      'POST /api/creator/biz_A1/platform-activity/refresh': READ_ACTIVITY(3),
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
    renderAt('/dashboard/biz_A1/sources/activity');
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
                messages: 3,
                lastAt: '2026-10-01T10:00:00.000Z',
                daily: [...p.daily.slice(0, 29), 1],
              }
            : p,
        ),
      };
      const calls = mockApi({
        ...dashboard(MEMBERS, connected),
        '/api/creator/biz_A1/people': PEOPLE_READS(4),
        'POST /api/creator/biz_A1/platform-activity/refresh': [
          { status: 200, body: ACTIVITY },
          { status: 200, body: later },
        ],
        '/api/creator/biz_A1/accounts': [
          { status: 200, body: NO_ACCOUNTS },
          { status: 200, body: NO_ACCOUNTS },
        ],
        '/api/creator/biz_A1/integrations?lang=en': [
          { status: 200, body: connected },
          { status: 200, body: connected },
        ],
      });
      renderAt('/dashboard/biz_A1/sources/activity');
      const places = (await screen.findByText('Servers and groups')).closest('section')!;
      const card = places.parentElement!.parentElement!;
      expect(within(card).getByText('2 messages')).toBeTruthy();
      expect(screen.getByText('Live')).toBeTruthy();

      // Seconds later, a Telegram message: it shows, and what may have moved is read again.
      await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
      expect(await within(card).findByText('3 messages')).toBeTruthy();
      const reads = (path: string) => calls.filter((call) => call === path).length;
      expect(reads('POST /api/creator/biz_A1/platform-activity/refresh')).toBe(2);
      await vi.waitFor(() => expect(reads('/api/creator/biz_A1/accounts')).toBe(2));
      expect(reads('/api/creator/biz_A1/integrations?lang=en')).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows everyone on the server and in the group, not only who writes', async () => {
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
      '/api/creator/biz_A1/people': PEOPLE_READS(4, people),
      'POST /api/creator/biz_A1/platform-activity/refresh': READ_ACTIVITY(2),
      '/api/creator/biz_A1/accounts': [{ status: 200, body: NO_ACCOUNTS }],
    });
    renderAt('/dashboard/biz_A1/sources/activity');
    const card = (
      await screen.findByRole('heading', { name: 'Members on Discord and Telegram' })
    ).closest('section')!;
    expect(await within(card).findByText('Marc Dupont')).toBeTruthy();
    expect(within(card).getByText(/Members in the group: 34 · StayPut knows 3/)).toBeTruthy();
    // Discord keeps its list until the application turns the Server Members Intent on.
    expect(
      within(card).getByText(/Discord does not give StayPut the member list yet/),
    ).toBeTruthy();
    expect(
      within(card)
        .getByRole('link', { name: /Open the Discord Developer Portal/ })
        .getAttribute('href'),
    ).toBe('https://discord.com/developers/applications');
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
    fireEvent.change(within(card).getByRole('searchbox', { name: 'Search by name' }), {
      target: { value: '' },
    });
    fireEvent.click(within(card).getByRole('button', { name: /Discord/ }));
    expect(within(card).getByText('No one matches this search.')).toBeTruthy();
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
      '/api/creator/biz_A1/people': PEOPLE_READS(4),
      'POST /api/creator/biz_A1/platform-activity/refresh': READ_ACTIVITY(3),
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
      '/api/creator/biz_A1/people': PEOPLE_READS(4),
      'POST /api/creator/biz_A1/platform-activity/refresh': READ_ACTIVITY(3),
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
    renderAt('/dashboard/biz_A1/insights');
    expect(
      await screen.findByText(
        'Members who joined in July 2026 left 1.8 times more than your average within 30 days.',
      ),
    ).toBeTruthy();
    expect(calls).toContain('/api/creator/biz_A1/insights');
    const july = screen.getByRole('rowheader', { name: 'July 2026' }).closest('tr')!;
    expect(july.textContent).toContain('36%Above average');
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
    renderAt('/dashboard/biz_A1/insights', 'fr');
    expect(
      await screen.findByText(
        "Les premières analyses tournent dans l'heure qui suit la première synchronisation.",
      ),
    ).toBeTruthy();
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
  it('says the server is connected, and that the tab can be closed', () => {
    renderAt('/connected?source=discord&status=ok&name=Le%20Club&channels=2');
    expect(screen.getByRole('heading', { name: 'Discord is connected' })).toBeTruthy();
    expect(
      screen.getByText('"Le Club": 2 channels followed. The last 90 days are being read.'),
    ).toBeTruthy();
    expect(screen.getByText(/You can close this tab/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Back to StayPut/ })).toBeNull();
  });

  it('offers the way back when signed in to StayPut outside Whop', () => {
    renderAt('/connected?source=discord&status=ok&name=Le%20Club&channels=2&company=biz_A1', 'fr');
    expect(screen.getByRole('link', { name: /Revenir à StayPut/ }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/sources/discord',
    );
    expect(screen.getByText(/Ou fermez cet onglet/)).toBeTruthy();
    cleanup();
    // Never a link built from anything but a company id.
    renderAt('/connected?source=discord&status=ok&company=https://evil.example');
    expect(screen.queryByRole('link', { name: /Back to StayPut/ })).toBeNull();
  });

  it('says why it did not work', () => {
    renderAt('/connected?source=discord&status=failed&reason=expired', 'fr');
    expect(screen.getByRole('heading', { name: "Discord n'est pas connecté" })).toBeTruthy();
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

describe('member view', () => {
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

  it('opens the member’s subscription, and says plainly when nothing needs them', async () => {
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [retention()],
      '/api/member/exp_E1/telegram?lang=en': [telegram({ available: false, link: null })],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByRole('heading', { name: 'Your membership' })).toBeTruthy();
    expect(screen.getByText('Your membership is all set: nothing needs you here.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign out' })).toBeTruthy();
    // The member space is off in V1: no goals, no progress space.
    expect(screen.queryByRole('heading', { name: 'Your progress space' })).toBeNull();
    expect(screen.queryByText('Your Telegram account')).toBeNull();
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
          offer: { type: 'promo_offer', percentOff: 20, months: 3, validDays: 7, keep: 'never' },
        }),
      ],
      'POST /api/member/exp_E1/retention/offer': [
        leaving({
          reason: 'too_expensive',
          offer: { type: 'promo_offer', percentOff: 20, months: 3, validDays: 7, keep: 'never' },
          outcome: 'accepted',
          result: {
            status: 'applied',
            promoCode: 'STAY-ABCD2345',
            expiresAt: '2026-10-08T12:00:00.000Z',
          },
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

    // The member changes their answer: too expensive, a code, nothing to consent to.
    fireEvent.click(screen.getByRole('button', { name: 'Change my answer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'It’s too expensive' }));
    expect(await screen.findByText('20% off for 3 months')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Get my code' }));
    expect(await screen.findByText('STAY-ABCD2345')).toBeTruthy();
    expect(bodies.get('POST /api/member/exp_E1/retention/offer')).toEqual({
      accept: true,
      keep: false,
    });
    expect(screen.getByText('Valid once, until Oct 8, 2026.')).toBeTruthy();
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
            offer: { type: 'promo_offer', percentOff: 20, months: 3, validDays: 7, keep: 'never' },
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

  it('shows a not-found page for an unknown path', () => {
    renderAt('/nowhere');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
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

  it('finds a member from the top bar, accents aside, and opens them in Members', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    await screen.findByText('Bruno Petit');
    const search = screen.getByRole('combobox', { name: 'Find a member' });
    fireEvent.change(search, { target: { value: 'chloe' } });
    const option = await screen.findByRole('option', { name: 'Chloé Dubois' });
    fireEvent.click(within(option).getByRole('button'));
    expect(await screen.findByRole('heading', { name: 'Members', level: 1 })).toBeTruthy();
    expect(screen.getByPlaceholderText<HTMLInputElement>('Search a member').value).toBe(
      'Chloé Dubois',
    );
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(await screen.findByText('No member by that name.')).toBeTruthy();
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

  it('opens the guide from the top bar, and leads to the demo', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Guide' }));
    const guide = await screen.findByRole('dialog', { name: 'How StayPut works' });
    expect(guide.textContent).toContain('The risk score');
    expect(guide.textContent).toContain('Each payment counts once.');
    expect(
      within(guide).getByRole('link', { name: 'Explore with demo data' }).getAttribute('href'),
    ).toBe('/demo?from=%2Fdashboard%2Fbiz_A1');
    fireEvent.click(within(guide).getByRole('button', { name: 'Close' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
});

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
    for (const page of [
      'members',
      'members/never-contact',
      'actions',
      'actions/scheduled',
      'actions/history',
      'actions/alumni',
      'insights',
      'insights/lessons',
      'sources',
      'sources/discord',
      'sources/telegram',
      'sources/activity',
      'settings',
      'settings/risk',
      'settings/actions',
    ]) {
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
    renderAt('/demo/actions');
    expect(await screen.findByText('Margaux Picard', undefined, { timeout: 3_000 })).toBeTruthy();
    expect(screen.getByText('Before you go')).toBeTruthy();
    cleanup();
    renderAt('/demo/insights');
    expect(
      await screen.findByText(/left 1\.\d times more than your average within 30 days/, undefined, {
        timeout: 3_000,
      }),
    ).toBeTruthy();
  }, 40_000);

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

  it('shows each action to approve with its message as it will read, and approves it', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/actions?view=queue': [page('queue', [row()]), page('queue', [])],
      'POST /api/creator/biz_A1/actions/approve': [{ status: 200, body: { approved: 1 } }],
    });
    renderAt('/dashboard/biz_A1/actions');
    expect(await screen.findByText('Welcome, Ana')).toBeTruthy();
    expect(screen.getByText('Glad to have you in Le Club.')).toBeTruthy();
    expect(screen.getByText('Leaves as soon as you approve it')).toBeTruthy();
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
    renderAt('/dashboard/biz_A1/actions');
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
    expect(screen.getByText('Golden-hour message')).toBeTruthy();
    // An Alumni follow-up: its step, and why it no longer goes.
    expect(screen.getByText('· 30 days after leaving, in the Alumni')).toBeTruthy();
    expect(screen.getByText('The member came back to a paid offer')).toBeTruthy();
    // Done: nothing to approve or cancel any more.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows an offer a member accepted: their reason, the offer, the code and consent', async () => {
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
              keep: false,
              promoCode: 'STAY-ABCD2345',
              expiresAt: '2026-10-08T12:00:00.000Z',
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
    expect(await screen.findByText('Code STAY-ABCD2345, valid until Oct 8, 2026')).toBeTruthy();
    expect(screen.getByText('Reason: “It’s too expensive”')).toBeTruthy();
    expect(screen.getByText('20% off for 3 months')).toBeTruthy();
    expect(screen.getAllByText('· Answer to the departure survey')).toHaveLength(2);
    expect(screen.getByText('Reason: “I’m not getting the results I expected”')).toBeTruthy();
    expect(screen.getByText('Membership kept, with the member’s consent')).toBeTruthy();
    expect(screen.getByText('Your turn: write to the member on Whop.')).toBeTruthy();
    // Applied to the membership, not sent.
    expect(screen.getAllByText('Applied')).toHaveLength(2);
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
      problem: { step: 'experience', permission: 'experience:create' },
    };
    const ready: AlumniView = {
      ...stopped,
      offer: { ...stopped.offer!, completedAt: '2026-10-01T10:05:00.000Z' },
      entered: 3,
      returned: 1,
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
      await screen.findByText(/StayPut does not have the « experience:create » permission/),
    ).toBeTruthy();
    expect(bodies.get('POST /api/creator/biz_A1/alumni')).toEqual({ name: 'Alumni du Club' });
    fireEvent.click(screen.getByRole('button', { name: 'Finish creating it' }));
    expect(await screen.findByText('Your Alumni offer « Alumni du Club » is ready.')).toBeTruthy();
    expect(screen.getByText('https://whop.com/checkout/plan_Alu1')).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: /User left/ }).value).toContain(
      'join the Alumni: https://whop.com/checkout/plan_Alu1',
    );
    expect(screen.getByText('In the Alumni: 3 · came back: 1 · left: 0')).toBeTruthy();
    expect(calls.filter((c) => c === 'POST /api/creator/biz_A1/alumni')).toHaveLength(2);
  });

  it('sets the departure offers, within their limits', async () => {
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

  it('tells the browser’s time zone for a company that has none, once', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/session': [
        { status: 200, body: { ...creatorSession.body, timezoneSet: false } },
      ],
      'POST /api/creator/biz_A1/timezone': [{ status: 200, body: { timezone: 'UTC' } }],
    });
    renderAt('/dashboard/biz_A1');
    await vi.waitFor(() => expect(calls).toContain('POST /api/creator/biz_A1/timezone'));
    expect(bodies.get('POST /api/creator/biz_A1/timezone')).toEqual({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(headersOf.get('POST /api/creator/biz_A1/timezone')?.get('x-stayput-csrf')).toBe('1');
    expect(await screen.findByText('Revenue saved · This month')).toBeTruthy();
    expect(calls.filter((call) => call.endsWith('/timezone'))).toHaveLength(1);
  });

  it('changes the time zone of the hours, by hand or to the browser’s', async () => {
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
        { status: 200, body: { ...ACTION_SETTINGS, timezone: 'UTC' } },
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
    // The browser here says UTC: one click takes it.
    fireEvent.click(screen.getByRole('button', { name: 'Use this browser’s: UTC' }));
    expect(zone.value).toBe('UTC');
    expect(screen.queryByRole('button', { name: /Use this browser’s/ })).toBeNull();
    fireEvent.click(save());
    await vi.waitFor(() =>
      expect(bodies.get('PUT /api/creator/biz_A1/settings/actions')).toMatchObject({
        timezone: 'UTC',
      }),
    );
  });
});
