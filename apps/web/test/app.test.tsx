import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { MembersPage, SyncRun, SyncStatus } from '@stayput/core';
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

/** The calls of an opened dashboard: the session, then the members and the sync status. */
const dashboard = (members: MembersPage = MEMBERS) => ({
  '/api/creator/biz_A1/session': [creatorSession],
  '/api/creator/biz_A1/members': [{ status: 200, body: members }],
  '/api/creator/biz_A1/sync': [syncStatus()],
});

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
    expect(await screen.findByText('Alice Martin')).toBeTruthy();
    expect(await screen.findByText('Up to date.')).toBeTruthy();
    expect(calls.slice().sort()).toEqual([
      '/api/creator/biz_A1/members',
      '/api/creator/biz_A1/session',
      '/api/creator/biz_A1/sync',
    ]);
  });

  it('shows what StayPut collected about each member', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1');
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
    const figures = screen.getByRole('heading', { name: 'Members' }).nextElementSibling!;
    expect(figures.textContent).toContain('Cancellations scheduled1');
    expect(figures.textContent).toContain('Failed payments1');
  });

  it('says so when there is nobody yet, while the history is being imported', async () => {
    mockApi({
      ...dashboard({ ...MEMBERS, members: [] }),
      '/api/creator/biz_A1/sync': [syncStatus({ backfillDone: false })],
    });
    renderAt('/dashboard/biz_A1');
    expect(
      await screen.findByText(
        'No members yet. They appear here once StayPut has read them from Whop.',
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        'Importing the last 90 days of your community. This can take a few minutes.',
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
        { status: 200, body: { ...MEMBERS, members: [] } },
        { status: 200, body: MEMBERS },
      ],
    });
    renderAt('/dashboard/biz_A1');
    const button = await screen.findByRole('button', { name: 'Sync now' });
    await screen.findByText(
      'No members yet. They appear here once StayPut has read them from Whop.',
    );
    fireEvent.click(button);
    expect(await screen.findByText('Alice Martin')).toBeTruthy();
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
      screen.getAllByRole('listitem').filter((li) => li.textContent?.startsWith('Messages')),
    ).toHaveLength(1);
  });

  it('speaks French', async () => {
    mockApi(dashboard());
    renderAt('/dashboard/biz_A1', 'fr');
    expect(
      await screen.findByRole('heading', { name: 'Tableau de bord de rétention' }),
    ).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');
    const alice = (await screen.findByText('Alice Martin')).closest('li')!;
    expect(alice.textContent).toContain('Active · 49,00\u00a0$US par mois');
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
  it('opens the progress space of the experience', async () => {
    mockApi({
      '/api/member/exp_E1/session': [
        {
          status: 200,
          body: { experienceId: 'exp_E1', userId: 'user_m', accessLevel: 'customer', via: 'login' },
        },
      ],
    });
    renderAt('/experiences/exp_E1');
    expect(await screen.findByRole('heading', { name: 'Your progress space' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign out' })).toBeTruthy();
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
