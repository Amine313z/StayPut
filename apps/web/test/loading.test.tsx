import type { PlatformActivityView } from '@stayput/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApi, usePolling } from '../src/api';
import { PlatformActivityCard } from '../src/components/PlatformActivityCard';
import { SyncPanel } from '../src/components/SyncPanel';
import { I18nProvider } from '../src/i18n';
import { useSync } from '../src/sync';

/**
 * Every block of a screen ends on its data, an empty state or an error with « Retry » within
 * 5 seconds (brief v4 §9.6), whatever the server does: slow, slower than the screen's own
 * polling, or silent.
 */

/**
 * A server answering each call after the next of `delays` (the last one repeats), with `body`
 * (by default, how many answers it gave).
 */
function server(...delays: number[]) {
  return serverOf((n) => ({ n }), ...delays);
}

function serverOf(body: (answer: number) => unknown, ...delays: number[]) {
  let answers = 0;
  let calls = 0;
  let inFlight = 0;
  let mostAtOnce = 0;
  const fetchMock = vi.fn(
    (_input: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const delay = delays[Math.min(calls, delays.length - 1)]!;
        calls += 1;
        inFlight += 1;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        const timer = setTimeout(() => {
          inFlight -= 1;
          answers += 1;
          resolve(
            new Response(JSON.stringify(body(answers)), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }, delay);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          inFlight -= 1;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls: () => calls,
    mostAtOnce: () => mostAtOnce,
  };
}

/** A block of a screen: read once, then every `every` ms. */
function Block({ every = 3_600_000 }: { every?: number }) {
  const { state, retry, reload } = useApi<{ n: number }>('/api/creator/biz_A1/slow');
  usePolling(reload, every);
  if (state.status === 'ready') return <p>Answer {state.data.n}</p>;
  if (state.status === 'error') {
    return (
      <button type="button" onClick={retry}>
        Retry ({state.error.code})
      </button>
    );
  }
  return <p>Loading</p>;
}

/** Time passes a quarter of a second at a time: React renders between, as in a browser. */
async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(250, left));
    });
  }
}

describe('a block of the screen never waits for ever', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows an answer slower than its own polling: a new reading waits for the one under way', async () => {
    // 12 seconds an answer, a reading asked every 10: before, each one cancelled the last.
    const calls = server(12_000);
    render(<Block every={10_000} />);
    await wait(12_100);
    expect(screen.getByText('Answer 1')).toBeTruthy();
    await wait(30_000);
    expect(screen.getByText(/^Answer [2-9]$/)).toBeTruthy();
    // One reading at a time.
    expect(calls.mostAtOnce()).toBe(1);
  });

  it('says after 5 seconds that it takes long, with Retry, and shows the answer when it comes', async () => {
    server(8_000);
    render(<Block />);
    await wait(4_900);
    expect(screen.getByText('Loading')).toBeTruthy();
    await wait(200);
    expect(screen.getByRole('button', { name: 'Retry (slow)' })).toBeTruthy();
    await wait(3_000);
    expect(screen.getByText('Answer 1')).toBeTruthy();
  });

  it('gives a silent call up after 20 seconds, and « Retry » asks again', async () => {
    const calls = server(600_000, 1_000);
    render(<Block />);
    await wait(20_100);
    fireEvent.click(screen.getByRole('button', { name: 'Retry (timeout)' }));
    expect(screen.getByText('Loading')).toBeTruthy();
    await wait(1_100);
    expect(screen.getByText('Answer 1')).toBeTruthy();
    expect(calls.calls()).toBe(2);
  });

  it('keeps the Activity tab live without ever staying on « Loading… »', async () => {
    // Discord read first: 8 seconds the first time, then 12, longer than the 10 between readings.
    const activity = (messages: number): PlatformActivityView => ({
      from: '2026-09-04',
      to: '2026-10-03',
      platforms: [
        {
          platform: 'discord',
          messages,
          authors: 1,
          members: 1,
          team: 0,
          guests: 0,
          unlinked: 0,
          lastAt: '2026-10-03T09:00:00.000Z',
          daily: [...Array.from({ length: 29 }, () => 0), messages],
        },
      ],
      places: [],
      topMembers: [],
    });
    const calls = serverOf((n) => activity(n * 3), 8_000, 12_000);
    let news = 0;
    render(
      <MemoryRouter>
        <I18nProvider initialLocale="en">
          <PlatformActivityCard
            api="/api/creator/biz_A1"
            platforms={['discord']}
            onNews={() => (news += 1)}
          />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Loading…')).toBeTruthy();
    await wait(5_100);
    // Five seconds: no more « Loading… », what happens and « Retry ».
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('This is taking longer than usual.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    await wait(3_000);
    expect(screen.getByText('3 messages')).toBeTruthy();
    // Then every 10 seconds, each reading after the last: the counts move, never back.
    await wait(40_000);
    expect(screen.getByText(/^(6|9|12) messages$/)).toBeTruthy();
    expect(calls.mostAtOnce()).toBe(1);
    expect(news).toBeGreaterThan(0);
  });

  it('says when the state of the synchronization is late, and reads it again on « Retry »', async () => {
    const calls = serverOf(
      () => ({ backfillDone: true, lastSyncAt: '2026-10-03T09:00:00.000Z', streams: [] }),
      600_000,
      500,
    );
    function Whop() {
      return <SyncPanel sync={useSync('biz_A1', () => {})} />;
    }
    render(
      <MemoryRouter>
        <I18nProvider initialLocale="en">
          <Whop />
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Loading…')).toBeTruthy();
    await wait(5_100);
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('This is taking longer than usual.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await wait(600);
    expect(screen.queryByText('This is taking longer than usual.')).toBeNull();
    expect(screen.getByText('Up to date.')).toBeTruthy();
    expect(calls.calls()).toBe(2);
  });

  it('keeps what it shows when a later reading fails', async () => {
    server(500, 600_000);
    render(<Block every={10_000} />);
    await wait(600);
    expect(screen.getByText('Answer 1')).toBeTruthy();
    // The next reading never answers: given up after 20 seconds, the answer stays.
    await wait(40_000);
    expect(screen.getByText('Answer 1')).toBeTruthy();
  });
});
