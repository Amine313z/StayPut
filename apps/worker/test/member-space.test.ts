import { goalProgress } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/db';
import {
  readGoalProposals,
  readMemberSpace,
  recordOpen,
  recordResult,
  saveGoalProposals,
  setGoal,
} from '../src/space';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0020, the member space (SPEC Phase 5, first part): one goal under way per member,
 * the results they record (where they stand, or what they add), the milestones at 25, 50, 75
 * and 100 % whichever way the goal goes, the first badges, and each opening of the space as an
 * activity of the member.
 */

// 1 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-01T08:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

/** A community in Paris, in French, with one member. */
async function community(niche = 'fitness') {
  n += 1;
  const c = `biz_Space${n}`;
  const user = `user_Space${n}`;
  const member = `mber_Space${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, niche, timezone, locale)
     values ($1, 'Le Club', $2, 'Europe/Paris', 'fr')`,
    [c, niche],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [c]);
  await t.db.query(
    `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status)
     values ($1, $2, $3, 'Lina Martin', '2026-09-01T00:00:00Z', 'joined')`,
    [member, c, user],
  );
  return { c, user, member };
}

const WEIGHT = {
  title: 'Atteindre mon poids cible',
  unit: 'kg',
  category: 'body' as const,
  entry: 'total' as const,
  start: 92,
  target: 85,
  targetDate: '2026-12-31',
};

const CLIENTS = {
  title: 'Signer de nouveaux clients',
  unit: 'clients',
  category: 'clients' as const,
  entry: 'add' as const,
  start: 0,
  target: 10,
  targetDate: '2027-03-31',
};

const space = (c: string, user: string) =>
  readMemberSpace(t.db, c, user, { locale: 'fr', preview: false });

describe('the member’s goal', () => {
  it('goes down as well as up: milestones at a quarter, half, three quarters, all the way', async () => {
    const { c, user } = await community();
    expect(await setGoal(t.db, c, user, WEIGHT, NOW)).toBe(true);
    const before = await space(c, user);
    expect(before.known).toBe(true);
    expect(before.goal).toMatchObject({
      title: 'Atteindre mon poids cible',
      category: 'body',
      entry: 'total',
      start: 92,
      target: 85,
      current: 92,
      progress: 0,
      targetDate: '2026-12-31',
      status: 'active',
      milestones: [],
    });
    const goalId = before.goal!.id;

    // 1.75 kg of 7: a quarter of the way.
    expect(await recordResult(t.db, c, user, { goalId, value: 90.25 }, at(1))).toEqual({
      milestones: [25],
      badges: ['first_result', 'milestone_25'],
      achieved: false,
      proof: null,
    });
    // Back up a little: nothing is taken away.
    expect(await recordResult(t.db, c, user, { goalId, value: 91 }, at(2))).toEqual({
      milestones: [],
      badges: [],
      achieved: false,
      proof: null,
    });
    expect(await recordResult(t.db, c, user, { goalId, value: 88.5 }, at(3))).toEqual({
      milestones: [50],
      badges: ['milestone_50'],
      achieved: false,
      proof: null,
    });
    // Beyond the target in one go: the last two milestones, the goal reached.
    expect(await recordResult(t.db, c, user, { goalId, value: 84.2 }, at(4))).toEqual({
      milestones: [75, 100],
      badges: ['milestone_75', 'milestone_100'],
      achieved: true,
      proof: null,
    });

    const after = await space(c, user);
    expect(after.goal).toMatchObject({
      id: goalId,
      current: 84.2,
      progress: 100,
      status: 'achieved',
    });
    expect(after.goal!.milestones.map((m) => m.percent)).toEqual([25, 50, 75, 100]);
    expect(after.goal!.milestones[0]!.reachedAt).toBe(at(1).toISOString());
    expect(after.results.map((r) => r.value)).toEqual([84.2, 88.5, 91, 90.25]);
    expect(after.badges.map((b) => b.code)).toEqual([
      'first_result',
      'milestone_25',
      'milestone_50',
      'milestone_75',
      'milestone_100',
    ]);
    // A goal reached takes no more results: the member sets a new one.
    expect(await recordResult(t.db, c, user, { goalId, value: 83 }, at(5))).toBeNull();
  });

  it('adds up what the member did, corrections included', async () => {
    const { c, user } = await community();
    await setGoal(t.db, c, user, CLIENTS, NOW);
    const goalId = (await space(c, user)).goal!.id;
    expect(await recordResult(t.db, c, user, { goalId, value: 2 }, at(1))).toMatchObject({
      milestones: [],
      badges: ['first_result'],
    });
    expect(await recordResult(t.db, c, user, { goalId, value: 3 }, at(2))).toMatchObject({
      milestones: [25, 50],
    });
    // A client counted twice: taken back.
    await recordResult(t.db, c, user, { goalId, value: -1 }, at(3));
    const now = await space(c, user);
    expect(now.goal).toMatchObject({ current: 4, progress: 40, status: 'active' });
    expect(now.results.map((r) => r.value)).toEqual([4, 5, 2]);
    // Two milestones stay reached.
    expect(now.goal!.milestones.map((m) => m.percent)).toEqual([25, 50]);
  });

  it('keeps one goal under way: a new one ends it, a goal reached stays reached', async () => {
    const { c, user, member } = await community();
    await setGoal(t.db, c, user, CLIENTS, NOW);
    const first = (await space(c, user)).goal!.id;
    await setGoal(t.db, c, user, { ...CLIENTS, target: 5 }, at(1));
    const second = (await space(c, user)).goal!;
    expect(second.target).toBe(5);
    await recordResult(t.db, c, user, { goalId: second.id, value: 5 }, at(2));
    await setGoal(t.db, c, user, WEIGHT, at(3));
    const third = (await space(c, user)).goal!;
    expect(third).toMatchObject({ title: WEIGHT.title, status: 'active' });

    const statuses = await t.db.query<{ id: string; status: string }>(
      `select id, status from stayput.goals where company_id = $1 and member_id = $2
        order by created_at`,
      [c, member],
    );
    expect(statuses.map((g) => g.status)).toEqual(['abandoned', 'achieved', 'active']);
    expect(statuses[0]!.id).toBe(first);
    // An abandoned goal takes no result.
    expect(await recordResult(t.db, c, user, { goalId: first, value: 1 }, at(4))).toBeNull();
    // Nor a goal of another member.
    const other = await community();
    expect(
      await recordResult(t.db, other.c, other.user, { goalId: third.id, value: 90 }, at(4)),
    ).toBeNull();
  });

  it('waits for StayPut to know the member, and never overflows', async () => {
    const { c, user } = await community();
    expect(await setGoal(t.db, c, 'user_Unknown', WEIGHT, NOW)).toBe(false);
    const unknown = await space(c, 'user_Unknown');
    expect(unknown).toMatchObject({ known: false, goal: null, results: [], badges: [] });
    await setGoal(t.db, c, user, { ...CLIENTS, target: 100_000_000_000 }, NOW);
    const goalId = (await space(c, user)).goal!.id;
    await recordResult(t.db, c, user, { goalId, value: 60_000_000_000 }, at(1));
    expect(await recordResult(t.db, c, user, { goalId, value: 60_000_000_000 }, at(2))).toBeNull();
  });

  it('counts each goal and result as progress of the member (goal_update)', async () => {
    const { c, user, member } = await community();
    await setGoal(t.db, c, user, CLIENTS, NOW);
    const goalId = (await space(c, user)).goal!.id;
    await recordResult(t.db, c, user, { goalId, value: 1 }, at(1));
    const events = await t.db.query<{ external_id: string; metadata: { goal_id: string } }>(
      `select external_id, metadata from stayput.activity_events
        where company_id = $1 and member_id = $2 and type = 'goal_update'
        order by occurred_at`,
      [c, member],
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.external_id).toBe(`goal:${goalId}`);
    expect(events[1]!.external_id).toMatch(/^result:/);
    expect(events.every((e) => e.metadata.goal_id === goalId)).toBe(true);
  });
});

describe('a screenshot backing a result (migration 0021)', () => {
  const sha = (c: string) => c.repeat(64);

  it('justifies the result whose number is on it, once, with the badge of the first proof', async () => {
    const { c, user, member } = await community();
    await setGoal(t.db, c, user, { ...CLIENTS, entry: 'total', target: 5000 }, NOW);
    const goalId = (await space(c, user)).goal!.id;
    const proof = { sha256: sha('a'), numbers: [3250, 12, 270.83] };
    expect(await recordResult(t.db, c, user, { goalId, value: 3250, proof }, at(1))).toEqual({
      milestones: [25, 50],
      badges: ['first_result', 'first_proof', 'milestone_25', 'milestone_50'],
      achieved: false,
      proof: 'justified',
    });
    // The same screenshot again: the result counts, as declared.
    expect(
      await recordResult(t.db, c, user, { goalId, value: 270.83, proof }, at(2)),
    ).toMatchObject({ badges: [], proof: 'duplicate' });
    // A number that is not on it: declared, and the screenshot is not kept.
    expect(
      await recordResult(
        t.db,
        c,
        user,
        { goalId, value: 3300, proof: { sha256: sha('b'), numbers: [3250] } },
        at(3),
      ),
    ).toMatchObject({ proof: 'declared' });
    // No screenshot: nothing to say about one.
    expect(await recordResult(t.db, c, user, { goalId, value: 3400 }, at(4))).toMatchObject({
      proof: null,
    });

    const after = await space(c, user);
    expect(after.results.map((r) => [r.value, r.proof])).toEqual([
      [3400, null],
      [3300, null],
      [270.83, null],
      [3250, 'justified'],
    ]);
    const proofs = await t.db.query<{
      level: string;
      image_sha256: string;
      image_stored: boolean;
      ocr_values: unknown;
    }>(
      `select level, image_sha256, image_stored, ocr_values from stayput.proofs
        where company_id = $1 and member_id = $2`,
      [c, member],
    );
    // The fingerprint and the numbers read, never the image.
    expect(proofs).toEqual([
      {
        level: 'justified',
        image_sha256: sha('a'),
        image_stored: false,
        ocr_values: { numbers: [3250, 12, 270.83], matched: 3250 },
      },
    ]);
  });

  it('backs one result in the whole community', async () => {
    const one = await community();
    const two = await community();
    for (const { c, user } of [one, two]) {
      await setGoal(t.db, c, user, CLIENTS, NOW);
    }
    const proof = { sha256: sha('c'), numbers: [2] };
    const first = (await space(one.c, one.user)).goal!.id;
    expect(
      await recordResult(t.db, one.c, one.user, { goalId: first, value: 2, proof }, at(1)),
    ).toMatchObject({ proof: 'justified' });
    // Another community: its own proofs.
    const second = (await space(two.c, two.user)).goal!.id;
    expect(
      await recordResult(t.db, two.c, two.user, { goalId: second, value: 2, proof }, at(1)),
    ).toMatchObject({ proof: 'justified' });
  });

  it('keeps the Worker of before 0021 working, without a screenshot', async () => {
    const { c, user } = await community();
    await setGoal(t.db, c, user, CLIENTS, NOW);
    const goalId = (await space(c, user)).goal!.id;
    const [row] = await t.db.query<{ r: { badges: string[]; proof: null } }>(
      'select stayput.record_result($1, $2, $3::uuid, 1::numeric, $4::timestamptz) as r',
      [c, user, goalId, at(1).toISOString()],
    );
    expect(row!.r).toMatchObject({ badges: ['first_result'], proof: null });
  });
});

describe('opening the member space', () => {
  it('is one activity per day of the community’s time zone', async () => {
    const { c, user, member } = await community();
    await recordOpen(t.db, c, user, NOW);
    await recordOpen(t.db, c, user, at(5));
    // 23:30 in Paris, the same day; then 00:30, the next.
    await recordOpen(t.db, c, user, new Date('2026-10-01T21:30:00Z'));
    await recordOpen(t.db, c, user, new Date('2026-10-01T22:30:00Z'));
    const opens = await t.db.query<{ external_id: string }>(
      `select external_id from stayput.activity_events
        where company_id = $1 and member_id = $2 and type = 'stayput_open'
        order by occurred_at`,
      [c, member],
    );
    expect(opens.map((o) => o.external_id)).toEqual([
      `open:${user}:2026-10-01`,
      `open:${user}:2026-10-02`,
    ]);
  });

  it('brings the badge of seven days in a row on the seventh, once', async () => {
    const { c, user } = await community();
    const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
    for (let d = 0; d < 6; d += 1) {
      expect(await recordOpen(t.db, c, user, day(d))).toEqual([]);
    }
    expect(await recordOpen(t.db, c, user, day(6))).toEqual(['streak_7_days']);
    expect(await recordOpen(t.db, c, user, day(7))).toEqual([]);
    expect((await space(c, user)).badges.map((b) => b.code)).toEqual(['streak_7_days']);
  });

  it('counts a day with a result, and starts again after a day missed', async () => {
    const { c, user } = await community();
    const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000);
    await setGoal(t.db, c, user, CLIENTS, day(0));
    const goalId = (await space(c, user)).goal!.id;
    for (const d of [1, 2, 3, 4, 5]) await recordOpen(t.db, c, user, day(d));
    // Day 6 missed: day 7 makes no streak.
    expect(await recordOpen(t.db, c, user, day(7))).toEqual([]);
    for (const d of [8, 9, 10, 11, 12]) await recordOpen(t.db, c, user, day(d));
    // The seventh day of the new run is a result, without opening (the page was open).
    expect(await recordResult(t.db, c, user, { goalId, value: 1 }, day(13))).toMatchObject({
      badges: ['first_result', 'streak_7_days'],
    });
  });

  it('waits for the member when StayPut does not know them yet', async () => {
    const { c } = await community();
    expect(await recordOpen(t.db, c, 'user_Newcomer', NOW)).toEqual([]);
    const pending = await t.db.query<{ type: string }>(
      `select type from stayput.pending_activity where company_id = $1 and user_id = $2`,
      [c, 'user_Newcomer'],
    );
    expect(pending).toEqual([{ type: 'stayput_open' }]);
    // A community StayPut does not know: nothing at all.
    expect(await recordOpen(t.db, 'biz_Nowhere', 'user_Newcomer', NOW)).toEqual([]);
  });
});

describe('the goals the creator proposes', () => {
  it('are the niche’s, in the member’s language, until the creator writes their own', async () => {
    const { c, user } = await community('coaching');
    expect((await space(c, user)).proposals[0]).toEqual({
      title: 'Signer de nouveaux clients',
      unit: 'clients',
      category: 'clients',
      entry: 'add',
    });
    const english = await readMemberSpace(t.db, c, user, { locale: 'en', preview: false });
    expect(english.proposals[0]?.title).toBe('Sign new clients');

    const own = [
      { title: 'Décrocher 3 rendez-vous', unit: 'rdv', category: 'clients', entry: 'add' },
    ];
    await saveGoalProposals(t.db, c, own as never);
    expect((await space(c, user)).proposals).toEqual(own);
    await saveGoalProposals(t.db, c, null);
    expect((await space(c, user)).proposals).toHaveLength(3);
  });

  it('are what the creator reads under RLS, beside the niche’s', async () => {
    const { c } = await community('trading');
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, 'user_Creator1', now())`,
      [c],
    );
    const own = [
      { title: 'Respecter mon stop', unit: 'trades', category: 'practice', entry: 'add' },
    ];
    await saveGoalProposals(t.db, c, own as never);
    const view = await readGoalProposals(t.db, 'user_Creator1', c, 'fr');
    expect(view).toEqual({
      niche: 'trading',
      custom: own,
      defaults: expect.arrayContaining([
        expect.objectContaining({ title: 'Suivre mon plan de trading' }),
      ]) as unknown,
    });
    // Another creator reads nothing of it.
    expect(await readGoalProposals(t.db, 'user_Stranger', c, 'fr')).toBeNull();
  });

  it('are what the team previews: nothing of their own', async () => {
    const { c, user } = await community();
    await setGoal(t.db, c, user, WEIGHT, NOW);
    const preview = await readMemberSpace(t.db, c, user, { locale: 'fr', preview: true });
    expect(preview).toMatchObject({ preview: true, known: false, goal: null, results: [] });
    expect(preview.proposals).toHaveLength(3);
  });
});

describe('the messages', () => {
  it('can name the member’s goal and how far they are, as the creator previews them', async () => {
    const { c, user, member } = await community();
    await setGoal(t.db, c, user, WEIGHT, NOW);
    const goalId = (await space(c, user)).goal!.id;
    await recordResult(t.db, c, user, { goalId, value: 89.2 }, at(1));
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, 'user_Creator2', now())`,
      [c],
    );
    const [row] = await withUser(t.db, 'user_Creator2', (tx) =>
      tx.query<{ v: { goal: string; progress: string } }>(
        'select stayput.message_values($1, $2, $3::timestamptz) as v',
        [c, member, at(2).toISOString()],
      ),
    );
    expect(row!.v.goal).toBe('Atteindre mon poids cible');
    expect(row!.v.progress).toBe('40 %');
  });
});

describe('the progress', () => {
  it('is the same in the database and in packages/core (the preview computes it too)', async () => {
    // A fixed spread of goals up and down, with cents, around every milestone.
    const cases: [number, number, number][] = [];
    let seed = 7;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 300; i += 1) {
      const start = Math.round(next() * 100_000) / 100;
      const target = Math.round(next() * 100_000) / 100;
      const at = [0.25, 0.5, 0.75, 1][i % 4]! + (next() - 0.5) / 1000;
      const current = Math.round((start + (target - start) * at) * 100) / 100;
      cases.push([start, target, current]);
    }
    cases.push([0, 3, 0.75], [0, 1000, 249.99], [0, 1000, 250], [92, 85, 90.25], [5, 5, 5]);
    const rows = await t.db.query<{ p: number }>(
      `select stayput.goal_progress((c ->> 0)::numeric, (c ->> 1)::numeric, (c ->> 2)::numeric) as p
         from jsonb_array_elements($1::text::jsonb) with ordinality as x(c, i)
        order by i`,
      [JSON.stringify(cases)],
    );
    expect(rows.map((r) => r.p)).toEqual(cases.map(([a, b, c]) => goalProgress(a, b, c)));
  });
});
