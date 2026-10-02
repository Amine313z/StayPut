import { CSRF_HEADER, type ApiErrorBody, type ApiErrorCode } from '@stayput/core';
import { useEffect, useRef, useState } from 'react';

/**
 * A failed call: the Worker's error code, "network" when it could not be reached, or "demo" for a
 * page the demo has no data for (demo/api.ts).
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ApiErrorCode | 'network' | 'demo',
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

/** Where the demo community's calls go: answered in the browser (demo/api.ts), never sent. */
export const DEMO_API = `/api/creator/${DEMO_COMPANY_ID}/`;

async function requestJson<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
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
 * Loads `path`, with `retry()` to try again; a newer request always wins over an older one.
 * `reload()` reads it again while the screen keeps showing what it has.
 */
export function useApi<T>(path: string): {
  state: Loadable<T>;
  retry: () => void;
  reload: () => void;
} {
  const [attempt, setAttempt] = useState({ n: 0, quiet: false });
  const key = `${attempt.n}:${path}`;
  const [result, setResult] = useState<{ key: string; path: string; state: Loadable<T> } | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    getJson<T>(path, controller.signal).then(
      (data) => setResult({ key, path, state: { status: 'ready', data } }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError =
          error instanceof ApiError ? error : new ApiError('internal', String(error));
        setResult({ key, path, state: { status: 'error', error: apiError } });
      },
    );
    return () => controller.abort();
  }, [path, key]);

  let state: Loadable<T> = { status: 'loading' };
  if (result?.key === key) state = result.state;
  else if (attempt.quiet && result?.path === path && result.state.status === 'ready') {
    state = result.state;
  }
  return {
    state,
    retry: () => setAttempt((a) => ({ n: a.n + 1, quiet: false })),
    reload: () => setAttempt((a) => ({ n: a.n + 1, quiet: true })),
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
