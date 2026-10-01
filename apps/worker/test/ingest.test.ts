import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { member, membership, message, page, payment, variant } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0005: Whop's raw pages and webhook deliveries into members, memberships, payments
 * and activity_events, in SQL (supabase/migrations/0005_data_collection.sql).
 */

const NOW = '2026-10-01T12:00:00Z';
let t: TestDb;
let companies = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

/**
 * A fresh company, so that every test starts from nothing. Whop's ids are unique across
 * companies: `k` makes the fixtures' ids unique to this company too.
 */
async function company(): Promise<string> {
  companies += 1;
  const id = `biz_C${companies}`;
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [id, NOW]);
  return id;
}

async function ingest(companyId: string, kind: string, body: unknown, scope: string | null = null) {
  const [row] = await t.db.query<{ result: Record<string, unknown> }>(
    'select stayput.ingest_page($1, $2, $3, $4::text::jsonb) as result',
    [companyId, kind, scope, JSON.stringify(body)],
  );
  return row?.result ?? {};
}

const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);

/** An id unique to the current test's company (Whop's ids never repeat across companies). */
const u = (base: string) => `${base}Q${companies}`;

describe('members, variants, memberships', () => {
  it('stores joined and departed members, skips drafted ones, and never an email or phone', async () => {
    const c = await company();
    const result = await ingest(
      c,
      'members',
      page([
        member(u('mber_M1'), u('user_U1')),
        member(u('mber_M2'), u('user_U2'), { status: 'left' }),
        member(u('mber_M3'), u('user_U3'), { status: 'drafted' }),
      ]),
    );
    expect(result).toMatchObject({ count: 3, stored: 2, has_next_page: false });
    expect(
      await rows(
        `select id, user_id, display_name, status, cohort_month::text as cohort, access_level
           from stayput.members where company_id = $1 order by id`,
        [c],
      ),
    ).toEqual([
      {
        id: u('mber_M1'),
        user_id: u('user_U1'),
        display_name: `Name ${u('user_U1')}`,
        status: 'joined',
        cohort: '2026-06-01',
        access_level: 'customer',
      },
      {
        id: u('mber_M2'),
        user_id: u('user_U2'),
        display_name: `Name ${u('user_U2')}`,
        status: 'left',
        cohort: '2026-06-01',
        access_level: 'customer',
      },
    ]);
    const personal = await rows(
      `select 1 from stayput.members m where m.company_id = $1
          and (m::text like '%@%' or m::text like '%+33%')`,
      [c],
    );
    expect(personal).toEqual([]);
  });

  it('prices a membership from its variant, whichever arrives first, and links it to its member', async () => {
    const c = await company();
    await ingest(
      c,
      'memberships',
      page([membership(u('mem_S1'), u('user_U1'), { plan_id: u('plan_V1') })]),
    );
    expect(
      await rows('select price, member_id from stayput.memberships where company_id = $1', [c]),
    ).toEqual([{ price: null, member_id: null }]);

    await ingest(c, 'plans', page([variant(u('plan_V1'))]));
    await ingest(c, 'members', page([member(u('mber_M1'), u('user_U1'))]));
    expect(
      await rows(
        `select price::text, currency, billing_period_days, status, member_id,
                cancel_at_period_end, current_period_end
           from stayput.memberships where company_id = $1`,
        [c],
      ),
    ).toEqual([
      {
        price: '49.00',
        currency: 'usd',
        billing_period_days: 30,
        status: 'active',
        member_id: u('mber_M1'),
        cancel_at_period_end: false,
        current_period_end: new Date('2026-10-15T10:00:00Z'),
      },
    ]);

    // A later read with the cancellation scheduled updates the same row.
    await ingest(
      c,
      'memberships',
      page([
        membership(u('mem_S1'), u('user_U1'), {
          plan_id: u('plan_V1'),
          cancel_at_period_end: true,
        }),
      ]),
    );
    expect(
      await rows('select cancel_at_period_end from stayput.memberships where company_id = $1', [c]),
    ).toEqual([{ cancel_at_period_end: true }]);
  });

  it("never touches another company's row with the same id", async () => {
    const a = await company();
    const b = await company();
    await ingest(a, 'members', page([member(u('mber_SHARED'), u('user_S'))]));
    await ingest(b, 'members', page([member(u('mber_SHARED'), u('user_S'), { status: 'left' })]));
    expect(
      await rows('select company_id, status from stayput.members where id = $1', [
        u('mber_SHARED'),
      ]),
    ).toEqual([{ company_id: a, status: 'joined' }]);
  });
});

describe('payments', () => {
  it('reads the amount, the outcome and the failure, and links what it can', async () => {
    const c = await company();
    await ingest(c, 'members', page([member(u('mber_M1'), u('user_U1'))]));
    await ingest(c, 'memberships', page([membership(u('mem_S1'), u('user_U1'))]));
    await ingest(
      c,
      'payments',
      page([
        payment(u('pay_P1'), { member_id: u('mber_M1'), membership_id: u('mem_S1') }),
        payment(u('pay_P2'), {
          member_id: u('mber_M1'),
          membership_id: u('mem_S1'),
          status: 'open',
          substatus: 'failed',
          paid_at: null,
          failure_message: 'Your card was declined.',
          retryable: true,
          promo_code_id: u('promo_X1'),
          recovery_url: 'javascript:alert(1)',
        }),
        payment(u('pay_P3'), { membership_id: u('mem_UNKNOWN'), member_id: u('mber_UNKNOWN') }),
      ]),
    );
    expect(
      await rows(
        `select id, amount::text, status, failure_reason, retryable, promo_code_id, recovery_url,
                membership_id, member_id
           from stayput.payments where company_id = $1 order by id`,
        [c],
      ),
    ).toEqual([
      {
        id: u('pay_P1'),
        amount: '49.00',
        status: 'succeeded',
        failure_reason: null,
        retryable: false,
        promo_code_id: null,
        recovery_url: null,
        membership_id: u('mem_S1'),
        member_id: u('mber_M1'),
      },
      {
        id: u('pay_P2'),
        amount: '49.00',
        status: 'failed',
        failure_reason: 'Your card was declined.',
        retryable: true,
        promo_code_id: u('promo_X1'),
        recovery_url: null,
        membership_id: u('mem_S1'),
        member_id: u('mber_M1'),
      },
      // Unknown links are left empty rather than breaking the foreign keys.
      {
        id: u('pay_P3'),
        amount: '49.00',
        status: 'succeeded',
        failure_reason: null,
        retryable: false,
        promo_code_id: null,
        recovery_url: null,
        membership_id: null,
        member_id: null,
      },
    ]);
  });
});

describe('activity', () => {
  it('counts messages, posts, tickets and lessons once each, without their content', async () => {
    const c = await company();
    await ingest(c, 'members', page([member(u('mber_M1'), u('user_U1'))]));
    const messages = page(
      [
        message(u('msg_1'), u('user_U1'), '2026-09-30T20:00:00Z'),
        message(u('msg_2'), u('user_U1'), '2026-09-29T08:00:00Z'),
        message(u('msg_3'), u('user_U1'), '2026-09-29T09:00:00Z', { message_type: 'system' }),
        message(u('msg_4'), u('user_STRANGER'), '2026-09-29T10:00:00Z'),
      ],
      'cursor_2',
      true,
    );
    const first = await ingest(c, 'messages', messages, u('chat_C1'));
    expect(first).toMatchObject({
      count: 4,
      stored: 2,
      end_cursor: 'cursor_2',
      has_next_page: true,
      oldest_at: '2026-09-29T08:00:00+00:00',
      newest_at: '2026-09-30T20:00:00+00:00',
    });
    expect((await ingest(c, 'messages', messages, u('chat_C1'))).stored).toBe(2);

    await ingest(
      c,
      'forum_posts',
      page([
        {
          id: u('post_1'),
          created_at: '2026-09-28T12:00:00Z',
          parent_id: null,
          user: { id: u('user_U1') },
          content: 'x',
        },
      ]),
      u('exp_F1'),
    );
    await ingest(
      c,
      'support_channels',
      page([
        {
          id: u('sc_1'),
          customer_user: { id: u('user_U1') },
          last_message_at: '2026-09-27T12:00:00Z',
          resolved_at: '2026-09-27T15:00:00Z',
        },
      ]),
    );
    await ingest(
      c,
      'lesson_interactions',
      page([
        {
          id: u('li_1'),
          completed: true,
          created_at: '2026-09-26T12:00:00Z',
          lesson: { id: u('les_1'), title: 'Lesson 1', chapter: { id: u('chap_1') } },
          user: { id: u('user_U1') },
        },
        {
          id: u('li_2'),
          completed: false,
          created_at: '2026-09-26T13:00:00Z',
          lesson: { id: u('les_2'), title: 'Lesson 2' },
          user: { id: u('user_U1') },
        },
      ]),
      u('cors_1'),
    );

    expect(
      await rows(
        `select type, external_id, metadata from stayput.activity_events
          where company_id = $1 order by occurred_at desc`,
        [c],
      ),
    ).toEqual([
      { type: 'message', external_id: u('msg_1'), metadata: { channel_id: u('chat_C1') } },
      { type: 'message', external_id: u('msg_2'), metadata: { channel_id: u('chat_C1') } },
      {
        type: 'forum_post',
        external_id: u('post_1'),
        metadata: { experience_id: u('exp_F1'), comment: false },
      },
      {
        type: 'support_ticket_resolved',
        external_id: `${u('sc_1')}:2026-09-27T15:00:00Z`,
        metadata: { channel_id: u('sc_1') },
      },
      {
        type: 'support_ticket_opened',
        external_id: `${u('sc_1')}:first`,
        metadata: { channel_id: u('sc_1') },
      },
      {
        type: 'lesson_completed',
        external_id: u('li_1'),
        metadata: {
          lesson_id: u('les_1'),
          lesson_title: 'Lesson 1',
          chapter_id: u('chap_1'),
          course_id: u('cors_1'),
        },
      },
    ]);
    const content = await rows(
      `select 1 from stayput.activity_events e where e.company_id = $1
          and e.metadata::text like '%never stored%'`,
      [c],
    );
    expect(content).toEqual([]);
  });

  it('opens one stream per channel, forum and course a listing finds', async () => {
    const c = await company();
    await ingest(c, 'chat_channels', page([{ id: u('chat_A') }, { id: u('chat_B') }]));
    await ingest(c, 'forums', page([{ id: 'forum_1', experience: { id: u('exp_F1') } }]));
    await ingest(c, 'courses', page([{ id: u('cors_1') }, { id: 'not an id' }]));
    // Listed again: nothing doubles.
    await ingest(c, 'chat_channels', page([{ id: u('chat_A') }]));
    expect(
      (
        await rows<{ stream: string }>(
          'select stream from stayput.sync_state where company_id = $1 order by stream',
          [c],
        )
      ).map((r) => r.stream),
    ).toEqual([
      `forum_posts:${u('exp_F1')}`,
      `lesson_interactions:${u('cors_1')}`,
      `messages:${u('chat_A')}`,
      `messages:${u('chat_B')}`,
    ]);
  });

  it('follows a support channel through its openings and resolutions', async () => {
    const c = await company();
    await ingest(c, 'members', page([member(u('mber_M1'), u('user_U1'))]));
    const channel = (over: Record<string, unknown>) =>
      page([{ id: u('sc_1'), customer_user: { id: u('user_U1') }, ...over }]);
    const events = async () =>
      (
        await rows<{ type: string; external_id: string; at: string }>(
          `select type, external_id, to_char(occurred_at at time zone 'UTC', 'MM-DD HH24:MI') as at
             from stayput.activity_events where company_id = $1 order by occurred_at, type`,
          [c],
        )
      ).map((e) => `${e.at} ${e.type} ${e.external_id.replace(u('sc_1'), 'sc')}`);

    // Open, seen twice: one opening, dated by the last message seen.
    await ingest(c, 'support_channels', channel({ last_message_at: '2026-09-20T10:00:00Z' }));
    await ingest(c, 'support_channels', channel({ last_message_at: '2026-09-21T10:00:00Z' }));
    // Resolved, then written to again (reopened), then resolved again.
    await ingest(
      c,
      'support_channels',
      channel({ last_message_at: '2026-09-21T10:00:00Z', resolved_at: '2026-09-22T10:00:00Z' }),
    );
    await ingest(
      c,
      'support_channels',
      channel({ last_message_at: '2026-09-25T10:00:00Z', resolved_at: '2026-09-22T10:00:00Z' }),
    );
    await ingest(
      c,
      'support_channels',
      channel({ last_message_at: '2026-09-25T10:00:00Z', resolved_at: '2026-09-26T10:00:00Z' }),
    );
    expect(await events()).toEqual([
      '09-20 10:00 support_ticket_opened sc:first',
      '09-22 10:00 support_ticket_resolved sc:2026-09-22T10:00:00Z',
      '09-25 10:00 support_ticket_opened sc:2026-09-22T10:00:00.000000Z',
      '09-26 10:00 support_ticket_resolved sc:2026-09-26T10:00:00Z',
    ]);
  });

  it('rolls activity up per day and per hour, in the company time zone', async () => {
    const c = await company();
    await t.db.query(`update stayput.companies set timezone = 'Europe/Paris' where id = $1`, [c]);
    await ingest(c, 'members', page([member(u('mber_M1'), u('user_U1'))]));
    await ingest(
      c,
      'messages',
      page([
        // 22:30 UTC is 00:30 the next day in Paris (UTC+2 in September).
        message(u('msg_a'), u('user_U1'), '2026-09-29T22:30:00Z'),
        message(u('msg_b'), u('user_U1'), '2026-09-30T08:00:00Z'),
      ]),
      u('chat_C1'),
    );
    await t.db.query(
      'select stayput.refresh_activity_stats($1, $2::timestamptz, $3::timestamptz)',
      [c, '2026-09-01T00:00:00Z', NOW],
    );
    expect(
      await rows(
        `select day::text, messages from stayput.member_stats_daily
          where company_id = $1 order by day`,
        [c],
      ),
    ).toEqual([{ day: '2026-09-30', messages: 2 }]);
    const [hours] = await rows<{ hours: number[] }>(
      'select hours from stayput.activity_hours where company_id = $1',
      [c],
    );
    expect(hours?.hours[0]).toBe(1);
    expect(hours?.hours[10]).toBe(1);
    expect(hours?.hours.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('webhook deliveries', () => {
  async function deliver(id: string, type: string, companyId: string | null, data: unknown) {
    await t.db.query(
      `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
       values ($1, $2, $3, $4::text::jsonb, $5::timestamptz)`,
      [id, companyId, type, JSON.stringify({ type, data }), NOW],
    );
  }
  const process = async (id: string) =>
    (
      await rows<{ status: string }>(
        'select stayput.process_webhook_event($1, $2::timestamptz) as status',
        [id, NOW],
      )
    )[0]?.status;

  it('creates the company it names, then files each event where it belongs', async () => {
    companies += 1;
    const c = `biz_W${companies}`;
    await deliver(u('msg_w1'), 'member.created', c, member(u('mber_W1'), u('user_W1')));
    await deliver(u('msg_w2'), 'membership.activated', c, membership(u('mem_W1'), u('user_W1')));
    await deliver(
      u('msg_w3'),
      'payment.failed',
      c,
      payment(u('pay_W1'), {
        membership_id: u('mem_W1'),
        member_id: u('mber_W1'),
        substatus: 'failed',
      }),
    );
    await deliver(u('msg_w4'), 'refund.created', c, { id: 'ref_1' });
    expect([
      await process(u('msg_w1')),
      await process(u('msg_w2')),
      await process(u('msg_w3')),
      await process(u('msg_w4')),
    ]).toEqual(['processed', 'processed', 'processed', 'ignored']);
    expect(await rows('select status from stayput.companies where id = $1', [c])).toEqual([
      { status: 'active' },
    ]);
    expect(
      await rows(
        'select m.id, s.id as membership, p.status from stayput.members m ' +
          'join stayput.memberships s on s.member_id = m.id ' +
          'join stayput.payments p on p.membership_id = s.id where m.company_id = $1',
        [c],
      ),
    ).toEqual([{ id: u('mber_W1'), membership: u('mem_W1'), status: 'failed' }]);
    // Processed once: a second run changes nothing.
    expect(await process(u('msg_w2'))).toBe('processed');
    expect(
      await rows('select attempts from stayput.webhook_events where id = $1', [u('msg_w2')]),
    ).toEqual([{ attempts: 1 }]);
  });

  it('marks a delivery it cannot file as failed, to retry five times at most', async () => {
    const c = await company();
    // Unusable but harmless (no status): skipped. Unreadable (a date that is not one): failed.
    await deliver(
      u('msg_bad'),
      'membership.activated',
      c,
      membership(u('mem_B1'), u('user_B1'), { status: null }),
    );
    await deliver(
      u('msg_crash'),
      'payment.succeeded',
      c,
      payment(u('pay_B1'), { created_at: 'not a date' }),
    );
    expect(await process(u('msg_bad'))).toBe('processed');
    expect(await process(u('msg_crash'))).toBe('failed');
    expect(
      await rows<{ status: string; attempts: number; error: boolean }>(
        `select status, attempts, last_error is not null as error
           from stayput.webhook_events where id = $1`,
        [u('msg_crash')],
      ),
    ).toEqual([{ status: 'failed', attempts: 1, error: true }]);
    expect(
      (await rows<{ id: string }>('select stayput.pending_webhook_events(100) as id')).map(
        (r) => r.id,
      ),
    ).toContain(u('msg_crash'));
    await t.db.query('update stayput.webhook_events set attempts = 5 where id = $1', [
      u('msg_crash'),
    ]);
    expect(
      (await rows<{ id: string }>('select stayput.pending_webhook_events(100) as id')).map(
        (r) => r.id,
      ),
    ).not.toContain(u('msg_crash'));
  });
});
