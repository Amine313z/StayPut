import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { member, membership, message, page, payment } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0005, the parts the synchronization leans on: activity and payments that arrive
 * before their member or membership, the passes of sync_page, the company lease, and the
 * statistics recomputed where activity changed.
 */

const NOW = '2026-10-01T12:00:00Z';
let t: TestDb;
let companies = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function company(): Promise<string> {
  companies += 1;
  const id = `biz_S${companies}`;
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [id, NOW]);
  return id;
}

const u = (base: string) => `${base}Z${companies}`;
const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);

async function ingest(companyId: string, kind: string, body: unknown, scope: string | null = null) {
  await t.db.query('select stayput.ingest_page($1, $2, $3, $4::text::jsonb)', [
    companyId,
    kind,
    scope,
    JSON.stringify(body),
  ]);
}

describe('what arrives before its member or membership', () => {
  it('keeps the activity of a user not known yet, and files it when the member arrives', async () => {
    const c = await company();
    await ingest(c, 'messages', page([message(u('msg_1'), u('user_N'), '2026-09-30T09:00:00Z')]));
    expect(await rows('select 1 from stayput.activity_events where company_id = $1', [c])).toEqual(
      [],
    );
    expect(
      await rows<{ n: number }>(
        'select count(*)::int as n from stayput.pending_activity where company_id = $1',
        [c],
      ),
    ).toEqual([{ n: 1 }]);
    await t.db.query('update stayput.company_sync set stats_dirty_since = null');

    await ingest(c, 'members', page([member(u('mber_N'), u('user_N'))]));
    expect(
      await rows(
        'select member_id, type, external_id from stayput.activity_events where company_id = $1',
        [c],
      ),
    ).toEqual([{ member_id: u('mber_N'), type: 'message', external_id: u('msg_1') }]);
    expect(await rows('select 1 from stayput.pending_activity where company_id = $1', [c])).toEqual(
      [],
    );
    expect(
      await rows<{ since: Date }>(
        'select stats_dirty_since as since from stayput.company_sync where company_id = $1',
        [c],
      ),
    ).toEqual([{ since: new Date('2026-09-30T09:00:00Z') }]);
  });

  it('forgets after 7 days the activity of users who never became members', async () => {
    const c = await company();
    await t.db.query(
      `insert into stayput.pending_activity (company_id, user_id, type, occurred_at, external_id,
                                             received_at)
       values ($1, $2, 'message', $3::timestamptz, 'm_old', $3::timestamptz),
              ($1, $2, 'message', $4::timestamptz, 'm_new', $4::timestamptz)`,
      [c, u('user_X'), '2026-09-20T00:00:00Z', '2026-09-30T00:00:00Z'],
    );
    await t.db.query('select stayput.purge_pending_activity($1::timestamptz)', [NOW]);
    expect(
      await rows('select external_id from stayput.pending_activity where company_id = $1', [c]),
    ).toEqual([{ external_id: 'm_new' }]);
  });

  it('links a payment to the membership and member that arrive after it', async () => {
    const c = await company();
    await ingest(
      c,
      'payments',
      page([payment(u('pay_1'), { membership_id: u('mem_1'), member_id: u('mber_1') })]),
    );
    expect(
      await rows('select membership_id, member_id from stayput.payments where company_id = $1', [
        c,
      ]),
    ).toEqual([{ membership_id: null, member_id: null }]);

    await ingest(c, 'memberships', page([membership(u('mem_1'), u('user_1'))]));
    expect(
      await rows('select membership_id, member_id from stayput.payments where company_id = $1', [
        c,
      ]),
    ).toEqual([{ membership_id: u('mem_1'), member_id: null }]);

    await ingest(c, 'members', page([member(u('mber_1'), u('user_1'))]));
    expect(
      await rows('select membership_id, member_id from stayput.payments where company_id = $1', [
        c,
      ]),
    ).toEqual([{ membership_id: u('mem_1'), member_id: u('mber_1') }]);
  });
});

describe('sync_page', () => {
  /** A page of messages at these hours of 2026-09-30, newest first unless given otherwise. */
  const messages = (hours: number[], cursor: string | null) =>
    page(
      hours.map((h, i) =>
        message(u(`msg_${cursor ?? 'end'}_${i}`), u('user_A'), `2026-09-30T${pad(h)}:00:00Z`),
      ),
      cursor,
      cursor !== null,
    );
  const pad = (n: number) => String(n).padStart(2, '0');

  async function syncPage(
    c: string,
    body: unknown,
    pass: { start?: boolean; until?: string | null; complete?: boolean; stop?: string } = {},
    now = NOW,
  ) {
    const [row] = await rows<{ next: string | null }>(
      `select stayput.sync_page($1, 'messages:chat_1', 'messages', 'chat_1', $2::text::jsonb,
                                $3::timestamptz, $4, $5::timestamptz, $6, $7) as next`,
      [
        c,
        JSON.stringify(body),
        now,
        pass.start ?? false,
        pass.until ?? null,
        pass.complete ?? false,
        pass.stop ?? 'oldest',
      ],
    );
    return row?.next;
  }

  const state = async (c: string) =>
    (
      await rows<Record<string, unknown>>(
        `select cursor, backfill_done, high_water, pass_until, pass_newest,
                last_pass_at is not null as passed,
                last_complete_pass_at is not null as completed
           from stayput.sync_state where company_id = $1 and stream = 'messages:chat_1'`,
        [c],
      )
    )[0];

  it('reads back to the given time, over several pages, then records the newest item', async () => {
    const c = await company();
    const until = '2026-09-30T05:30:00Z';
    expect(
      await syncPage(c, messages([23, 22, 21], 'c1'), { start: true, until, complete: true }),
    ).toBe('c1');
    expect(await state(c)).toMatchObject({
      cursor: 'c1',
      backfill_done: false,
      pass_until: new Date(until),
      pass_newest: new Date('2026-09-30T23:00:00Z'),
    });
    // The second page reaches 05:00, older than `until`: the pass is over, even with more pages.
    expect(await syncPage(c, messages([10, 5], 'c2'))).toBeNull();
    expect(await state(c)).toMatchObject({
      cursor: null,
      backfill_done: true,
      high_water: new Date('2026-09-30T23:00:00Z'),
      pass_until: null,
      passed: true,
      completed: true,
    });
  });

  it('never stops early on a page sorted oldest first', async () => {
    const c = await company();
    const until = '2026-09-30T12:00:00Z';
    expect(await syncPage(c, messages([1, 2, 3], 'c1'), { start: true, until })).toBe('c1');
    expect(await syncPage(c, messages([13, 14], null))).toBeNull();
    expect(await state(c)).toMatchObject({
      high_water: new Date('2026-09-30T14:00:00Z'),
      completed: false,
    });
  });

  it('ignores pinned items when it looks at how far a page goes', async () => {
    const c = await company();
    const pinned = message(u('msg_pin'), u('user_A'), '2026-01-01T00:00:00Z', { is_pinned: true });
    const body = messages([20, 19], 'c1');
    body.data.unshift(pinned);
    expect(
      await syncPage(c, body, { start: true, until: '2026-09-30T18:00:00Z', stop: 'newest' }),
    ).toBe('c1');
  });

  it('records why a page failed, and what that means for the pass', async () => {
    const c = await company();
    await syncPage(c, messages([23], 'c1'), { start: true });
    const error = async (status: number, stream = 'messages:chat_1') =>
      t.db.query('select stayput.sync_error($1, $2, $3::timestamptz, $4, $5)', [
        c,
        stream,
        NOW,
        status,
        'Whop said no',
      ]);

    // Whop unavailable: the cursor stays, the next run retries the same page.
    await error(503);
    expect(
      await rows(
        `select cursor, last_error from stayput.sync_state
          where company_id = $1 and stream = 'messages:chat_1'`,
        [c],
      ),
    ).toEqual([{ cursor: 'c1', last_error: '503 Whop said no' }]);

    // A permission missing: the pass ends, the stream waits for its next one.
    await error(403, 'payments');
    expect(
      await rows(
        `select cursor, last_error, last_pass_at is not null as passed, backfill_done
           from stayput.sync_state where company_id = $1 and stream = 'payments'`,
        [c],
      ),
    ).toEqual([
      { cursor: null, last_error: '403 Whop said no', passed: true, backfill_done: false },
    ]);

    // The channel is gone: so is its stream.
    await error(404);
    expect(
      await rows(
        `select 1 from stayput.sync_state where company_id = $1 and stream = 'messages:chat_1'`,
        [c],
      ),
    ).toEqual([]);
  });
});

describe('the company lease', () => {
  const claim = async (c: string, now: string, minInterval = 0) =>
    (
      await rows<{ claimed: boolean }>(
        'select stayput.claim_sync($1, $2::timestamptz, 300, $3) as claimed',
        [c, now, minInterval],
      )
    )[0]?.claimed;
  const release = (c: string, now: string) =>
    t.db.query('select stayput.release_sync($1, $2::timestamptz)', [c, now]);
  const due = async (now: string) =>
    (
      await rows<{ id: string }>(
        'select stayput.companies_to_sync($1::timestamptz, 3300, 100) as id',
        [now],
      )
    ).map((r) => r.id);

  it('lets one run at a time read a company, and frees it after the lease', async () => {
    const c = await company();
    expect(await claim(c, '2026-10-01T12:00:00Z')).toBe(true);
    expect(await claim(c, '2026-10-01T12:01:00Z')).toBe(false);
    expect(await due('2026-10-01T12:01:00Z')).not.toContain(c);
    // The run died: 5 minutes later another may go.
    expect(await claim(c, '2026-10-01T12:05:00Z')).toBe(true);
    await release(c, '2026-10-01T12:06:00Z');
    expect(await claim(c, '2026-10-01T12:06:30Z', 60)).toBe(false);
    expect(await claim(c, '2026-10-01T12:07:00Z', 60)).toBe(true);
  });

  it('puts first the companies that waited longest, and skips demos and uninstalled ones', async () => {
    const recent = await company();
    const old = await company();
    const demo = await company();
    const gone = await company();
    await t.db.query(`update stayput.companies set is_demo = true where id = $1`, [demo]);
    await t.db.query(
      `update stayput.companies set status = 'uninstalled', uninstalled_at = $2::timestamptz
        where id = $1`,
      [gone, NOW],
    );
    for (const [c, at] of [
      [recent, '2026-10-01T11:50:00Z'],
      [old, '2026-10-01T10:00:00Z'],
    ] as const) {
      await claim(c, at);
      await release(c, at);
    }
    const list = await due(NOW);
    expect(list).not.toContain(recent);
    expect(list).not.toContain(demo);
    expect(list).not.toContain(gone);
    expect(list.indexOf(old)).toBeGreaterThanOrEqual(0);
    expect(await claim(demo, NOW)).toBe(false);

    // A pass under way makes the company due at once.
    await t.db.query(
      `insert into stayput.sync_state (company_id, stream, cursor, last_run_at)
       values ($1, 'members', 'c1', $2::timestamptz)`,
      [recent, NOW],
    );
    expect(await due(NOW)).toContain(recent);
  });
});

describe('statistics', () => {
  it('recomputes only the companies whose activity changed, from the oldest change on', async () => {
    const a = await company();
    const b = await company();
    // Whop ids have no "_" after their prefix: `biz_S7` gives `mber_MS7`.
    const tail = (c: string) => c.slice('biz_'.length);
    for (const c of [a, b]) {
      await ingest(c, 'members', page([member(`mber_M${tail(c)}`, `user_U${tail(c)}`)]));
      await ingest(
        c,
        'messages',
        page([message(`msg_${tail(c)}`, `user_U${tail(c)}`, '2026-09-30T10:00:00Z')]),
        'chat_1',
      );
    }
    await t.db.query('select stayput.refresh_stats($1::timestamptz, $2)', [NOW, a]);
    const stats = async (c: string) =>
      rows('select day::text, messages from stayput.member_stats_daily where company_id = $1', [c]);
    expect(await stats(a)).toEqual([{ day: '2026-09-30', messages: 1 }]);
    expect(await stats(b)).toEqual([]);

    await t.db.query('select stayput.refresh_stats($1::timestamptz)', [NOW]);
    expect(await stats(b)).toEqual([{ day: '2026-09-30', messages: 1 }]);
    expect(
      await rows(
        `select company_id from stayput.company_sync
          where company_id in ($1, $2) and stats_dirty_since is not null`,
        [a, b],
      ),
    ).toEqual([]);

    // Reading the same messages again changes nothing, so nothing is marked.
    await ingest(
      a,
      'messages',
      page([message(`msg_${tail(a)}`, `user_U${tail(a)}`, '2026-09-30T10:00:00Z')]),
      'chat_1',
    );
    expect(
      await rows('select stats_dirty_since from stayput.company_sync where company_id = $1', [a]),
    ).toEqual([{ stats_dirty_since: null }]);
  });
});

describe('webhook replay', () => {
  it('files the deliveries left behind, not the ones just received', async () => {
    const c = await company();
    const deliver = (id: string, receivedAt: string) =>
      t.db.query(
        `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
         values ($1, $2, 'member.created', $3::text::jsonb, $4::timestamptz)`,
        [id, c, JSON.stringify({ data: member(`mber_${id}`, `user_${id}`) }), receivedAt],
      );
    await deliver(u('old'), '2026-10-01T11:00:00Z');
    await deliver(u('fresh'), '2026-10-01T11:59:30Z');
    const [row] = await rows<{ counts: Record<string, number> }>(
      'select stayput.process_pending_webhooks(100, $1::timestamptz) as counts',
      [NOW],
    );
    expect(row?.counts).toMatchObject({ processed: 1 });
    expect(
      await rows(
        `select id, status from stayput.webhook_events where company_id = $1 order by id`,
        [c],
      ),
    ).toEqual([
      { id: u('fresh'), status: 'received' },
      { id: u('old'), status: 'processed' },
    ]);
  });
});
