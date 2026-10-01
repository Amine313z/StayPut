import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type {
  AccountsView,
  AlumniView,
  PlatformActivityView,
  ActionRow,
  ActionSettingsView,
  ActionsPage,
  DiscordChannelChoice,
  InsightsReport,
  IntegrationsStatus,
  MemberRetentionView,
  MemberRisk,
  MemberRow,
  MemberTelegramStatus,
  MembersPage,
  PeopleView,
  RiskSettingsView,
  SyncRun,
  SyncStatus,
} from '@stayput/core';
import type { Locale } from '@stayput/i18n';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/App';
import { LIVE_REFRESH_MS } from '../src/components/PlatformActivityCard';
import { I18nProvider } from '../src/i18n';
import { ThemeProvider, resolveTheme } from '../src/theme';

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
      <ThemeProvider>
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
      </ThemeProvider>
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

const dashboard = (members: MembersPage = MEMBERS, integrations = INTEGRATIONS) => ({
  '/api/creator/biz_A1/session': [creatorSession],
  '/api/creator/biz_A1/members': [{ status: 200, body: members }],
  '/api/creator/biz_A1/sync': [syncStatus()],
  '/api/creator/biz_A1/integrations?lang=en': [{ status: 200, body: integrations }],
  '/api/creator/biz_A1/alumni': [{ status: 200, body: NO_ALUMNI }],
});

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
  window.localStorage.clear();
});

describe('creator view', () => {
  it('opens the dashboard of the company in the URL', async () => {
    const calls = mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    expect(await screen.findByRole('heading', { name: 'Retention dashboard' })).toBeTruthy();
    expect(screen.getByText('Connected as a team member of biz_A1.')).toBeTruthy();
    expect(await screen.findByText('Up to date.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(calls.slice().sort()).toEqual([
      '/api/creator/biz_A1/integrations?lang=en',
      '/api/creator/biz_A1/members',
      '/api/creator/biz_A1/session',
      '/api/creator/biz_A1/sync',
    ]);
  });

  it('shows the figures, and who is about to leave with the reasons', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    const figures = (await screen.findByText('Failed payments')).closest('dl')!;
    expect(figures.textContent).toContain('Members5In the community, team aside');
    expect(figures.textContent).toContain('Monthly revenue$245$98 at risk');
    expect(figures.textContent).toContain('High risk1');
    expect(figures.textContent).toContain('Cancellations scheduled1');
    expect(figures.textContent).toContain('Failed payments1');
    expect(figures.textContent).toContain(
      'Actions, 30 days7Members’ messages, reactions, posts and lessons',
    );

    // The departures and the high risks, the highest score first, each with its reasons.
    const attention = screen.getByRole('heading', { name: 'Needs attention' }).closest('section')!;
    const text = attention.textContent ?? '';
    expect(text).toContain('Member without a name');
    expect(text).toContain('Leaves on Oct 20, 2026');
    expect(text).toContain('No activity this week');
    expect(text).toContain('High risk · 78');
    expect(text).toContain('No activity for 21 days');
    expect(text).toContain('Last lesson completed: “3. Charts”, 25 days ago');
    expect(text.indexOf('Member without a name')).toBeLessThan(text.indexOf('Bruno Petit'));
    expect(text).not.toContain('Denis Moreau');
    expect(text).not.toContain('Alice Martin');
    expect(screen.getByRole('link', { name: 'All members, by risk' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/members',
    );

    // The activation radar.
    const radar = screen
      .getByRole('heading', { name: 'New members who have not started' })
      .closest('section')!;
    expect(radar.textContent).toContain('Chloé Dubois');
    expect(screen.getByRole('link', { name: 'See all (1)' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/members?filter=newcomers',
    );
  });

  it('shows how the risk spreads, each level with its count, share and members', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    const levels = await screen.findByRole('list', { name: 'Members by risk level' });
    const rows = Array.from(levels.querySelectorAll('a'));
    expect(rows.map((a) => a.textContent)).toEqual([
      'Leaving120%',
      'High risk120%',
      'Medium risk120%',
      'Low risk240%',
    ]);
    expect(rows.map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/biz_A1/members?filter=leaving',
      '/dashboard/biz_A1/members?filter=high',
      '/dashboard/biz_A1/members?filter=medium',
      '/dashboard/biz_A1/members?filter=low',
    ]);
    expect(screen.getByText(/^Computed /)).toBeTruthy();
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
    expect(chloe.textContent).toContain('No lesson for 4 days');
  });

  it('keeps the facts of Whop before the first scores', async () => {
    mockApi(
      dashboard({
        ...MEMBERS,
        members: MEMBERS.members.map((m) => ({ ...m, risk: null })),
      }),
    );
    renderAt('/dashboard/biz_A1');
    const heading = await screen.findByRole('heading', { name: 'Needs attention' });
    const attention = heading.closest('section')!;
    expect(attention.textContent).toContain('Member without a name');
    expect(attention.textContent).toContain('Payment failed');
    expect(attention.textContent).toContain('Cancellation scheduled');
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
      ...dashboard(NOBODY),
      '/api/creator/biz_A1/sync': [syncStatus({ backfillDone: false })],
    });
    renderAt('/dashboard/biz_A1');
    expect(
      await screen.findByText(
        'Importing the last 90 days of your community. This can take a few minutes.',
      ),
    ).toBeTruthy();
    expect(await screen.findByText('Nothing needs your attention right now.')).toBeTruthy();
    expect(screen.getByText('No paying membership')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Members' }));
    expect(
      await screen.findByText(
        'No members yet. They appear here once StayPut has read them from Whop.',
      ),
    ).toBeTruthy();
  });

  it('syncs now on demand, then reads the members and the sources again', async () => {
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
    renderAt('/dashboard/biz_A1');
    const button = await screen.findByRole('button', { name: 'Sync now' });
    await screen.findByText('Nothing needs your attention right now.');
    fireEvent.click(button);
    expect(await screen.findByText('Member without a name')).toBeTruthy();
    expect(headersOf.get('POST /api/creator/biz_A1/sync')?.get('x-stayput-csrf')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(
      await screen.findByText('A synchronization just ran. Try again in a minute.'),
    ).toBeTruthy();
    expect(calls.filter((c) => c === '/api/creator/biz_A1/members')).toHaveLength(2);
    // « Sync now » reads Discord too: the sources are read again with the members.
    expect(calls.filter((c) => c === '/api/creator/biz_A1/integrations?lang=en')).toHaveLength(2);
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
    renderAt('/dashboard/biz_A1', 'fr');
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
    expect(
      await screen.findByRole('heading', { name: 'Tableau de bord de rétention' }),
    ).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');
    const alice = (await screen.findByText('Alice Martin')).closest('li')!;
    expect(alice.textContent).toContain('Active · 49,00 $US par mois');
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
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers to try again after a network failure, and succeeds', async () => {
    mockApi({ '/api/creator/biz_A1/session': [new TypeError('offline'), creatorSession] });
    renderAt('/dashboard/biz_A1');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Retention dashboard' })).toBeTruthy();
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
    renderAt('/dashboard/biz_A1/sources');
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
    renderAt('/dashboard/biz_A1/sources');
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
    renderAt('/dashboard/biz_A1/sources');
    expect(await screen.findByText(/Your own account, or a teammate’s\?/)).toBeTruthy();
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
      renderAt('/dashboard/biz_A1/sources');
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
    renderAt('/dashboard/biz_A1/sources');
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
    renderAt('/dashboard/biz_A1/sources');
    const discord = await screen.findByRole('link', { name: /Add the bot to my server/ });
    expect(discord.getAttribute('href')).toBe(INTEGRATIONS.discord.install!.url);
    expect(discord.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: /Add the bot to a group/ }).getAttribute('href')).toBe(
      INTEGRATIONS.telegram.addToGroup!.url,
    );
    expect(screen.getByText(/StayPut follows every channel it can read/)).toBeTruthy();
    expect(screen.getByText(/Members link their Telegram from StayPut/)).toBeTruthy();
  });

  it('says when the bot cannot see the messages of its groups', async () => {
    mockApi(
      dashboard(MEMBERS, {
        ...INTEGRATIONS,
        telegram: { ...INTEGRATIONS.telegram, readsAllMessages: false },
      }),
    );
    renderAt('/dashboard/biz_A1/sources');
    expect(await screen.findByText(/privacy mode is on/)).toBeTruthy();
  });

  it('asks for the links in the interface language, and says how a channel counts', async () => {
    const calls = mockApi({
      ...dashboard(),
      '/api/creator/biz_A1/integrations?lang=fr': [{ status: 200, body: INTEGRATIONS }],
    });
    renderAt('/dashboard/biz_A1/sources', 'fr');
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
    renderAt('/dashboard/biz_A1/sources');
    const server = (await screen.findByText('Le Club')).closest('li')!;
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
    renderAt('/dashboard/biz_A1/sources');
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
      '/api/creator/biz_A1/insights': [{ status: 200, body: REPORT }],
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

    const blocking = screen.getByRole('rowheader', { name: /4\. Risk management/ }).closest('tr')!;
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
      ...answers,
    });
  const share = (name: string) =>
    screen.getByRole('slider', { name }).closest('div')!.querySelector('output')!.textContent;

  it('applies a niche, shows what each sign weighs, then saves', async () => {
    const calls = settings({
      'PUT /api/creator/biz_A1/settings/risk': [{ status: 200, body: TRADING }],
    });
    renderAt('/dashboard/biz_A1/settings');
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
    renderAt('/dashboard/biz_A1/settings');
    const payment = await screen.findByRole('slider', { name: 'Payment' });
    fireEvent.change(payment, { target: { value: '0' } });
    // 30 + 25 + 20 + 0 + 10 = 85 points: recency weighs 30 / 85.
    expect(share('Payment')).toBe('0%');
    expect(share('Recency')).toBe('35%');
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('refuses levels in the wrong order, and a recency out of range', async () => {
    settings();
    renderAt('/dashboard/biz_A1/settings');
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
    renderAt('/dashboard/biz_A1/settings', 'fr');
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
      '/dashboard/biz_A1/sources',
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
    expect(await screen.findByRole('heading', { name: 'Retention dashboard' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign out' })).toBeNull();
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

  it('opens the progress space of the experience', async () => {
    mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/retention': [retention()],
      '/api/member/exp_E1/telegram?lang=en': [telegram({ available: false, link: null })],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByRole('heading', { name: 'Your progress space' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign out' })).toBeTruthy();
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
    renderAt('/experiences/exp_E1', 'fr');
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
    renderAt('/experiences/exp_E1', 'fr');
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

describe('shell', () => {
  it('switches the language, and remembers it', async () => {
    renderAt('/');
    fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), {
      target: { value: 'fr' },
    });
    expect(
      await screen.findByRole('heading', { name: 'La rétention pour les communautés Whop' }),
    ).toBeTruthy();
    expect(window.localStorage.getItem('stayput.locale')).toBe('fr');
  });

  it('switches the theme on <html>', () => {
    renderAt('/');
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), {
      target: { value: 'dark' },
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.change(screen.getByRole('combobox', { name: 'Theme' }), {
      target: { value: 'light' },
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('resolves "automatic" to the system theme', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('shows a not-found page for an unknown path', () => {
    renderAt('/nowhere');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: /History/ }));
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
    renderAt('/dashboard/biz_A1/actions');
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
    renderAt('/dashboard/biz_A1/settings');
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
    renderAt('/dashboard/biz_A1/settings');
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
    expect(await screen.findByText('Up to date.')).toBeTruthy();
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
    renderAt('/dashboard/biz_A1/settings');
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
