import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBER_TABLES, exportMemberData, forgetMember } from '../src/data';
import { member, membership, message, payment } from './fixtures/whop';
import { MIGRATIONS_DIR, createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0040 (SPEC Phase 8.2 and 8.3): Whop's deliveries without their personal fields and
 * not kept, one member's data exported or deleted for good, a community StayPut was uninstalled
 * from deleted 30 days later.
 */

const NOW = new Date('2026-10-05T09:00:00Z');
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const rows = <T>(text: string, params: unknown[] = []) => t.db.query<T>(text, params);

async function deliver(id: string, type: string, company: string, data: unknown, days = 0) {
  await rows(
    `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
     values ($1, $2, $3, $4::text::jsonb, $5::timestamptz)`,
    [id, company, type, JSON.stringify({ type, data }), at(days)],
  );
}

async function community(id: string) {
  await rows(`insert into stayput.companies (id, name) values ($1, 'Club')`, [id]);
  await rows(`insert into stayput.company_settings (company_id) values ($1)`, [id]);
  await rows(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Owner', now())`,
    [id],
  );
}

const PERSONAL = /@mail\.test|\+336|never stored/;

describe('Whop’s deliveries', () => {
  it('keep no e-mail, phone number or message text, and are still filed', async () => {
    await community('biz_Min1');
    await deliver('msg_Min1', 'member.created', 'biz_Min1', member('mber_Min1', 'user_Min1'));
    await deliver(
      'msg_Min2',
      'payment.succeeded',
      'biz_Min1',
      payment('pay_Min1', { member_id: 'mber_Min1' }),
    );
    await deliver(
      'msg_Min3',
      'chat.message.created',
      'biz_Min1',
      message('chat_Min1', 'user_Min1', at(0)),
    );
    const stored = await rows<{ payload: unknown }>(
      `select payload from stayput.webhook_events where company_id = 'biz_Min1'`,
    );
    expect(stored).toHaveLength(3);
    for (const { payload } of stored) expect(JSON.stringify(payload)).not.toMatch(PERSONAL);
    // What StayPut reads is still there: the member's name, the payment, the message's author.
    for (const id of ['msg_Min1', 'msg_Min2', 'msg_Min3']) {
      const [row] = await rows<{ status: string }>(
        'select stayput.process_webhook_event($1, $2::timestamptz) as status',
        [id, NOW.toISOString()],
      );
      expect(row?.status, id).toBe('processed');
    }
    expect(
      await rows(`select display_name, username from stayput.members where id = 'mber_Min1'`),
    ).toEqual([{ display_name: 'Name user_Min1', username: 'Min1' }]);
    expect(await rows(`select amount from stayput.payments where id = 'pay_Min1'`)).toEqual([
      { amount: '49.00' },
    ]);
  });

  it('go after 7 days once filed, after 30 at the most', async () => {
    await community('biz_Min2');
    await deliver('msg_Old1', 'member.created', 'biz_Min2', {}, -8);
    await deliver('msg_Old2', 'member.created', 'biz_Min2', {}, -6);
    await deliver('msg_Old3', 'member.created', 'biz_Min2', {}, -31);
    await deliver('msg_Old4', 'member.created', 'biz_Min2', {}, -20);
    await rows(
      `update stayput.webhook_events set status = 'processed'
        where id in ('msg_Old1', 'msg_Old2')`,
    );
    await rows(`update stayput.webhook_events set status = 'failed', attempts = 5
                 where id in ('msg_Old3', 'msg_Old4')`);
    const [purged] = await rows<{ count: number }>(
      'select stayput.purge_webhook_events($1::timestamptz) as count',
      [NOW.toISOString()],
    );
    expect(purged?.count).toBe(2);
    expect(
      (
        await rows<{ id: string }>(
          `select id from stayput.webhook_events where company_id = 'biz_Min2' order by id`,
        )
      ).map((r) => r.id),
    ).toEqual(['msg_Old2', 'msg_Old4']);
  });

  it('kept before 0040 lose their personal fields with it', async () => {
    const before = await createTestDb({ until: '0040' });
    try {
      await before.db.query(`insert into stayput.companies (id, name) values ('biz_Old', 'Club')`);
      await before.db.query(
        `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
         values ('msg_Before', 'biz_Old', 'member.created', $1::text::jsonb, now())`,
        [JSON.stringify({ data: member('mber_Before', 'user_Before') })],
      );
      await before.exec(readFileSync(path.join(MIGRATIONS_DIR, '0040_minimal_data.sql'), 'utf8'));
      const [row] = await before.db.query<{ payload: unknown }>(
        `select payload from stayput.webhook_events where id = 'msg_Before'`,
      );
      expect(JSON.stringify(row?.payload)).not.toMatch(PERSONAL);
      expect(JSON.stringify(row?.payload)).toContain('user_Before');
    } finally {
      await before.close();
    }
  });
});

describe('one member’s data', () => {
  const C = 'biz_Forget';

  beforeAll(async () => {
    await community(C);
    for (const [m, u] of [
      ['mber_Gone', 'user_Gone'],
      ['mber_Stay', 'user_Stay'],
    ] as const) {
      await rows(
        `insert into stayput.members (id, company_id, user_id, display_name, status,
                                      discord_user_id, telegram_user_id)
         values ($1, $2, $3, 'Someone', 'joined', $4, $5)`,
        [m, C, u, m === 'mber_Gone' ? '111111' : '222222', m === 'mber_Gone' ? '333' : '444'],
      );
      await rows(
        `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                          status, whop_created_at)
         values ($1, $2, $3, $4, 'prod_P1', 'plan_V1', 'active', now())`,
        [`mem_${m.slice(5)}`, C, m, u],
      );
      await rows(
        `insert into stayput.payments (id, company_id, member_id, membership_id, amount, currency,
                                       status, paid_at, whop_created_at)
         values ($1, $2, $3, $4, 49, 'usd', 'paid', now(), now())`,
        [`pay_${m.slice(5)}`, C, m, `mem_${m.slice(5)}`],
      );
      await rows(
        `insert into stayput.activity_events (company_id, member_id, type, occurred_at,
                                              external_id)
         values ($1, $2, 'message', now(), $3)`,
        [C, m, `ext_${m}`],
      );
      for (const [platform, account] of [
        ['discord', m === 'mber_Gone' ? '111111' : '222222'],
        ['telegram', m === 'mber_Gone' ? '333' : '444'],
      ] as const) {
        await rows(
          `insert into stayput.platform_accounts (company_id, platform, account_id, display_name,
                                                  first_seen_at, last_seen_at)
           values ($1, $2, $3, 'Someone', now(), now())`,
          [C, platform, account],
        );
      }
    }
    // Read before the member was: a payment under their Whop member id only.
    await rows(
      `insert into stayput.payments (id, company_id, whop_member_id, amount, currency, status,
                                     whop_created_at)
       values ('pay_Early', $1, 'mber_Gone', 10, 'usd', 'paid', now())`,
      [C],
    );
  });

  it('are exported whole, read as the community’s team', async () => {
    const data = await exportMemberData(t.db, 'user_Owner', C, 'mber_Gone', NOW);
    expect(data?.member).toMatchObject({ id: 'mber_Gone', user_id: 'user_Gone' });
    expect(Object.keys(data!.tables)).toEqual(Object.keys(MEMBER_TABLES));
    expect(data!.tables.payments!.map((p) => p.id).sort()).toEqual(['pay_Early', 'pay_Gone']);
    expect(data!.tables.platform_accounts).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain('Stay');
    expect(await exportMemberData(t.db, 'user_Stranger', C, 'mber_Gone', NOW)).toBeNull();
  });

  it('covers every table that points at a member', async () => {
    const pointing = await rows<{ name: string }>(
      `select distinct c.conrelid::regclass::text as name from pg_constraint c
        where c.contype = 'f' and c.confrelid = 'stayput.members'::regclass order by 1`,
    );
    expect(pointing.length).toBeGreaterThan(15);
    for (const { name } of pointing) {
      expect(Object.keys(MEMBER_TABLES), name).toContain(name.replace('stayput.', ''));
    }
  });

  it('are deleted for good: nothing left, and never taken in again', async () => {
    expect(await forgetMember(t.db, C, 'mber_Gone', NOW)).toBe(true);
    const left = await rows<{ n: number }>(
      `select (select count(*) from stayput.members where company_id = $1 and id = 'mber_Gone')
            + (select count(*) from stayput.memberships where company_id = $1 and user_id = 'user_Gone')
            + (select count(*) from stayput.payments where company_id = $1
                and (member_id = 'mber_Gone' or whop_member_id = 'mber_Gone'))
            + (select count(*) from stayput.activity_events where company_id = $1
                and member_id = 'mber_Gone')
            + (select count(*) from stayput.platform_accounts where company_id = $1
                and account_id in ('111111', '333')) as n`,
      [C],
    );
    expect(Number(left[0]?.n)).toBe(0);
    // The other member keeps everything.
    const stay = await exportMemberData(t.db, 'user_Owner', C, 'mber_Stay', NOW);
    expect(stay?.tables.payments).toHaveLength(1);
    expect(stay?.tables.platform_accounts).toHaveLength(2);

    // Whop sends them again, Discord and Telegram see them again: nothing comes in.
    await deliver('msg_Back1', 'member.updated', C, member('mber_Gone', 'user_Gone'));
    await deliver('msg_Back2', 'membership.activated', C, membership('mem_Back', 'user_Gone'));
    await deliver(
      'msg_Back3',
      'payment.succeeded',
      C,
      payment('pay_Back', { member_id: 'mber_Gone', membership_id: 'mem_Back' }),
    );
    await deliver('msg_Back4', 'chat.message.created', C, message('chat_Back', 'user_Gone', at(0)));
    for (const id of ['msg_Back1', 'msg_Back2', 'msg_Back3', 'msg_Back4']) {
      await rows('select stayput.process_webhook_event($1, $2::timestamptz)', [
        id,
        NOW.toISOString(),
      ]);
    }
    await rows(
      `insert into stayput.platform_accounts (company_id, platform, account_id, first_seen_at,
                                              last_seen_at)
       values ($1, 'discord', '111111', now(), now()), ($1, 'telegram', '333', now(), now())`,
      [C],
    );
    const back = await rows<{ n: number }>(
      `select (select count(*) from stayput.members where company_id = $1 and user_id = 'user_Gone')
            + (select count(*) from stayput.memberships where company_id = $1 and user_id = 'user_Gone')
            + (select count(*) from stayput.payments where company_id = $1 and id = 'pay_Back')
            + (select count(*) from stayput.pending_activity where company_id = $1
                and user_id = 'user_Gone')
            + (select count(*) from stayput.platform_accounts where company_id = $1
                and account_id in ('111111', '333')) as n`,
      [C],
    );
    expect(Number(back[0]?.n)).toBe(0);
    // Their fingerprints only: no id of theirs is kept.
    const erased = await rows<{ fingerprint: string }>(
      'select fingerprint from stayput.erased_people where company_id = $1',
      [C],
    );
    expect(erased).toHaveLength(4);
    expect(JSON.stringify(erased)).not.toMatch(/Gone|111111|333/);
    expect(await forgetMember(t.db, C, 'mber_Gone', NOW)).toBe(false);
  });
});

describe('a community StayPut was uninstalled from', () => {
  const C = 'biz_Leaving';

  beforeAll(async () => {
    await community(C);
    await rows(
      `insert into stayput.sync_state (company_id, stream, last_error, last_error_at)
       values ($1, 'members', '403 forbidden: missing permission', now())`,
      [C],
    );
  });

  const suspects = async (when: string) =>
    (
      await rows<{ id: string }>(
        'select id from stayput.access_suspects($1::timestamptz, 10) as id',
        [when],
      )
    ).map((r) => r.id);
  const record = async (granted: boolean, when: string) =>
    (
      await rows<{ status: string }>(
        'select stayput.record_access($1, $2, $3::timestamptz) as status',
        [C, granted, when],
      )
    )[0]?.status;

  it('is uninstalled once Whop has refused it everything for a day', async () => {
    expect(await suspects(at(0))).toContain(C);
    expect(await record(false, at(0))).toBe('active');
    // Asked again 6 hours later at the earliest.
    expect(await suspects(at(0.1))).not.toContain(C);
    expect(await suspects(at(0.3))).toContain(C);
    // Granted again in between: the refusal was something else.
    expect(await record(true, at(0.3))).toBe('active');
    expect(await record(false, at(0.6))).toBe('active');
    expect(await record(false, at(1.5))).toBe('active');
    expect(await record(false, at(1.7))).toBe('uninstalled');
    expect(await rows(`select uninstalled_at from stayput.companies where id = $1`, [C])).toEqual([
      { uninstalled_at: new Date(at(0.6)) },
    ]);
  });

  it('is deleted 30 days after it lost access, and never the demo', async () => {
    await rows(
      `insert into stayput.companies (id, name, is_demo, status, uninstalled_at)
       values ('biz_DemoGone', 'Demo', true, 'uninstalled', $1::timestamptz)`,
      [at(-60)],
    );
    const due = async (when: string) =>
      (
        await rows<{ id: string }>(
          'select id from stayput.delete_uninstalled_companies($1::timestamptz) as id',
          [when],
        )
      ).map((r) => r.id);
    expect(await due(at(30))).toEqual([]);
    expect(await due(at(31))).toEqual([C]);
    expect(await rows('select id from stayput.companies where id = $1', [C])).toEqual([]);
    expect(await rows(`select id from stayput.companies where id = 'biz_DemoGone'`)).toHaveLength(
      1,
    );
  });
});
