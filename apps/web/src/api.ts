import type { ApiErrorBody, ApiErrorCode } from '@stayput/core';
import { useEffect, useState } from 'react';

/** A failed call: the Worker's error code, or "network" when it could not be reached. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ApiErrorCode | 'network',
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
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('network', error instanceof Error ? error.message : String(error));
  }
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as Partial<ApiErrorBody> | null;
  const login = body?.error?.login;
  throw new ApiError(
    body?.error?.code ?? codeForStatus(response.status),
    body?.error?.message ?? response.statusText,
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

/** Loads `path`, with `retry()` to try again; a newer request always wins over an older one. */
export function useApi<T>(path: string): { state: Loadable<T>; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}:${path}`;
  const [result, setResult] = useState<{ key: string; state: Loadable<T> } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getJson<T>(path, controller.signal).then(
      (data) => setResult({ key, state: { status: 'ready', data } }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError =
          error instanceof ApiError ? error : new ApiError('internal', String(error));
        setResult({ key, state: { status: 'error', error: apiError } });
      },
    );
    return () => controller.abort();
  }, [path, key]);

  return {
    state: result?.key === key ? result.state : { status: 'loading' },
    retry: () => setAttempt((n) => n + 1),
  };
}
