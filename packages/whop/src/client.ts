import { isAccessLevel, type AccessLevel } from '@stayput/core';
import type { Whop } from '@whop/sdk';
import { WHOP_API_BASE_URL, WHOP_API_VERSION_DATE, type WhopEnv } from './env';
import { WhopApiError, readErrorBody } from './errors';
import {
  DEFAULT_RETRY_POLICY,
  backoffDelay,
  isRetryableStatus,
  parseRetryAfter,
  type RetryPolicy,
} from './retry';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Makes a POST or PATCH safe to retry: Whop applies it once per key. */
  idempotencyKey?: string;
}

export interface Page<T> {
  items: T[];
  /** Cursor of the next page (`after`), null on the last page. */
  nextCursor: string | null;
}

export interface AccessCheck {
  hasAccess: boolean;
  accessLevel: AccessLevel;
}

export interface WhopClientOptions {
  /** The app API key: it acts on every account that installed the app. Server side only. */
  apiKey: string;
  env: WhopEnv;
  apiVersionDate?: string;
  retry?: Partial<RetryPolicy>;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface WhopClient {
  readonly env: WhopEnv;
  request<T>(method: HttpMethod, path: string, options?: RequestOptions): Promise<T>;
  /** One page of a list endpoint (`first` / `after` cursors). */
  listPage<T>(
    path: string,
    query?: Record<string, QueryValue>,
    cursor?: { after?: string | null; first?: number },
  ): Promise<Page<T>>;
  /**
   * One page of a list endpoint as Whop sent it, unparsed: the sync hands it to Postgres as is,
   * so that the Worker spends no CPU time on JSON (DECISIONS.md, Phase 2).
   */
  listPageRaw(
    path: string,
    query?: Record<string, QueryValue>,
    cursor?: { after?: string | null; first?: number },
  ): Promise<string>;
  /**
   * One object as Whop sent it, unparsed (`GET /users/{id}` for the sync): Postgres reads it, as
   * it reads the pages of listPageRaw.
   */
  getRaw(path: string, query?: Record<string, QueryValue>): Promise<string>;
  /** Pages one after the other, from `after`, at most `maxPages` of them. */
  paginate<T>(
    path: string,
    query?: Record<string, QueryValue>,
    options?: { after?: string | null; first?: number; maxPages?: number },
  ): AsyncGenerator<Page<T>, void, undefined>;
  /** `GET /users/{id}/access/{resource}`: account (`biz_`), product (`prod_`) or experience (`exp_`). */
  checkAccess(userId: string, resourceId: string): Promise<AccessCheck>;
}

export const DEFAULT_PAGE_SIZE = 50;

// Retrying these can never apply a change twice; POST and PATCH need an idempotency key.
const SAFE_TO_RETRY: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

export function createWhopClient(options: WhopClientOptions): WhopClient {
  if (!options.apiKey) throw new Error('A Whop API key is required');
  const baseUrl = WHOP_API_BASE_URL[options.env];
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  // Called through a wrapper: Workers reject a detached `fetch` ("Illegal invocation").
  const send = options.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const apiVersionDate = options.apiVersionDate ?? WHOP_API_VERSION_DATE;

  /** The body of a successful response, as text; retries what is safe to retry. */
  async function call(
    method: HttpMethod,
    path: string,
    { query, body, idempotencyKey }: RequestOptions = {},
  ): Promise<string> {
    const url = buildUrl(baseUrl, path, query);
    const headers = new Headers({
      Authorization: `Bearer ${options.apiKey}`,
      Accept: 'application/json',
      'Api-Version-Date': apiVersionDate,
    });
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
    const retryable = SAFE_TO_RETRY.has(method) || Boolean(idempotencyKey);

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await send(url, { method, headers, body: payload });
      } catch (cause) {
        const error = new WhopApiError(0, 'network_error', describe(cause), { method, path });
        if (!retryable || attempt >= policy.maxRetries) throw error;
        await sleep(backoffDelay(attempt, policy, random));
        continue;
      }

      const text = await response.text();
      if (response.ok) return text;

      const parsed = readErrorBody(text);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      const error = new WhopApiError(
        response.status,
        parsed?.type ?? `http_${response.status}`,
        parsed?.message ?? (text.slice(0, 200) || response.statusText),
        { method, path, code: parsed?.code ?? null, param: parsed?.param ?? null, retryAfterMs },
      );
      if (!retryable || !isRetryableStatus(response.status) || attempt >= policy.maxRetries) {
        throw error;
      }
      const delay = retryAfterMs ?? backoffDelay(attempt, policy, random);
      // Whop asks for a long pause: leave it to the caller (the next cron run) rather than
      // spending the Worker's time asleep.
      if (delay > policy.maxDelayMs) throw error;
      await sleep(delay);
    }
  }

  async function request<T>(
    method: HttpMethod,
    path: string,
    requestOptions?: RequestOptions,
  ): Promise<T> {
    const text = await call(method, path, requestOptions);
    if (text === '') return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WhopApiError(200, 'invalid_response', 'the body is not JSON', { method, path });
    }
  }

  async function listPage<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    cursor: { after?: string | null; first?: number } = {},
  ): Promise<Page<T>> {
    const page = await request<{ data?: unknown; page_info?: Whop.PageInfo }>('GET', path, {
      query: { ...query, first: cursor.first ?? DEFAULT_PAGE_SIZE, after: cursor.after },
    });
    if (!page || !Array.isArray(page.data) || typeof page.page_info !== 'object') {
      throw new WhopApiError(200, 'invalid_response', 'not a list page', { method: 'GET', path });
    }
    const { has_next_page: hasNext, end_cursor: endCursor } = page.page_info;
    return { items: page.data as T[], nextCursor: hasNext && endCursor ? endCursor : null };
  }

  async function listPageRaw(
    path: string,
    query: Record<string, QueryValue> = {},
    cursor: { after?: string | null; first?: number } = {},
  ): Promise<string> {
    const text = await call('GET', path, {
      query: { ...query, first: cursor.first ?? DEFAULT_PAGE_SIZE, after: cursor.after },
    });
    // A cheap look at the first character only: Postgres reads the rest.
    if (!/^\s*\{/.test(text)) {
      throw new WhopApiError(200, 'invalid_response', 'not a list page', { method: 'GET', path });
    }
    return text;
  }

  async function getRaw(path: string, query: Record<string, QueryValue> = {}): Promise<string> {
    const text = await call('GET', path, { query });
    if (!/^\s*\{/.test(text)) {
      throw new WhopApiError(200, 'invalid_response', 'not an object', { method: 'GET', path });
    }
    return text;
  }

  async function* paginate<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    {
      after = null,
      first,
      maxPages = Number.POSITIVE_INFINITY,
    }: {
      after?: string | null;
      first?: number;
      maxPages?: number;
    } = {},
  ): AsyncGenerator<Page<T>, void, undefined> {
    let cursor = after;
    for (let pages = 0; pages < maxPages; pages += 1) {
      const page = await listPage<T>(path, query, { after: cursor, ...(first ? { first } : {}) });
      yield page;
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  async function checkAccess(userId: string, resourceId: string): Promise<AccessCheck> {
    const path = `/users/${encodeURIComponent(userId)}/access/${encodeURIComponent(resourceId)}`;
    const body = await request<Partial<Whop.CheckAccessUsersResponse> | undefined>('GET', path);
    if (!body || typeof body.has_access !== 'boolean' || !isAccessLevel(body.access_level)) {
      throw new WhopApiError(200, 'invalid_response', 'unexpected access check', {
        method: 'GET',
        path,
      });
    }
    return { hasAccess: body.has_access, accessLevel: body.access_level };
  }

  return { env: options.env, request, listPage, listPageRaw, getRaw, paginate, checkAccess };
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  // Always a path of the Whop API, never another host.
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`Whop API paths start with a single "/": ${path}`);
  }
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
