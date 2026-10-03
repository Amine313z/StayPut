import { MEMBER_PAYMENTS_LIMIT } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMemberDetail } from '../src/members';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * A member's drawer (brief v4 §9.3), read under RLS as the team: the score over the last 30 days
 * of the community's calendar, the memberships with the one that counts first, the latest
 * payments, and the activity of each place, Discord and Telegram once connected.
 */

// 15 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-15T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();
const C = 'biz_Detail1';
const ANA = 'mber_Ana';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale, mode)
     values ($1, 'Le Club', 'Europe/Paris', 'fr', 'manual'), ('biz_Other1', 'Ailleurs', 'UTC', 'en', 'manual')`,
    [C],
  );
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_Boss', now())`,
    [C],
  );
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                  discord_user_id)
     values ($1, $2, 'user_Ana', 'Ana', $3::timestamptz, 'joined', '123456789'),
            ('mber_Far', 'biz_Other1', 'user_Far', 'Far', $3::timestamptz, 'joined', null)`,
    [ANA, C, days(-100)],
  );
  // An old membership, ended; the current one, renewing.
  await t.db.query(
    `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                      price, currency, billing_period_days, status,
                                      cancel_at_period_end, current_period_end, whop_created_at)
     values ('mem_AnaOld', $1, $2, 'user_Ana', 'prod_Club', 'plan_Month', 29, 'eur', 30,
             'expired', false, $3::timestamptz, $4::timestamptz),
            ('mem_AnaNow', $1, $2, 'user_Ana', 'prod_Club', 'plan_Vip', 99, 'eur', 30, 'active',
             false, $5::timestamptz, $6::timestamptz)`,
    [C, ANA, days(-40), days(-100), days(20), days(-40)],
  );
  // Fourteen payments, a week apart, the latest one failed.
  for (let i = 0; i < 14; i += 1) {
    await t.db.query(
      `insert into stayput.payments (id, company_id, membership_id, member_id, amount, currency,
                                     status, failure_reason, whop_created_at)
       values ($1, $2, 'mem_AnaNow', $3, 99, 'eur', $4, $5, $6::timestamptz)`,
      [
        `pay_Ana${i}`,
        C,
        ANA,
        i === 0 ? 'failed' : 'succeeded',
        i === 0 ? 'Card declined' : null,
        days(-1 - i * 7),
      ],
    );
  }
  // A score a day: one 40 days ago (out of the window), then the last days of the month.
  for (const [ago, score] of [
    [40, 20],
    [29, 30],
    [10, 55],
    [1, 70],
    [0, 82],
  ] as const) {
    await t.db.query(
      `insert into stayput.risk_scores (company_id, member_id, score, level, sub_scores,
                                        computed_at, day)
       values ($1, $2, $3, 'high', '{}', $4::timestamptz, $5::date)`,
      [C, ANA, score, days(-ago), days(-ago).slice(0, 10)],
    );
  }
  // On Whop: three messages and two reactions this month, one lesson long ago. On Discord: four
  // messages this month and one 40 days ago. On Telegram, not connected yet: one message.
  let count = 0;
  const event = (type: string, ago: number) => {
    count += 1;
    return t.db.query(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id)
       values ($1, $2, $3, $4::timestamptz, $5)`,
      [C, ANA, type, days(-ago), `${type}-${count}`],
    );
  };
  for (const ago of [1, 2, 3]) await event('message', ago);
  for (const ago of [2, 5]) await event('reaction', ago);
  await event('lesson_completed', 45);
  for (const ago of [0.2, 1, 4, 9, 40]) await event('discord_message', ago);
  await event('telegram_message', 2);
  await t.db.query(
    `insert into stayput.discord_guilds (guild_id, company_id, connected_at)
     values ('987654321', $1, $2::timestamptz)`,
    [C, days(-60)],
  );
});
afterAll(() => t.close());

describe('a member’s drawer', () => {
  it('gives the score of each of the last 30 days, oldest first', async () => {
    const detail = await readMemberDetail(t.db, 'user_Boss', C, ANA, NOW);
    expect(detail?.scores).toEqual([
      { day: days(-29).slice(0, 10), score: 30 },
      { day: days(-10).slice(0, 10), score: 55 },
      { day: days(-1).slice(0, 10), score: 70 },
      { day: days(0).slice(0, 10), score: 82 },
    ]);
  });

  it('puts the membership that counts first, and the latest payments first', async () => {
    const detail = await readMemberDetail(t.db, 'user_Boss', C, ANA, NOW);
    expect(detail?.memberships.map((m) => [m.id, m.status, m.price])).toEqual([
      ['mem_AnaNow', 'active', 99],
      ['mem_AnaOld', 'expired', 29],
    ]);
    expect(detail?.memberships[0]).toMatchObject({
      currency: 'eur',
      billingPeriodDays: 30,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: days(20),
      startedAt: days(-40),
    });
    expect(detail?.payments).toHaveLength(MEMBER_PAYMENTS_LIMIT);
    expect(detail?.payments[0]).toEqual({
      id: 'pay_Ana0',
      status: 'failed',
      amount: 99,
      currency: 'eur',
      at: days(-1),
      failureReason: 'Card declined',
    });
    expect(detail?.payments.map((p) => p.at)).toEqual(
      [...detail!.payments.map((p) => p.at)].sort().reverse(),
    );
  });

  it('counts what the member did over 30 days, place by place, each once connected', async () => {
    const before = await readMemberDetail(t.db, 'user_Boss', C, ANA, NOW);
    // Telegram is not connected yet: no line for it.
    expect(before?.platforms).toEqual([
      { platform: 'whop', events: 5, lastAt: days(-1), linked: true },
      { platform: 'discord', events: 4, lastAt: days(-0.2), linked: true },
    ]);
    await t.db.query(
      `insert into stayput.telegram_chats (chat_id, company_id, title, connected_at)
       values ('-1001', $1, 'VIP', $2::timestamptz)`,
      [C, days(-5)],
    );
    const after = await readMemberDetail(t.db, 'user_Boss', C, ANA, NOW);
    // Her Telegram account is not known: what she wrote there is counted, said as not tied.
    expect(after?.platforms.at(-1)).toEqual({
      platform: 'telegram',
      events: 1,
      lastAt: days(-2),
      linked: false,
    });
  });

  it('shows nothing of another community’s member, nor to someone outside the team', async () => {
    expect(await readMemberDetail(t.db, 'user_Boss', C, 'mber_Far', NOW)).toBeNull();
    expect(await readMemberDetail(t.db, 'user_Boss', C, 'mber_Nobody', NOW)).toBeNull();
    expect(await readMemberDetail(t.db, 'user_Stranger', C, ANA, NOW)).toBeNull();
  });
});
