import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson, prefetch } from '../src/api';
import { prefetchScreen } from '../src/prefetch';

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
    prefetchScreen('/experiences/exp_1', 'en');
    prefetchScreen('/demo', 'en');
    expect(fetchMock).not.toHaveBeenCalled();
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
});
