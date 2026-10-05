import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE_MAX, jobState, scrubErrorMessage } from '../src/operations';

describe('scrubErrorMessage (SPEC 8.2, 8.5)', () => {
  it('keeps no person: e-mails, Whop user and member ids, phone numbers, account ids', () => {
    expect(
      scrubErrorMessage(
        'member mber_Xy12 (user_Ab34, mem_Cd56) ana.b+test@mail.co.uk called +33 6 12 34 56 78 ' +
          'as discord 123456789012345678',
      ),
    ).toBe('member mber_… (user_…, mem_…) [email] called [number] as discord [number]');
  });

  it('keeps no secret: keys, bearer tokens, long tokens, the query of an address', () => {
    expect(
      scrubErrorMessage(
        'GET https://api.whop.com/api/v1/members?company_id=biz_A1&token=abc failed: ' +
          'Authorization: Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyX0FiYyJ9.sig with apik_live_9Zx ' +
          'and ws_secret_77 and hash 0123456789abcdef0123456789abcdef0123',
      ),
    ).toBe(
      'GET https://api.whop.com/api/v1/members?[query] failed: Authorization: Bearer [redacted] ' +
        'with apik_[redacted] and ws_[redacted] and hash [redacted]',
    );
  });

  it('keeps what helps: the community, the status, a date, the time', () => {
    expect(scrubErrorMessage('biz_A1: 403 forbidden since 2026-10-05T09:00:00Z')).toBe(
      'biz_A1: 403 forbidden since 2026-10-05T09:00:00Z',
    );
  });

  it('reads an Error, flattens lines and spaces, and cuts a long message', () => {
    expect(scrubErrorMessage(new Error('line one\n\tline   two'))).toBe('line one line two');
    expect(scrubErrorMessage('')).toBe('unknown error');
    expect(scrubErrorMessage(42)).toBe('42');
    const long = scrubErrorMessage('word '.repeat(200));
    expect(long).toHaveLength(ERROR_MESSAGE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('jobState', () => {
  const now = new Date('2026-10-05T09:00:00Z');
  const run = (finished: string, ok: string | null, failed: string | null) => ({
    lastFinishedAt: finished,
    lastOkAt: ok,
    lastFailedAt: failed,
  });

  it('says a job never ran, failed last, is late or is fine', () => {
    expect(jobState(null, 10, now)).toBe('never');
    expect(jobState(run('2026-10-05T08:55:00Z', null, '2026-10-05T08:55:00Z'), 10, now)).toBe(
      'failing',
    );
    expect(
      jobState(
        run('2026-10-05T08:55:00Z', '2026-10-05T08:55:00Z', '2026-10-05T08:45:00Z'),
        10,
        now,
      ),
    ).toBe('ok');
    // Two periods and 5 minutes without a run: Cloudflare skipped it, or the Worker stopped.
    expect(jobState(run('2026-10-05T08:34:00Z', '2026-10-05T08:34:00Z', null), 10, now)).toBe(
      'late',
    );
    expect(jobState(run('2026-10-05T08:36:00Z', '2026-10-05T08:36:00Z', null), 10, now)).toBe('ok');
  });
});
