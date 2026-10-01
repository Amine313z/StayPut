import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/db';
import { member, membership, page } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0018, the Alumni offer (SPEC 5.9): the offer created step by step, who enters and
 * leaves it as their memberships of its product come and go, who comes back to a paid offer (and
 * perhaps leaves it again), and the members in the Alumni kept out of the risk score.
 */

const NOW = '2026-10-01T12:00:00Z';
let t: TestDb;
let companies = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);

/** A community whose members Ana and Bruno paid, Ana's membership over since 20 September. */
async function community() {
  companies += 1;
  const c = `biz_Alu${companies}`;
  const u = (name: string) => `${name}Alu${companies}`;
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [c, NOW]);
  await rows('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
    c,
    'members',
    JSON.stringify(
      page([member(u('mber_ana'), u('user_ana')), member(u('mber_bru'), u('user_bru'))]),
    ),
  ]);
  const memberships = (items: unknown[]) =>
    rows('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      c,
      'memberships',
      JSON.stringify(page(items)),
    ]);
  await memberships([
    membership(u('mem_anapaid'), u('user_ana'), {
      account: { id: c },
      status: 'canceled',
      canceled_at: '2026-09-01T10:00:00.000Z',
      current_period_end: '2026-09-20T10:00:00.000Z',
    }),
    membership(u('mem_brupaid'), u('user_bru'), {
      account: { id: c },
      status: 'expired',
      current_period_end: '2026-09-25T10:00:00.000Z',
    }),
  ]);
  return { c, u, memberships };
}

const alumni = (c: string) =>
  rows<{ member_id: string; status: string; departed_at: Date; entry_mode: string }>(
    `select member_id, status, departed_at, entry_mode from stayput.alumni_members
      where company_id = $1 order by member_id`,
    [c],
  );

describe('the Alumni offer (0018)', () => {
  it('is created step by step, the ids Whop gave kept when a step is tried again', async () => {
    const { c } = await community();
    const save = (step: Record<string, unknown>) =>
      rows<{ product_id: string | null; plan_id: string | null; completed_at: Date | null }>(
        `select product_id, plan_id, completed_at
           from stayput.save_alumni_offer($1, 'Alumni', 'user_owner', $2::text::jsonb,
                                          $3::timestamptz)`,
        [c, JSON.stringify(step), NOW],
      );
    expect(await save({ productId: 'prod_Alu1' })).toEqual([
      { product_id: 'prod_Alu1', plan_id: null, completed_at: null },
    ]);
    // A retry that went through the first step again: the first product stays.
    await save({
      productId: 'prod_Other',
      planId: 'plan_Alu1',
      url: 'https://whop.com/checkout/plan_Alu1',
    });
    expect(await save({ experienceId: 'exp_Alu1', completed: true })).toEqual([
      { product_id: 'prod_Alu1', plan_id: 'plan_Alu1', completed_at: new Date(NOW) },
    ]);
  });

  it('follows who enters, leaves and comes back, and keeps them out of the risk score', async () => {
    const { c, u, memberships } = await community();
    await rows(
      `select stayput.save_alumni_offer($1, 'Alumni', null, $2::text::jsonb, $3::timestamptz)`,
      [
        c,
        JSON.stringify({
          productId: 'prod_AluX',
          planId: 'plan_AluX',
          url: 'https://whop.com/checkout/plan_AluX',
          experienceId: 'exp_AluX',
          completed: true,
        }),
        NOW,
      ],
    );
    // Ana was scored before she left.
    await rows(
      `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                         level_since, computed_at)
       values ($1, $2, 80, 'high', '{}', $3::timestamptz, $3::timestamptz)`,
      [c, u('mber_ana'), NOW],
    );
    const scored = async () =>
      (
        await rows<{ data: { members: unknown[][] } }>(
          'select stayput.risk_features($1, $2::timestamptz, 100) as data',
          [c, '2026-10-01T13:00:00Z'],
        )
      )[0]?.data.members.map((m) => m[0]);

    // Ana takes the free Alumni with its link.
    const alumniOf = (who: string, over: Record<string, unknown> = {}) =>
      membership(u(`mem_${who}alu`), u(`user_${who}`), {
        account: { id: c },
        product_id: 'prod_AluX',
        plan_id: 'plan_AluX',
        billing_period_days: null,
        status: 'completed',
        created_at: '2026-09-28T10:00:00.000Z',
        current_period_end: null,
        ...over,
      });
    await memberships([alumniOf('ana')]);
    expect(await alumni(c)).toEqual([
      {
        member_id: u('mber_ana'),
        status: 'entered',
        departed_at: new Date('2026-09-20T10:00:00.000Z'),
        entry_mode: 'link',
      },
    ]);
    // No longer paying: her score is gone, and she is no longer scored.
    expect(
      await rows('select 1 from stayput.member_risk where company_id = $1 and member_id = $2', [
        c,
        u('mber_ana'),
      ]),
    ).toEqual([]);
    expect(await scored()).not.toContain(u('mber_ana'));
    expect(await scored()).toContain(u('mber_bru'));

    // Bruno too, then he comes back to the paid offer.
    await memberships([alumniOf('bru')]);
    await memberships([
      membership(u('mem_bruback'), u('user_bru'), {
        account: { id: c },
        created_at: '2026-09-30T10:00:00.000Z',
        current_period_end: '2026-10-30T10:00:00.000Z',
      }),
    ]);
    // Ana leaves the Alumni: StayPut never calls her back.
    await memberships([
      alumniOf('ana', { status: 'canceled', canceled_at: '2026-09-30T08:00:00.000Z' }),
    ]);
    expect((await alumni(c)).map((a) => [a.member_id, a.status])).toEqual([
      [u('mber_ana'), 'left'],
      [u('mber_bru'), 'returned'],
    ]);
    // Back in a paid offer, Bruno is scored again.
    expect(await scored()).toContain(u('mber_bru'));

    await rows(
      `insert into stayput.company_admins (company_id, user_id, verified_at) values ($1, $2, now())`,
      [c, 'user_owner'],
    );
    const view = async (user: string) =>
      (
        await withUser(t.db, user, (tx) =>
          tx.query<{ view: Record<string, unknown> | null }>(
            'select stayput.alumni_view($1) as view',
            [c],
          ),
        )
      )[0]?.view;
    expect(await view('user_owner')).toMatchObject({
      offer: { name: 'Alumni', url: 'https://whop.com/checkout/plan_AluX' },
      entered: 0,
      left: 1,
      returned: 1,
    });
    expect(await view('user_nobody')).toBeNull();

    // Bruno stops paying again while his Alumni access runs: among the alumni again, counted from
    // this second departure, and no longer scored.
    await rows(
      `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                         level_since, computed_at)
       values ($1, $2, 75, 'high', '{}', $3::timestamptz, $3::timestamptz)`,
      [c, u('mber_bru'), NOW],
    );
    await memberships([
      membership(u('mem_bruback'), u('user_bru'), {
        account: { id: c },
        status: 'expired',
        created_at: '2026-09-30T10:00:00.000Z',
        current_period_end: '2026-09-30T20:00:00.000Z',
      }),
    ]);
    expect(await alumni(c)).toContainEqual({
      member_id: u('mber_bru'),
      status: 'entered',
      departed_at: new Date('2026-09-30T20:00:00.000Z'),
      entry_mode: 'link',
    });
    expect(
      await rows('select 1 from stayput.member_risk where company_id = $1 and member_id = $2', [
        c,
        u('mber_bru'),
      ]),
    ).toEqual([]);
    expect(await scored()).not.toContain(u('mber_bru'));
    expect(await view('user_owner')).toMatchObject({ entered: 1, left: 1, returned: 0 });
  });

  it('waits until a paying member who took the link no longer pays', async () => {
    const { c, u, memberships } = await community();
    await rows(
      `select stayput.save_alumni_offer($1, 'Alumni', null, $2::text::jsonb, $3::timestamptz)`,
      [
        c,
        JSON.stringify({
          productId: 'prod_AluY',
          planId: 'plan_AluY',
          url: 'https://whop.com/checkout/plan_AluY',
          experienceId: 'exp_AluY',
          completed: true,
        }),
        NOW,
      ],
    );
    const paid = (over: Record<string, unknown> = {}) =>
      membership(u('mem_brunew'), u('user_bru'), {
        account: { id: c },
        created_at: '2026-09-29T10:00:00.000Z',
        current_period_end: '2026-10-29T10:00:00.000Z',
        ...over,
      });
    await memberships([paid()]);
    // Bruno, still paying, takes the Alumni link: not an alumnus.
    await memberships([
      membership(u('mem_brualu'), u('user_bru'), {
        account: { id: c },
        product_id: 'prod_AluY',
        plan_id: 'plan_AluY',
        billing_period_days: null,
        status: 'completed',
        created_at: '2026-09-30T10:00:00.000Z',
        current_period_end: null,
      }),
    ]);
    expect(await alumni(c)).toEqual([]);
    // He cancels for the end of his period: an alumnus, counted from that end.
    await memberships([paid({ status: 'canceling', cancel_at_period_end: true })]);
    expect(await alumni(c)).toEqual([
      {
        member_id: u('mber_bru'),
        status: 'entered',
        departed_at: new Date('2026-10-29T10:00:00.000Z'),
        entry_mode: 'link',
      },
    ]);
    // Then he stays after all.
    await memberships([paid()]);
    expect((await alumni(c)).map((a) => a.status)).toEqual(['returned']);
  });

  it('does nothing for a company without an Alumni offer', async () => {
    const { c, u, memberships } = await community();
    await memberships([
      membership(u('mem_free'), u('user_ana'), {
        account: { id: c },
        product_id: 'prod_Free',
        status: 'completed',
      }),
    ]);
    expect(await alumni(c)).toEqual([]);
  });
});
