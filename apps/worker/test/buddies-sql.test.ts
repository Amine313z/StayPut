import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBuddies, readBuddiesView, saveBuddies, setBuddyOptOut } from '../src/space';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0025, the buddies (SPEC Phase 5, point 8): each newcomer paired with a veteran who
 * has room, both introduced, the pair ended when one of them goes or asks to stop, and the
 * Mentor badge for a veteran whose newcomer is still there 30 days on.
 */

// 1 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-01T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

/** A community in Paris, its buddies on or off. */
async function community(buddies = true) {
  n += 1;
  const c = `biz_Bud${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale)
     values ($1, 'Le Club', 'Europe/Paris', 'fr')`,
    [c],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [c]);
  if (buddies) await saveBuddies(t.db, c, true);

  /** A member who joined `joined` days from NOW (negative: before), with their risk. */
  const member = async (
    name: string,
    joined: number,
    options: {
      risk?: { level: string; score: number; newcomer?: boolean };
      category?: string;
      admin?: boolean;
    } = {},
  ) => {
    const id = `mber_${name}${n}`;
    const user = `user_${name}${n}`;
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                    access_level)
       values ($1, $2, $3, $4, $5::timestamptz, 'joined', $6)`,
      [id, c, user, `${name} Martin`, days(joined).toISOString(), options.admin ? 'admin' : null],
    );
    if (options.risk) {
      await t.db.query(
        `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                          level_since, computed_at, inactive_newcomer)
         values ($1, $2, $3, $4, '{}', $5::timestamptz, $5::timestamptz, $6)`,
        [c, id, options.risk.score, options.risk.level, NOW.toISOString(), !!options.risk.newcomer],
      );
    }
    if (options.category) {
      await t.db.query(
        `insert into stayput.goals (company_id, member_id, title, unit, category, entry,
                                    start_value, target_value, status, created_at)
         values ($1, $2, 'Objectif', 'u', $3, 'total', 0, 10, 'active', $4::timestamptz)`,
        [c, id, options.category, days(joined).toISOString()],
      );
    }
    return { id, user };
  };
  return { c, member };
}

const veteran = { risk: { level: 'low', score: 10 } };

const plan = async (c: string, at: Date) =>
  (
    await t.db.query<{ n: number }>('select stayput.plan_buddies($1, $2::timestamptz) as n', [
      c,
      at.toISOString(),
    ])
  )[0]?.n;

const pairs = (c: string) =>
  t.db.query<{
    newcomer_member_id: string;
    veteran_member_id: string;
    status: string;
    end_reason: string | null;
  }>(
    `select newcomer_member_id, veteran_member_id, status, end_reason from stayput.buddy_pairs
      where company_id = $1 order by paired_at, newcomer_member_id`,
    [c],
  );

const intros = (c: string) =>
  t.db.query<{
    member_id: string;
    type: string;
    trigger: string;
    status: string;
    message_kind: string;
    send_at: Date | null;
    buddy_name: string | null;
    result: Record<string, unknown> | null;
  }>(
    `select member_id, type, trigger, status, message_kind, send_at,
            content ->> 'buddy_name' as buddy_name, result
       from stayput.actions where company_id = $1 and trigger = 'buddy_pair'
      order by created_at, type, member_id`,
    [c],
  );

describe('pairing the newcomers (0025)', () => {
  it('waits for the creator, then gives each newcomer a veteran with room', async () => {
    const { c, member } = await community(false);
    const lea = await member('Lea', -2);
    const tom = await member('Tom', -1, { category: 'income' });
    // Too long there to be new, too new to be a veteran, not engaged enough, of the team.
    await member('Old', -10);
    await member('Young', -20, veteran);
    await member('Medium', -60, { risk: { level: 'medium', score: 40 } });
    await member('Boss', -100, { ...veteran, admin: true });
    const ana = await member('Ana', -60, { ...veteran, category: 'income' });
    const bob = await member('Bob', -90, { risk: { level: 'low', score: 5 }, category: 'body' });

    expect(await plan(c, NOW)).toBe(0);
    expect(await pairs(c)).toEqual([]);

    await saveBuddies(t.db, c, true);
    expect(await plan(c, NOW)).toBe(4);
    // Lea joined first: the most engaged veteran (Bob). Tom's goal is income, as Ana's.
    expect(await pairs(c)).toEqual([
      { newcomer_member_id: lea.id, veteran_member_id: bob.id, status: 'active', end_reason: null },
      { newcomer_member_id: tom.id, veteran_member_id: ana.id, status: 'active', end_reason: null },
    ]);
    // Each meets the other: an introduction at their golden hour (the Worker sets it).
    const intro = (member_id: string, type: string, buddy_name: string) => ({
      member_id,
      type,
      trigger: 'buddy_pair',
      status: 'proposed',
      message_kind: 'relance',
      send_at: null,
      buddy_name,
      result: null,
    });
    expect(await intros(c)).toEqual(
      expect.arrayContaining([
        intro(lea.id, 'buddy_intro', 'Bob'),
        intro(bob.id, 'mentor_intro', 'Lea'),
        intro(tom.id, 'buddy_intro', 'Ana'),
        intro(ana.id, 'mentor_intro', 'Tom'),
      ]) as unknown,
    );
    expect(await intros(c)).toHaveLength(4);
    // Planned once.
    expect(await plan(c, new Date(NOW.getTime() + 3_600_000))).toBe(0);
  });

  it('puts first who has not started, one new pair every 5 days, 3 at most per veteran', async () => {
    const { c, member } = await community();
    const ana = await member('Ana', -60, veteran);
    const first = await member('First', -1);
    const stalled = await member('Stalled', -4, {
      risk: { level: 'medium', score: 50, newcomer: true },
    });
    expect(await plan(c, NOW)).toBe(2);
    expect(await pairs(c)).toEqual([
      expect.objectContaining({ newcomer_member_id: stalled.id, veteran_member_id: ana.id }),
    ]);
    // Within 5 days, Ana takes nobody else: the guardrails would hold her introduction back.
    expect(await plan(c, days(4))).toBe(0);
    expect(await plan(c, days(5.1))).toBe(2);
    expect((await pairs(c)).map((p) => p.newcomer_member_id)).toEqual([stalled.id, first.id]);
    const third = await member('Third', 9);
    expect(await plan(c, days(10.2))).toBe(2);
    // Three pairs under way: a fourth newcomer waits for another veteran.
    await member('Fourth', 15);
    expect(await plan(c, days(15.3))).toBe(0);
    expect(await pairs(c)).toHaveLength(3);
    expect((await pairs(c))[2]?.newcomer_member_id).toBe(third.id);
  });

  it('ends a pair when one goes, asks to stop or may not be contacted, its introductions too', async () => {
    const { c, member } = await community();
    const ana = await member('Ana', -60, veteran);
    const bob = await member('Bob', -90, { risk: { level: 'low', score: 20 } });
    const lea = await member('Lea', -1);
    expect(await plan(c, NOW)).toBe(2);
    expect((await pairs(c))[0]).toMatchObject({
      newcomer_member_id: lea.id,
      veteran_member_id: ana.id,
    });

    // Ana leaves: the pair ends, her introductions do not go; Lea gets another veteran.
    await t.db.query(`update stayput.members set status = 'left' where id = $1`, [ana.id]);
    expect(await plan(c, days(0.1))).toBe(2);
    expect(await pairs(c)).toEqual([
      expect.objectContaining({
        veteran_member_id: ana.id,
        status: 'ended',
        end_reason: 'veteran_left',
      }),
      expect.objectContaining({ veteran_member_id: bob.id, status: 'active' }),
    ]);
    const cancelled = (await intros(c)).filter((a) => a.status === 'cancelled');
    expect(cancelled.map((a) => [a.member_id, a.result?.reason])).toEqual([
      [lea.id, 'pair_ended'],
      [ana.id, 'pair_ended'],
    ]);

    // Bob asks not to be paired: the pair ends, and nobody takes him again.
    expect(await setBuddyOptOut(t.db, c, bob.user, true, days(0.2))).toEqual({
      optedOut: true,
      partners: [],
    });
    expect((await pairs(c))[1]).toMatchObject({ status: 'ended', end_reason: 'optout' });
    const max = await member('Max', 0.3);
    expect(await plan(c, days(0.4))).toBe(0);
    // He may be again: Max, still new, gets him.
    await setBuddyOptOut(t.db, c, bob.user, false, days(6));
    expect(await plan(c, days(6))).toBe(2);
    expect((await pairs(c)).at(-1)).toMatchObject({
      newcomer_member_id: max.id,
      veteran_member_id: bob.id,
      status: 'active',
    });
    // Max is put on the « never contact » list: the pair ends.
    await t.db.query(`update stayput.members set do_not_contact = true where id = $1`, [max.id]);
    expect(await plan(c, days(6.1))).toBe(0);
    expect((await pairs(c)).at(-1)).toMatchObject({
      newcomer_member_id: max.id,
      status: 'ended',
      end_reason: 'do_not_contact',
    });
    // Someone StayPut does not know.
    expect(await setBuddyOptOut(t.db, c, 'user_Nobody', true, NOW)).toBeNull();
  });

  it('makes the veteran a mentor when the newcomer is still there 30 days on', async () => {
    const { c, member } = await community();
    const ana = await member('Ana', -60, veteran);
    const bob = await member('Bob', -60, { risk: { level: 'low', score: 30 } });
    const lea = await member('Lea', -1);
    const max = await member('Max', -1.5);
    expect(await plan(c, NOW)).toBe(4);
    // Max leaves at day 20: no badge for his veteran.
    await t.db.query(`update stayput.members set status = 'left' where id = $1`, [max.id]);
    await plan(c, days(20));
    expect(await plan(c, days(30))).toBe(0);
    expect(await pairs(c)).toEqual([
      expect.objectContaining({ newcomer_member_id: lea.id, status: 'completed' }),
      expect.objectContaining({
        newcomer_member_id: max.id,
        status: 'ended',
        end_reason: 'newcomer_left',
      }),
    ]);
    const mentors = await t.db.query<{ member_id: string; context: Record<string, unknown> }>(
      `select member_id, context from stayput.member_badges
        where company_id = $1 and badge_code = 'mentor'`,
      [c],
    );
    const leaPair = (await pairs(c)).find((p) => p.newcomer_member_id === lea.id)!;
    expect(mentors).toEqual([
      {
        member_id: leaPair.veteran_member_id,
        context: { pair_id: expect.any(String) as string, newcomer_id: lea.id },
      },
    ]);
    expect([ana.id, bob.id]).toContain(leaPair.veteran_member_id);
  });
});

describe('the buddies as members and creators see them', () => {
  it('shows each member theirs, and their goal category when they share it', async () => {
    const { c, member } = await community();
    const ana = await member('Ana', -60, { ...veteran, category: 'income' });
    const lea = await member('Lea', -2, { category: 'income' });
    const tom = await member('Tom', -1, { category: 'body' });
    await plan(c, NOW);
    // Ana has room for one new pair every 5 days: Tom waits.
    expect(await readBuddies(t.db, c, lea.user)).toEqual({
      optedOut: false,
      partners: [
        {
          pairId: expect.any(String) as string,
          role: 'veteran',
          name: 'Ana Martin',
          joinedAt: days(-60).toISOString(),
          pairedAt: NOW.toISOString(),
          sameCategory: 'income',
        },
      ],
    });
    await plan(c, days(5.5));
    const seen = await readBuddies(t.db, c, ana.user);
    expect(seen?.partners.map((p) => [p.role, p.name, p.sameCategory])).toEqual([
      ['newcomer', 'Lea Martin', 'income'],
      ['newcomer', 'Tom Martin', null],
    ]);
    expect(await readBuddies(t.db, c, tom.user)).toMatchObject({
      partners: [{ name: 'Ana Martin' }],
    });
    expect(await readBuddies(t.db, c, 'user_Nobody')).toBeNull();
  });

  it('tells the creator where they stand, under RLS', async () => {
    const { c, member } = await community(false);
    await member('Ana', -60, veteran);
    await member('Bob', -90, veteran);
    await member('Lea', -1);
    await member('Tom', -2);
    await member('Max', -3);
    // RLS checks the team's access against the database's own clock (is_company_admin).
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, 'user_owner', now())`,
      [c],
    );
    const view = () => readBuddiesView(t.db, 'user_owner', c, NOW);
    expect(await view()).toEqual({
      enabled: false,
      activePairs: 0,
      waitingNewcomers: 3,
      veterans: 2,
      mentors: 0,
    });
    await saveBuddies(t.db, c, true);
    await plan(c, NOW);
    expect(await view()).toEqual({
      enabled: true,
      activePairs: 2,
      waitingNewcomers: 1,
      veterans: 2,
      mentors: 0,
    });
    // Someone who is not of the team reads nothing.
    expect(await readBuddiesView(t.db, 'user_stranger', c, NOW)).toBeNull();
  });
});
