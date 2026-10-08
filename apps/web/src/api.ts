import { CSRF_HEADER, type ApiErrorBody, type ApiErrorCode } from '@stayput/core';
import { useEffect, useRef, useState } from 'react';

/**
 * A failed call: the Worker's error code, "network" when it could not be reached, "demo" for a
 * page the demo has no data for (demo/api.ts), "slow" while a first answer is late (useApi), and
 * "timeout" when none came.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ApiErrorCode | 'network' | 'demo' | 'slow' | 'timeout',
    message: string,
    /** With `unauthenticated` in the sandbox: where to sign in with Whop outside the iframe. */
    readonly login: string | null = null,
  ) {
    super(message);
  }
}

/**
 * GET on the Worker. Same origin, relative path: Whop's proxy adds the user token to these
 * requests only (docs/whop-api-verification.md, section 3).
 */
export function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>('GET', path, signal);
}

/**
 * POST on the Worker (a JSON body if given), with the header that tells the Worker the page
 * itself sends it.
 */
export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return requestJson<T>('POST', path, undefined, body);
}

/** PUT a JSON body on the Worker (with the same header). */
export function putJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>('PUT', path, undefined, body);
}

/** DELETE on the Worker (with the same header). */
export function deleteJson<T>(path: string): Promise<T> {
  return requestJson<T>('DELETE', path);
}

/** The demo community's id (/demo): no Whop company has it (theirs start with `biz_`). */
export const DEMO_COMPANY_ID = 'demo';
/**
 * The id the demo community shows wherever a real one shows its Whop id (`biz_…`): Settings ›
 * Developer, the data export, the badge's addresses. Its API path keeps `demo`.
 */
export const DEMO_WHOP_ID = 'biz_AtlasTradingClub';

/** Where the demo community's calls go: answered in the browser (demo/api.ts), never sent. */
export const DEMO_API = `/api/creator/${DEMO_COMPANY_ID}/`;

/**
 * Readings asked ahead of their screen (`prefetch`): the page asks them all at once, as it
 * opens, instead of waiting for the session's answer before asking the rest. The screen that
 * reads one first takes it; one left unread for 10 seconds is dropped, and one that failed is
 * asked again (on a first visit, the community is written by the session's reading).
 */
const early = new Map<string, { at: number; answer: Promise<unknown> }>();
const EARLY_MS = 10_000;

/** Asks for `path` now, for the screen about to read it (GET, never the demo's). */
export function prefetch(path: string): void {
  if (path.startsWith(DEMO_API) || early.has(path)) return;
  const answer = requestJson<unknown>('GET', path);
  // A failure is left to the screen's own reading, which asks again.
  answer.catch(() => {});
  early.set(path, { at: Date.now(), answer });
}

function takeEarly(path: string): Promise<unknown> | null {
  const entry = early.get(path);
  if (!entry) return null;
  early.delete(path);
  return Date.now() - entry.at <= EARLY_MS ? entry.answer : null;
}

async function requestJson<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const asked = method === 'GET' ? takeEarly(path) : null;
  if (asked) {
    try {
      return (await asked) as T;
    } catch {
      // Asked again below.
    }
  }
  if (path.startsWith(DEMO_API)) {
    // Loaded only when someone opens the demo: its data never weighs on the real dashboard.
    const { answerDemo } = await import('./demo/api');
    return (await answerDemo(method, path, body)) as T;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(method === 'GET' ? {} : { [CSRF_HEADER]: '1' }),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('network', error instanceof Error ? error.message : String(error));
  }
  if (response.ok) return (await response.json()) as T;
  const failure = (await response.json().catch(() => null)) as Partial<ApiErrorBody> | null;
  const login = failure?.error?.login;
  throw new ApiError(
    failure?.error?.code ?? codeForStatus(response.status),
    failure?.error?.message ?? response.statusText,
    typeof login === 'string' && login.startsWith('/') ? login : null,
  );
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'internal';
}

export type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ApiError };

/**
 * A block's first answer is awaited this long; then the block says it is taking long, with
 * « Retry » (brief v4 §9.6: never « Loading… » for more than 5 seconds).
 */
export const SLOW_MS = 5_000;

/** A reading with no answer after this long is given up: the next one can start. */
export const GIVE_UP_MS = 20_000;

/**
 * Loads `path` (read with GET, or POST for a read that refreshes first), with `retry()` to start
 * over and `reload()` to read again while the screen keeps what it shows, even when that reading
 * fails. One reading at a time: a reload asked while one is under way runs right after it,
 * never cancelling it, so an answer slower than the screen's own polling still shows (the
 * Activity tab stayed on « Loading… »: each new reading cancelled the last). Within 5 seconds
 * the block shows its data, or says it is taking long with « Retry », and still shows an answer
 * that comes later; a reading is given up after 20 seconds.
 */
export function useApi<T>(
  path: string,
  options: { method?: 'GET' | 'POST' } = {},
): {
  state: Loadable<T>;
  retry: () => void;
  reload: () => void;
} {
  const method = options.method ?? 'GET';
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState<{
    path: string;
    attempt: number;
    state: Loadable<T>;
  } | null>(null);
  // How to read again: set by the reading under way, called by `reload()`.
  const reader = useRef<() => void>(() => {});

  useEffect(() => {
    let closed = false;
    let running: AbortController | null = null;
    let again = false;
    let answered = false;
    const show = (state: Loadable<T>) => setShown({ path, attempt, state });
    const read = () => {
      const controller = new AbortController();
      running = controller;
      let gaveUp = false;
      const giveUp = window.setTimeout(() => {
        gaveUp = true;
        controller.abort();
      }, GIVE_UP_MS);
      requestJson<T>(method, path, controller.signal)
        .then(
          (data) => {
            if (closed) return;
            answered = true;
            show({ status: 'ready', data });
          },
          (error: unknown) => {
            // What is shown stays: the next reading tries again.
            if (closed || answered) return;
            show({
              status: 'error',
              error: gaveUp
                ? new ApiError('timeout', `no answer in ${GIVE_UP_MS / 1000} seconds`)
                : error instanceof ApiError
                  ? error
                  : new ApiError('internal', String(error)),
            });
          },
        )
        .finally(() => {
          window.clearTimeout(giveUp);
          running = null;
          if (closed || !again) return;
          again = false;
          read();
        });
    };
    read();
    // No answer yet after 5 seconds: the block says so; an answer that comes later still shows.
    const slow = window.setTimeout(() => {
      if (closed || answered) return;
      setShown((current) =>
        current?.path === path && current.attempt === attempt
          ? current
          : {
              path,
              attempt,
              state: {
                status: 'error',
                error: new ApiError('slow', `no answer in ${SLOW_MS / 1000} seconds`),
              },
            },
      );
    }, SLOW_MS);
    reader.current = () => {
      if (running) again = true;
      else read();
    };
    return () => {
      closed = true;
      window.clearTimeout(slow);
      running?.abort();
    };
  }, [method, path, attempt]);

  const state: Loadable<T> =
    shown?.path === path && shown.attempt === attempt ? shown.state : { status: 'loading' };
  return {
    state,
    retry: () => setAttempt((n) => n + 1),
    reload: () => reader.current(),
  };
}

/** Runs `reload` every `everyMs` while the page is visible: a list kept current without a click. */
export function usePolling(reload: () => void, everyMs: number): void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  }, [reload]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') latest.current();
    }, everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
}

/**
 * Runs `reload` when the user comes back to the page: after connecting Discord or Telegram in
 * another tab, the screen shows it without a click.
 */
export function useReloadOnReturn(reload: () => void): void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  }, [reload]);
  useEffect(() => {
    // Coming back fires both events: one reload is enough.
    let last = 0;
    const run = () => {
      const now = Date.now();
      if (now - last < 1_000) return;
      last = now;
      latest.current();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    const onFocus = run;
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}

/**
 * Runs `reload` each time `value` changes once it is known: new data arrived elsewhere (a
 * synchronization), the screen reads its own again.
 */
export function useReloadOnChange(value: string | null | undefined, reload: () => void): void {
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  }, [reload]);
  const seen = useRef(value);
  useEffect(() => {
    const before = seen.current;
    seen.current = value;
    if (before != null && value != null && before !== value) latest.current();
  }, [value]);
}
