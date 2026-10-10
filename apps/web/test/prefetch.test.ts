import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson, prefetch } from '../src/api';
import { entryKey, prefetchScreen } from '../src/prefetch';

/**
 * The dashboard's first readings leave at once, as the page opens (main.tsx), instead of each
 * waiting for the session's answer: the screen that reads one takes its answer, never asks
 * again; one that failed is asked again by its screen.
 */
function server(answers: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: string) => {
    const answer = answers[input];
    return Promise.resolve(answer ? answer() : new Response('{}', { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('prefetch', () => {
  it('asks the opened dashboard’s readings at once, and its screens take the answers', async () => {
    const api = '/api/creator/biz_Pre1';
    const fetchMock = server({
      [`${api}/session`]: json({ companyId: 'biz_Pre1' }),
      [`${api}/members`]: json({ members: [] }),
      [`${api}/integrations?lang=fr`]: json({ discord: null }),
      [`${api}/sync`]: json({ running: false }),
      [`${api}/dashboard`]: json({ members: { total: 3 } }),
    });
    prefetchScreen('/dashboard/biz_Pre1', 'fr');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${api}/session`,
      `${api}/members`,
      `${api}/integrations?lang=fr`,
      `${api}/sync`,
      `${api}/dashboard`,
    ]);
    expect(await getJson(`${api}/dashboard`)).toEqual({ members: { total: 3 } });
    expect(await getJson(`${api}/session`)).toEqual({ companyId: 'biz_Pre1' });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Taken once: the next reading asks the server.
    await getJson(`${api}/session`);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('leaves the home’s figures out on another page, and anything outside a dashboard', () => {
    const fetchMock = server({});
    prefetchScreen('/dashboard/biz_Pre2/members', 'en');
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      '/api/creator/biz_Pre2/dashboard',
    );
    fetchMock.mockClear();
    prefetchScreen('/demo', 'en');
    prefetchScreen('/discover', 'en');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opened from the community: where it leads first, then that dashboard’s readings', async () => {
    const api = '/api/creator/biz_Ent1';
    const fetchMock = server({
      '/api/member/exp_Ent1/home': json({ dashboard: '/dashboard/biz_Ent1', locale: 'en' }),
    });
    prefetchScreen('/experiences/exp_Ent1', 'fr');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/member/exp_Ent1/home']);
    // The answer, as the page reads it, and the dashboard's readings already on their way.
    expect(await getJson('/api/member/exp_Ent1/home')).toEqual({
      dashboard: '/dashboard/biz_Ent1',
      locale: 'en',
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/member/exp_Ent1/home',
      `${api}/session`,
      `${api}/members`,
      `${api}/integrations?lang=fr`,
      `${api}/sync`,
      `${api}/dashboard`,
    ]);
    expect(localStorage.getItem(entryKey('exp_Ent1'))).toBe('/dashboard/biz_Ent1');
  });

  it('on a device that opened it before, asks the dashboard’s readings at once, alongside', () => {
    localStorage.setItem(entryKey('exp_Ent2'), '/dashboard/biz_Ent2');
    const fetchMock = server({});
    prefetchScreen('/experiences/exp_Ent2', 'en');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/creator/biz_Ent2/session',
      '/api/creator/biz_Ent2/members',
      '/api/creator/biz_Ent2/integrations?lang=en',
      '/api/creator/biz_Ent2/sync',
      '/api/creator/biz_Ent2/dashboard',
      '/api/member/exp_Ent2/home',
    ]);
  });

  it('a member: nothing more asked, and a dashboard this device remembered is forgotten', async () => {
    localStorage.setItem(entryKey('exp_Ent3'), '/dashboard/biz_Ent3');
    const fetchMock = server({
      '/api/member/exp_Ent3/home': json({ dashboard: null, locale: 'fr' }),
    });
    prefetchScreen('/experiences/exp_Ent3', 'en');
    const asked = fetchMock.mock.calls.length;
    await getJson('/api/member/exp_Ent3/home');
    // The remembered dashboard's readings, the server will refuse; nothing after the answer.
    expect(fetchMock).toHaveBeenCalledTimes(asked);
    expect(localStorage.getItem(entryKey('exp_Ent3'))).toBeNull();
  });

  it('asks again when the early answer failed, or came too long before', async () => {
    let first = true;
    const fetchMock = server({
      '/api/creator/biz_Pre3/dashboard': () => {
        const answer = first ? json({}, 404)() : json({ ok: true })();
        first = false;
        return answer;
      },
    });
    prefetch('/api/creator/biz_Pre3/dashboard');
    expect(await getJson('/api/creator/biz_Pre3/dashboard')).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    prefetch('/api/creator/biz_Pre3/dashboard');
    vi.advanceTimersByTime(11_000);
    await getJson('/api/creator/biz_Pre3/dashboard');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('gives up an early answer that never comes when its screen gives up', async () => {
    // The Worker never answers the early reading; refused at once once the screen gave up.
    const fetchMock = vi.fn((_input: string, init?: RequestInit) =>
      init?.signal?.aborted
        ? Promise.reject(new DOMException('aborted', 'AbortError'))
        : new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    prefetch('/api/creator/biz_Pre9/session');
    const screen = new AbortController();
    const reading = getJson('/api/creator/biz_Pre9/session', screen.signal);
    screen.abort();
    await expect(reading).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
