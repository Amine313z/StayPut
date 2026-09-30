import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from '../src';

const SECRET = 'ws_test_7f3c9a1e5b2d';
const NOW = new Date('2026-09-30T12:00:00Z');
const TS = Math.floor(NOW.getTime() / 1000);
const BODY = '{"type":"membership.activated","data":{"id":"mem_1"}}';

async function headersFor(body = BODY, { secret = SECRET, id = 'msg_1', ts = TS } = {}) {
  return new Headers({
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': await signWebhook(body, secret, id, ts),
  });
}

describe('verifyWebhook', () => {
  it('accepts a delivery signed with our secret', async () => {
    expect(await verifyWebhook(BODY, await headersFor(), SECRET, NOW)).toEqual({
      ok: true,
      id: 'msg_1',
      timestamp: TS,
    });
  });

  it('matches a known Standard Webhooks signature (HMAC of the literal secret bytes)', async () => {
    // Computed independently: base64(HMAC-SHA256("ws_test_7f3c9a1e5b2d", "msg_1.<ts>.<body>")).
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', SECRET).update(`msg_1.${TS}.${BODY}`).digest('base64');
    expect(await signWebhook(BODY, SECRET, 'msg_1', TS)).toBe(`v1,${expected}`);
  });

  it('accepts any valid signature among several (secret rotation)', async () => {
    const headers = await headersFor();
    const good = headers.get('webhook-signature')!;
    headers.set('webhook-signature', `v1,AAAA ${good} v2,ignored`);
    expect((await verifyWebhook(BODY, headers, SECRET, NOW)).ok).toBe(true);
  });

  it('refuses a modified body', async () => {
    expect(await verifyWebhook(`${BODY} `, await headersFor(), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('refuses a signature made with another secret', async () => {
    const headers = await headersFor(BODY, { secret: 'ws_other' });
    expect((await verifyWebhook(BODY, headers, SECRET, NOW)).ok).toBe(false);
  });

  it('refuses a replayed or future delivery', async () => {
    const old = await headersFor(BODY, { ts: TS - 301 });
    expect(await verifyWebhook(BODY, old, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'timestamp_out_of_range',
    });
    const future = await headersFor(BODY, { ts: TS + 301 });
    expect((await verifyWebhook(BODY, future, SECRET, NOW)).ok).toBe(false);
  });

  it('refuses missing headers, a bad timestamp and a missing secret', async () => {
    expect(await verifyWebhook(BODY, new Headers(), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    const headers = await headersFor();
    headers.set('webhook-timestamp', '12e3');
    expect(await verifyWebhook(BODY, headers, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'invalid_timestamp',
    });
    expect(await verifyWebhook(BODY, await headersFor(), undefined, NOW)).toEqual({
      ok: false,
      reason: 'missing_secret',
    });
  });

  it('ignores a signature that is not valid base64', async () => {
    const headers = await headersFor();
    headers.set('webhook-signature', 'v1,%%%');
    expect((await verifyWebhook(BODY, headers, SECRET, NOW)).ok).toBe(false);
  });
});
