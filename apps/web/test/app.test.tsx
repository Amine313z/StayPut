import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Locale } from '@stayput/i18n';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/App';
import { I18nProvider } from '../src/i18n';
import { ThemeProvider, resolveTheme } from '../src/theme';

type Answer = { status: number; body: unknown } | Error;

/** Answers the Worker's routes from a table, in order for repeated calls; records the calls. */
function mockApi(answers: Record<string, Answer[]>) {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: string) => {
    const path = input;
    calls.push(path);
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('creator view', () => {
  it('opens the dashboard of the company in the URL', async () => {
    const calls = mockApi({ '/api/creator/biz_A1/session': [creatorSession] });
    renderAt('/dashboard/biz_A1');
    expect(await screen.findByRole('heading', { name: 'Retention dashboard' })).toBeTruthy();
    expect(screen.getByText('Connected as a team member of biz_A1.')).toBeTruthy();
    expect(calls).toEqual(['/api/creator/biz_A1/session']);
  });

  it('speaks French', async () => {
    mockApi({ '/api/creator/biz_A1/session': [creatorSession] });
    renderAt('/dashboard/biz_A1', 'fr');
    expect(
      await screen.findByRole('heading', { name: 'Tableau de bord de rétention' }),
    ).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');
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
