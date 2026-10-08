import { WhopApiError, type WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDueActions, prepareActions } from '../src/actions';
import { alumniOfMember } from '../src/alumni';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0019, the Alumni offer's follow-ups (SPEC 5.9): J+7, J+30 and J+60 after the
 * departure, news and a return code in the support chat, planned once per step, through the
 * guardrails like every action, and the code in the former member's view of the Alumni.
 */

// 1 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-01T08:00:00Z');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

/** A community in automatic mode whose Alumni offer is ready. */
async function community() {
  n += 1;
  const c = `biz_Fol${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, mode, timezone, locale, experience_id)
     values ($1, 'Le Club', 'auto', 'Europe/Paris', 'fr', $2)`,
    [c, `exp_Club${n}`],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [c]);
  await t.db.query(
    `select stayput.save_alumni_offer($1, 'Alumni', null, $2::text::jsonb, $3::timestamptz)`,
    [
      c,
      JSON.stringify({
        productId: `prod_Alu${n}`,
        planId: `plan_Alu${n}`,
        url: `https://whop.com/checkout/plan_Alu${n}`,
        experienceId: `exp_Alu${n}`,
        completed: true,
      }),
      NOW.toISOString(),
    ],
  );
  return { c, alumniProduct: `prod_Alu${n}`, experience: `exp_Alu${n}`, club: `exp_Club${n}` };
}

/**
 * A former member: their paid membership ended at `departedAt`, then they took the Alumni link
 * the next day.
 */
async function former(
  community: { c: string; alumniProduct: string },
  name: string,
  departedAt: string,
) {
  n += 1;
  const id = `mber_Fol${n}`;
  const user = `user_Fol${n}`;
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                  access_level)
     values ($1, $2, $3, $4, '2026-06-01T00:00:00Z', 'joined', 'customer')`,
    [id, community.c, user, name],
  );
  const paid = `mem_Paid${n}`;
  await membership(community.c, id, user, {
    id: paid,
    product: 'prod_Club',
    plan: 'plan_Club',
    status: 'canceled',
    periodEnd: departedAt,
    createdAt: '2026-06-01T00:00:00Z',
  });
  await membership(community.c, id, user, {
    id: `mem_Alu${n}`,
    product: community.alumniProduct,
    plan: 'plan_AluAny',
    status: 'completed',
    periodEnd: null,
    createdAt: new Date(Date.parse(departedAt) + 86_400_000).toISOString(),
  });
  return { id, user, paid, alumniMembership: `mem_Alu${n}` };
}

async function membership(
  c: string,
  member: string,
  user: string,
  m: {
    id: string;
    product: string;
    plan: string;
    status: string;
    periodEnd: string | null;
    createdAt: string;
  },
) {
  await t.db.query(
    `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                      price, currency, status, current_period_end,
                                      whop_created_at)
     values ($1, $2, $3, $4, $5, $6, 49, 'eur', $7, $8::timestamptz, $9::timestamptz)
     on conflict (id) do update set status = excluded.status`,
    [m.id, c, member, user, m.product, m.plan, m.status, m.periodEnd, m.createdAt],
  );
}

const planFollowups = async (c: string, at: string) =>
  (
    await t.db.query<{ planned: number }>(
      'select stayput.plan_alumni_followups($1, $2::timestamptz) as planned',
      [c, at],
    )
  )[0]?.planned;

const followups = (c: string) =>
  t.db.query<{
    member_id: string;
    status: string;
    dedupe_key: string;
    subject_id: string;
    content: Record<string, unknown>;
    blocked_reason: string | null;
    result: Record<string, unknown> | null;
  }>(
    `select member_id, status, dedupe_key, subject_id, content, blocked_reason, result
       from stayput.actions where company_id = $1 and type = 'alumni_followup'
      order by created_at, dedupe_key`,
    [c],
  );

function fakeWhop(answer: (path: string) => unknown = () => ({})) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const whop = {
    request: vi.fn((method: string, path: string, options?: { body?: unknown }) => {
      calls.push({ method, path, body: options?.body });
      const result = answer(path);
      if (result instanceof Error) return Promise.reject(result);
      // The support chat with a member: Whop opens it, or gives the one there is.
      if (path === '/support_channels' && !(result as { id?: unknown }).id) {
        return Promise.resolve({ id: 'supp_1' });
      }
      return Promise.resolve(result);
    }),
  } as unknown as WhopClient;
  return { whop, calls };
}

describe('the Alumni follow-ups (0019)', () => {
  // The run takes what is due across companies: each test starts from its own actions only.
  beforeEach(async () => {
    await t.db.query(`update stayput.actions set status = 'cancelled' where status = 'scheduled'`);
  });

  it('plans J+7, J+30 and J+60 once each, the latest step only for a late entry', async () => {
    const club = await community();
    // Ana left 7 days and 22 hours ago, Bo 26 days ago: his J+7 has passed, J+30 is to come.
    const ana = await former(club, 'Ana Lopez', '2026-09-23T10:00:00Z');
    const bo = await former(club, 'Bo', '2026-09-05T10:00:00Z');
    // Cy left the Alumni, Dee came back to a paid offer: never called back.
    const cy = await former(club, 'Cy', '2026-09-22T10:00:00Z');
    await membership(club.c, cy.id, cy.user, {
      id: cy.alumniMembership,
      product: club.alumniProduct,
      plan: 'plan_AluAny',
      status: 'canceled',
      periodEnd: null,
      createdAt: '2026-09-23T10:00:00Z',
    });
    const dee = await former(club, 'Dee', '2026-09-22T10:00:00Z');
    await membership(club.c, dee.id, dee.user, {
      id: `mem_Back${n}`,
      product: 'prod_Club',
      plan: 'plan_Club',
      status: 'active',
      periodEnd: '2026-10-30T10:00:00Z',
      createdAt: '2026-09-30T10:00:00Z',
    });

    expect(await planFollowups(club.c, NOW.toISOString())).toBe(1);
    expect(await followups(club.c)).toEqual([
      {
        member_id: ana.id,
        status: 'proposed',
        dedupe_key: `alumni_followup:${ana.id}:2026-09-23:7`,
        // The paid membership left: its product and currency make the code.
        subject_id: ana.paid,
        content: { step: 7, departed_at: '2026-09-23T10:00:00+00:00' },
        blocked_reason: null,
        result: null,
      },
    ]);
    // Once per step.
    expect(await planFollowups(club.c, NOW.toISOString())).toBe(0);
    // 23 October: Bo's J+30; Ana's comes the next day.
    expect(await planFollowups(club.c, '2026-10-23T08:00:00Z')).toBe(1);
    expect(await planFollowups(club.c, '2026-10-24T12:00:00Z')).toBe(1);
    // 25 November: both J+60.
    expect(await planFollowups(club.c, '2026-11-25T08:00:00Z')).toBe(2);
    expect((await followups(club.c)).map((a) => a.dedupe_key)).toEqual([
      `alumni_followup:${ana.id}:2026-09-23:7`,
      `alumni_followup:${bo.id}:2026-09-05:30`,
      `alumni_followup:${ana.id}:2026-09-23:30`,
      `alumni_followup:${ana.id}:2026-09-23:60`,
      `alumni_followup:${bo.id}:2026-09-05:60`,
    ]);
  });

  it('sends news and a return code in the support chat, then shows the code', async () => {
    const club = await community();
    const ana = await former(club, 'Ana Lopez', '2026-09-23T10:00:00Z');
    expect(await alumniOfMember(t.db, club.c, ana.user, NOW, 'sandbox')).toMatchObject({
      alumni: { code: null, returnUrl: 'https://sandbox.whop.com/checkout/plan_Club' },
    });

    // Automatic mode: scheduled at the default hour, 19:00 in Paris.
    expect(await prepareActions(t.db, club.c, NOW)).toEqual({
      planned: 1,
      scheduled: 1,
      blocked: 0,
    });
    const at = new Date('2026-10-01T17:00:00Z');
    const { whop, calls } = fakeWhop((path) =>
      path === '/promo_codes' ? { id: 'promo_F1', expires_at: '2026-10-08T17:00:00.000Z' } : {},
    );
    expect(await executeDueActions(t.db, whop, at)).toEqual({ sent: 1 });
    const [sent] = await followups(club.c);
    const code = String(sent?.result?.code);
    expect(sent).toMatchObject({
      status: 'sent',
      result: { code, promo_code_id: 'promo_F1', step: 7, percent_off: 20, months: 3 },
    });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/promo_codes',
        body: expect.objectContaining({
          code,
          product_id: 'prod_Club',
          base_currency: 'eur',
          stock: 1,
          new_users_only: false,
          // Former customers only: shared on, it gives nothing to anyone else.
          churned_users_only: true,
        }) as unknown,
      },
      // In the community's support chat with her: a former member keeps it.
      {
        method: 'POST',
        path: '/support_channels',
        body: { account_id: club.c, user_id: ana.user },
      },
      {
        method: 'POST',
        path: '/messages',
        body: {
          channel_id: 'supp_1',
          content: expect.stringMatching(/^\*\*Des nouvelles de Le Club\*\*\n\n/) as string,
        },
      },
    ]);
    expect(String((calls[2]?.body as { content?: unknown }).content)).toContain(code);

    // Ana opens StayPut in the Alumni space: her code, and the checkout of the plan she left.
    expect(await alumniOfMember(t.db, club.c, ana.user, at, 'sandbox')).toEqual({
      url: `https://whop.com/checkout/plan_Alu${n - 1}`,
      alumni: {
        code: { code, percentOff: 20, months: 3, expiresAt: '2026-10-08T17:00:00.000Z' },
        returnUrl: 'https://sandbox.whop.com/checkout/plan_Club',
      },
    });
    // Not to someone outside the Alumni.
    expect(await alumniOfMember(t.db, club.c, 'user_Nobody', at, 'sandbox')).toMatchObject({
      alumni: null,
    });

    // The code counts in the creator's monthly cap, and one code at a time: a follow-up while
    // it holds is blocked.
    expect(
      (
        await t.db.query<{ n: number }>(
          'select stayput.promo_codes_last_30($1, $2::timestamptz) as n',
          [club.c, at.toISOString()],
        )
      )[0]?.n,
    ).toBe(1);
    await t.db.query(
      `insert into stayput.actions (company_id, member_id, type, trigger, message_kind, dedupe_key)
       values ($1, $2, 'alumni_followup', 'alumni', 'relance', 'test:again')`,
      [club.c, ana.id],
    );
    expect(await prepareActions(t.db, club.c, new Date('2026-10-02T08:00:00Z'))).toMatchObject({
      blocked: 1,
    });
    expect((await followups(club.c)).map((a) => a.blocked_reason)).toEqual([
      null,
      'promo_already_active',
    ]);
  });

  it('keeps the code made before an outage, and sends only the message an hour later', async () => {
    const club = await community();
    await former(club, 'Ana Lopez', '2026-09-23T10:00:00Z');
    await prepareActions(t.db, club.c, NOW);
    const at = new Date('2026-10-01T17:00:00Z');
    const down = fakeWhop((path) =>
      path === '/promo_codes'
        ? { id: 'promo_F2', expires_at: '2026-10-08T17:00:00.000Z' }
        : new WhopApiError(503, 'unavailable', 'try later', { method: 'POST', path }),
    );
    expect(await executeDueActions(t.db, down.whop, at)).toEqual({ retried: 1 });
    const [kept] = await followups(club.c);
    expect(kept).toMatchObject({
      status: 'scheduled',
      result: { promo_created: true, promo_code_id: 'promo_F2' },
    });

    const back = fakeWhop();
    expect(await executeDueActions(t.db, back.whop, new Date(at.getTime() + 3_600_000))).toEqual({
      sent: 1,
    });
    expect(back.calls.map((call) => call.path)).toEqual(['/support_channels', '/messages']);
    expect((await followups(club.c))[0]).toMatchObject({
      status: 'sent',
      result: {
        code: kept?.result?.code,
        promo_code_id: 'promo_F2',
        expires_at: '2026-10-08T17:00:00.000Z',
      },
    });
  });

  it('does nothing in test mode but compute, and nothing for a demo or without the space', async () => {
    const club = await community();
    await former(club, 'Ana Lopez', '2026-09-23T10:00:00Z');
    await t.db.query(`update stayput.company_settings set dry_run = true where company_id = $1`, [
      club.c,
    ]);
    await prepareActions(t.db, club.c, NOW);
    const { whop, calls } = fakeWhop();
    expect(await executeDueActions(t.db, whop, new Date('2026-10-01T17:00:00Z'))).toEqual({
      simulated: 1,
    });
    expect(calls).toEqual([]);

    const demo = await community();
    await former(demo, 'Bo', '2026-09-23T10:00:00Z');
    await t.db.query(`update stayput.companies set is_demo = true where id = $1`, [demo.c]);
    expect(await planFollowups(demo.c, NOW.toISOString())).toBe(0);

    const unfinished = await community();
    await former(unfinished, 'Cy', '2026-09-23T10:00:00Z');
    await t.db.query(`update stayput.alumni_offers set completed_at = null where company_id = $1`, [
      unfinished.c,
    ]);
    expect(await planFollowups(unfinished.c, NOW.toISOString())).toBe(0);
  });

  it('never takes the Alumni space for the community’s, where the paying members are', async () => {
    const club = await community();
    const space = async () =>
      (
        await t.db.query<{ experience_id: string }>(
          'select experience_id from stayput.companies where id = $1',
          [club.c],
        )
      )[0]?.experience_id;
    await t.db.query('select stayput.remember_experience($1, $2)', [club.c, club.experience]);
    expect(await space()).toBe(club.club);
    await t.db.query('select stayput.remember_experience($1, $2)', [club.c, 'exp_Elsewhere']);
    expect(await space()).toBe('exp_Elsewhere');
  });
});
