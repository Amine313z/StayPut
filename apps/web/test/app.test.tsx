import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  DiscordChannelChoice,
  IntegrationsStatus,
  MemberTelegramStatus,
  MembersPage,
  SyncRun,
  SyncStatus,
} from '@stayput/core';
import type { Locale } from '@stayput/i18n';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/App';
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
  body: { companyId: 'biz_A1', userId: 'user_alice', accessLevel: 'admin', via: 'iframe' },
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

const MEMBERS: MembersPage = {
  summary: {
    members: 2,
    liveMemberships: 2,
    scheduledCancellations: 1,
    failedPayments: 1,
    activity30d: 7,
  },
  truncated: false,
  members: [
    {
      id: 'mber_1',
      name: 'Alice Martin',
      status: 'joined',
      accessLevel: 'customer',
      joinedAt: '2026-06-01T10:00:00.000Z',
      lastActionAt: '2026-09-30T10:00:00.000Z',
      lastActivityAt: '2026-09-30T10:00:00.000Z',
      activity: { messages: 6, reactions: 1, posts: 0, lessons: 0 },
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
    },
    {
      id: 'mber_2',
      name: null,
      status: 'joined',
      accessLevel: 'customer',
      joinedAt: '2026-07-01T10:00:00.000Z',
      lastActionAt: null,
      lastActivityAt: null,
      activity: { messages: 0, reactions: 0, posts: 0, lessons: 0 },
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
    },
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
const dashboard = (members: MembersPage = MEMBERS, integrations = INTEGRATIONS) => ({
  '/api/creator/biz_A1/session': [creatorSession],
  '/api/creator/biz_A1/members': [{ status: 200, body: members }],
  '/api/creator/biz_A1/sync': [syncStatus()],
  '/api/creator/biz_A1/integrations': [{ status: 200, body: integrations }],
});

const NOBODY: MembersPage = {
  summary: {
    members: 0,
    liveMemberships: 0,
    scheduledCancellations: 0,
    failedPayments: 0,
    activity30d: 0,
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
      '/api/creator/biz_A1/integrations',
      '/api/creator/biz_A1/members',
      '/api/creator/biz_A1/session',
      '/api/creator/biz_A1/sync',
    ]);
  });

  it('shows the figures, and the members about to leave', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
    const figures = (await screen.findByText('Failed payments')).closest('dl')!;
    expect(figures.textContent).toContain('Cancellations scheduled1');
    expect(figures.textContent).toContain('Failed payments1');
    expect(figures.textContent).toContain('Activity, last 30 days7');
    const attention = screen.getByRole('heading', { name: 'Needs attention' }).closest('section')!;
    expect(attention.textContent).toContain('Member without a name');
    expect(attention.textContent).toContain('Payment failed');
    expect(attention.textContent).toContain('Cancellation scheduled');
    expect(attention.textContent).not.toContain('Alice Martin');
    expect(screen.getByRole('link', { name: 'See all (1)' }).getAttribute('href')).toBe(
      '/dashboard/biz_A1/members?filter=attention',
    );
  });

  it('shows what StayPut collected about each member', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members');
    const alice = (await screen.findByText('Alice Martin')).closest('li')!;
    expect(alice.textContent).toContain('Active · $49.00 per month · renews on Oct 15, 2026');
    expect(alice.textContent).toContain('Last payment: $49.00 on Sep 15, 2026');
    expect(alice.textContent).toContain('Last 30 days: 6 messages, 1 reaction, 0 posts, 0 lessons');
    const unnamed = screen.getByText('Member without a name').closest('li')!;
    expect(unnamed.textContent).toContain('ends on Oct 20, 2026');
    expect(screen.getByText('Payment failed: $49.00 on Sep 20, 2026').className).toContain(
      'text-danger',
    );
    expect(unnamed.textContent).toContain('No activity recorded yet.');
  });

  it('filters the members and finds one by name, accents aside', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1/members');
    await screen.findByText('Alice Martin');
    fireEvent.click(screen.getByRole('button', { name: /Needs attention/ }));
    expect(screen.queryByText('Alice Martin')).toBeNull();
    expect(screen.getByText('Member without a name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a member' }), {
      target: { value: 'ALÎCE' },
    });
    expect(screen.getByText('Alice Martin')).toBeTruthy();
    expect(screen.queryByText('Member without a name')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search a member' }), {
      target: { value: 'nobody' },
    });
    expect(screen.getByText('No member matches.')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('link', { name: 'Members' }));
    expect(
      await screen.findByText(
        'No members yet. They appear here once StayPut has read them from Whop.',
      ),
    ).toBeTruthy();
  });

  it('syncs now on demand, then reads the members again', async () => {
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

  it('chooses the channels of a connected server, then saves them', async () => {
    const calls = mockApi({
      ...dashboard(MEMBERS, connected),
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
      '/api/creator/biz_A1/integrations': [
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
      'DELETE /api/creator/biz_A1/telegram/-1009000000001': [
        { status: 200, body: { removed: true } },
      ],
      '/api/creator/biz_A1/integrations': [
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

describe('back from Discord', () => {
  it('says the server is connected, and that the tab can be closed', () => {
    renderAt('/connected?source=discord&status=ok&name=Le%20Club&channels=2');
    expect(screen.getByRole('heading', { name: 'Discord is connected' })).toBeTruthy();
    expect(
      screen.getByText('"Le Club": 2 channels followed. The last 90 days are being read.'),
    ).toBeTruthy();
    expect(screen.getByText(/You can close this tab/)).toBeTruthy();
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
      '/api/member/exp_E1/telegram': [telegram({ available: false, link: null })],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByRole('heading', { name: 'Your progress space' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign out' })).toBeTruthy();
    expect(screen.queryByText('Your Telegram account')).toBeNull();
  });

  it('offers to link Telegram when the community counts a group, then to unlink it', async () => {
    const calls = mockApi({
      '/api/member/exp_E1/session': [memberSession],
      '/api/member/exp_E1/telegram': [telegram({}), telegram({ linked: true, link: null })],
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
