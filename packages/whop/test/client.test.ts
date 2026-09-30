import { describe, expect, it } from 'vitest';
import {
  WhopApiError,
  createWhopClient,
  parseRetryAfter,
  parseWhopEnv,
  type WhopClientOptions,
} from '../src';

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/** A fake Whop: answers the queued responses in order and records every request. */
function fakeWhop(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const options: WhopClientOptions = {
    apiKey: 'test_key',
    env: 'sandbox',
    fetch: (input, init) => {
      calls.push({
        url: new URL(input),
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      const next = responses.shift();
      if (!next) return Promise.reject(new Error('unexpected request'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => Date.parse('2026-09-30T12:00:00Z'),
  };
  return { calls, sleeps, options };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const whopError = (status: number, type: string, message: string, headers = {}) =>
  json({ error: { type, message } }, status, headers);

describe('requests', () => {
  it('targets the sandbox or production API with the key and the pinned version', async () => {
    const sandbox = fakeWhop(json({ id: 'biz_1' }));
    await createWhopClient(sandbox.options).request('GET', '/accounts/biz_1');
    const call = sandbox.calls[0]!;
    expect(call.url.toString()).toBe('https://sandbox-api.whop.com/api/v1/accounts/biz_1');
    expect(call.headers.get('authorization')).toBe('Bearer test_key');
    expect(call.headers.get('api-version-date')).toBe('2026-09-29');

    const production = fakeWhop(json({}));
    await createWhopClient({ ...production.options, env: 'production' }).request('GET', '/x');
    expect(production.calls[0]!.url.host).toBe('api.whop.com');
  });

  it('sends JSON bodies and idempotency keys, and skips empty query values', async () => {
    const whop = fakeWhop(json({ id: 'promo_1' }, 201));
    await createWhopClient(whop.options).request('POST', '/promo_codes', {
      query: { account_id: 'biz_1', expand: undefined, page: null },
      body: { code: 'BACK7', stock: 1 },
      idempotencyKey: 'promo:mem_1',
    });
    const call = whop.calls[0]!;
    expect(call.url.search).toBe('?account_id=biz_1');
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(call.headers.get('idempotency-key')).toBe('promo:mem_1');
    expect(JSON.parse(call.body!)).toEqual({ code: 'BACK7', stock: 1 });
  });

  it('refuses a path that could leave the Whop API', async () => {
    const client = createWhopClient(fakeWhop().options);
    await expect(client.request('GET', '//evil.example/x')).rejects.toThrow(/single "\/"/);
    await expect(client.request('GET', 'https://evil.example')).rejects.toThrow();
  });

  it('turns an error body into a typed error', async () => {
    const whop = fakeWhop(whopError(403, 'forbidden', 'This endpoint is not available'));
    const error = await createWhopClient(whop.options)
      .request('POST', '/memberships/invite', { body: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WhopApiError);
    expect(error).toMatchObject({ status: 403, type: 'forbidden' });
    expect((error as Error).message).toContain('This endpoint is not available');
  });

  it('reports a body that is not JSON', async () => {
    const whop = fakeWhop(new Response('<html>', { status: 200 }));
    await expect(createWhopClient(whop.options).request('GET', '/x')).rejects.toMatchObject({
      type: 'invalid_response',
    });
  });
});

describe('retries', () => {
  it('retries a 429 after the delay Whop asks for', async () => {
    const whop = fakeWhop(
      whopError(429, 'rate_limited', 'slow down', { 'retry-after': '2' }),
      json({ ok: true }),
    );
    await expect(createWhopClient(whop.options).request('GET', '/x')).resolves.toEqual({
      ok: true,
    });
    expect(whop.sleeps).toEqual([2000]);
  });

  it('backs off exponentially on 5xx and network errors, then gives up', async () => {
    const whop = fakeWhop(
      new TypeError('network down'),
      whopError(502, 'bad_gateway', 'upstream'),
      whopError(503, 'unavailable', 'later'),
      whopError(500, 'internal', 'still broken'),
    );
    const error = await createWhopClient(whop.options)
      .request('GET', '/x')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 500 });
    expect(whop.calls).toHaveLength(4); // 1 attempt + 3 retries
    // Full jitter with random() = 0.5: half of 500, 1000, 2000 ms.
    expect(whop.sleeps).toEqual([250, 500, 1000]);
  });

  it('never retries a client error', async () => {
    const whop = fakeWhop(whopError(404, 'not_found', 'no such membership'));
    await expect(createWhopClient(whop.options).request('GET', '/x')).rejects.toMatchObject({
      status: 404,
    });
    expect(whop.calls).toHaveLength(1);
  });

  it('retries a POST only when it carries an idempotency key', async () => {
    const unsafe = fakeWhop(whopError(503, 'unavailable', 'later'));
    await expect(
      createWhopClient(unsafe.options).request('POST', '/promo_codes', { body: {} }),
    ).rejects.toMatchObject({ status: 503 });
    expect(unsafe.calls).toHaveLength(1);

    const keyed = fakeWhop(whopError(503, 'unavailable', 'later'), json({ id: 'promo_1' }));
    await createWhopClient(keyed.options).request('POST', '/promo_codes', {
      body: {},
      idempotencyKey: 'k1',
    });
    expect(keyed.calls).toHaveLength(2);
  });

  it('hands a long pause back to the caller instead of sleeping through it', async () => {
    const whop = fakeWhop(whopError(429, 'rate_limited', 'wait', { 'retry-after': '60' }));
    await expect(createWhopClient(whop.options).request('GET', '/x')).rejects.toMatchObject({
      status: 429,
      details: { retryAfterMs: 60_000 },
    });
    expect(whop.sleeps).toEqual([]);
  });

  it('reads Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('Wed, 30 Sep 2026 12:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});

describe('pagination', () => {
  const page = (ids: string[], next: string | null) =>
    json({
      data: ids.map((id) => ({ id })),
      page_info: { end_cursor: next, has_next_page: next !== null },
    });

  it('follows the cursor until the last page', async () => {
    const whop = fakeWhop(page(['mem_1', 'mem_2'], 'c1'), page(['mem_3'], null));
    const client = createWhopClient(whop.options);
    const seen: string[] = [];
    for await (const { items } of client.paginate<{ id: string }>('/memberships', {
      account_id: 'biz_1',
    })) {
      seen.push(...items.map((m) => m.id));
    }
    expect(seen).toEqual(['mem_1', 'mem_2', 'mem_3']);
    expect(whop.calls[0]!.url.searchParams.get('first')).toBe('50');
    expect(whop.calls[0]!.url.searchParams.has('after')).toBe(false);
    expect(whop.calls[1]!.url.searchParams.get('after')).toBe('c1');
  });

  it('stops after maxPages and gives the cursor to resume from', async () => {
    const whop = fakeWhop(page(['mem_1'], 'c1'));
    const client = createWhopClient(whop.options);
    const pages = [];
    for await (const p of client.paginate('/memberships', {}, { maxPages: 1 })) pages.push(p);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.nextCursor).toBe('c1');
  });

  it('rejects a response that is not a list page', async () => {
    const whop = fakeWhop(json({ id: 'x' }));
    await expect(createWhopClient(whop.options).listPage('/memberships')).rejects.toMatchObject({
      type: 'invalid_response',
    });
  });
});

describe('access check', () => {
  it('calls GET /users/{id}/access/{resource} and returns the level', async () => {
    const whop = fakeWhop(json({ has_access: true, access_level: 'admin' }));
    const access = await createWhopClient(whop.options).checkAccess('user_1', 'biz_1');
    expect(access).toEqual({ hasAccess: true, accessLevel: 'admin' });
    expect(whop.calls[0]!.url.pathname).toBe('/api/v1/users/user_1/access/biz_1');
  });

  it('refuses an unknown access level instead of guessing', async () => {
    const whop = fakeWhop(json({ has_access: true, access_level: 'owner' }));
    await expect(
      createWhopClient(whop.options).checkAccess('user_1', 'biz_1'),
    ).rejects.toMatchObject({ type: 'invalid_response' });
  });
});

describe('WHOP_ENV', () => {
  it('defaults to the sandbox and refuses unknown values', () => {
    expect(parseWhopEnv(undefined)).toBe('sandbox');
    expect(parseWhopEnv('')).toBe('sandbox');
    expect(parseWhopEnv('production')).toBe('production');
    expect(() => parseWhopEnv('prod')).toThrow(/WHOP_ENV/);
  });
});
