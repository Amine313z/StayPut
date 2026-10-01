import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { member, membership, message, page, payment } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0008: the figures Postgres gathers for the risk score (risk_features), how it keeps
 * the scores (save_risk_scores), which companies are due, and the counts of the weekly analyses.
 */

const NOW = new Date('2026-10-01T12:00:00Z');
const iso = (daysAgo: number, hour = 12) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 + (hour - 12) * 3_600_000).toISOString();
const ms = (at: string) => Date.parse(at);
let t: TestDb;
let companies = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);

async function company() {
  companies += 1;
  const id = `biz_R${companies}`;
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [id, NOW.toISOString()]);
  await t.db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at)
     values ($1, 'user_owner', $2::timestamptz)`,
    [id, NOW.toISOString()],
  );
  return { id, u: (base: string) => `${base}R${companies}` };
}

async function ingest(c: string, kind: string, items: unknown[], scope: string | null = null) {
  await t.db.query('select stayput.ingest_page($1, $2, $3, $4::text::jsonb)', [
    c,
    kind,
    scope,
    JSON.stringify(page(items)),
  ]);
}

interface Features {
  settings: {
    weights: Record<string, number>;
    tracksProgress: boolean;
    recencyThresholdDays: number;
  };
  members: unknown[][];
}

async function features(c: string, limit = 100): Promise<Features> {
  const [row] = await rows<{ data: string }>(
    'select stayput.risk_features($1, $2::timestamptz, $3)::text as data',
    [c, NOW.toISOString(), limit],
  );
  return JSON.parse(row!.data) as Features;
}

describe('risk_features', () => {
  it("gathers each member's figures, in the order the Worker reads them", async () => {
    const { id, u } = await company();
    const people = ['A', 'B', 'C', 'D', 'E', 'H'];
    await ingest(id, 'members', [
      ...people.map((p) =>
        member(u(`mber_${p}`), u(`user_${p}`), {
          joined_at: iso(p === 'E' ? 4 : 60),
          most_recent_action_at: null,
        }),
      ),
      member(u('mber_F'), u('user_F'), { access_level: 'admin' }),
      member(u('mber_G'), u('user_G'), { status: 'left' }),
    ]);
    await ingest(id, 'memberships', [
      membership(u('mem_A'), u('user_A')),
      membership(u('mem_C'), u('user_C'), {
        cancel_at_period_end: true,
        current_period_end: '2026-10-20T00:00:00.000Z',
      }),
    ]);
    await ingest(id, 'payments', [
      payment(u('pay_B1'), {
        member_id: u('mber_B'),
        membership_id: null,
        created_at: iso(10),
        substatus: 'succeeded',
      }),
      payment(u('pay_B2'), {
        member_id: u('mber_B'),
        membership_id: null,
        created_at: iso(2),
        status: 'open',
        substatus: 'failed',
      }),
      payment(u('pay_H'), {
        member_id: u('mber_H'),
        membership_id: null,
        created_at: iso(1),
        status: 'open',
        substatus: 'incomplete',
        recovery_url: 'https://whop.com/checkout/3ds',
      }),
    ]);
    // A: 3 messages and a lesson this week, 8 messages in the 4 weeks before.
    const chat = u('chat_1');
    await ingest(
      id,
      'messages',
      [1, 2, 3, 10, 12, 15, 18, 20, 25, 27, 30].map((d, i) =>
        message(u(`msg_${i}`), u('user_A'), iso(d)),
      ),
      chat,
    );
    await ingest(
      id,
      'lesson_interactions',
      [
        {
          id: u('lint_1'),
          completed: true,
          completed_at: iso(5),
          user: { id: u('user_A') },
          lesson: { id: u('lesn_4'), title: 'Lesson 4', chapter: { id: 'chap_1' } },
        },
      ],
      u('cors_1'),
    );
    // D: a support conversation waiting for 3 days.
    await ingest(id, 'support_channels', [
      {
        id: u('sc_1'),
        customer_user: { id: u('user_D') },
        last_message_at: iso(3),
        resolved_at: null,
      },
    ]);
    await t.db.query('select stayput.refresh_stats($1::timestamptz, $2)', [NOW.toISOString(), id]);

    const result = await features(id);
    expect(result.settings).toEqual({
      weights: { recency: 0.3, frequency: 0.25, progress: 0.2, payment: 0.15, friction: 0.1 },
      recencyThresholdDays: 14,
      mediumFrom: 40,
      highFrom: 70,
      tracksProgress: true,
    });
    const byId = new Map(result.members.map((m) => [m[0], m]));
    // The team and those who left are not scored.
    expect([...byId.keys()].sort()).toEqual(people.map((p) => u(`mber_${p}`)).sort());
    expect(byId.get(u('mber_A'))).toEqual([
      u('mber_A'),
      ms(iso(60)),
      ms(iso(1)),
      4,
      8,
      ms(iso(5)),
      'Lesson 4',
      'ok',
      false,
      null,
      null,
      0,
      0,
      true,
    ]);
    expect(byId.get(u('mber_B'))?.slice(7, 9)).toEqual(['failed', false]);
    expect(byId.get(u('mber_H'))?.[7]).toBe('action_required');
    expect(byId.get(u('mber_C'))?.slice(8, 10)).toEqual([true, ms('2026-10-20T00:00:00.000Z')]);
    expect(byId.get(u('mber_D'))?.[10]).toBe(ms(iso(3)));
    expect(byId.get(u('mber_E'))).toEqual([
      u('mber_E'),
      ms(iso(4)),
      null,
      0,
      0,
      null,
      null,
      'ok',
      false,
      null,
      null,
      0,
      0,
      false,
    ]);
  });

  it('gives at most the limit, the members scored longest ago first', async () => {
    const { id, u } = await company();
    await ingest(
      id,
      'members',
      ['1', '2', '3'].map((p) => member(u(`mber_${p}`), u(`user_${p}`))),
    );
    expect((await features(id, 2)).members.map((m) => m[0])).toEqual([u('mber_1'), u('mber_2')]);
    expect((await features(id)).settings.tracksProgress).toBe(false);
  });
});

describe('save_risk_scores', () => {
  const save = (c: string, scores: unknown[], at = NOW) =>
    rows<{ saved: number }>(
      'select stayput.save_risk_scores($1, $2::text::jsonb, $3::timestamptz) as saved',
      [c, JSON.stringify(scores), at.toISOString()],
    );
  const score = (id: string, value: number, level: string, newcomer = false) => [
    id,
    value,
    level,
    [0.5, 0.2, 0, 0, 0],
    [{ code: 'inactive', days: 7 }],
    newcomer,
  ];

  it('keeps the current score, its level change, and one score a day', async () => {
    const { id, u } = await company();
    await ingest(id, 'members', [member(u('mber_1'), u('user_1'))]);
    expect((await save(id, [score(u('mber_1'), 20, 'low')]))[0]?.saved).toBe(1);
    const later = new Date(NOW.getTime() + 3_600_000);
    await save(id, [score(u('mber_1'), 75, 'high', true)], later);
    expect(
      await rows(
        `select score, level, previous_level, level_since, inactive_newcomer, sub_scores, reasons
           from stayput.member_risk where company_id = $1`,
        [id],
      ),
    ).toEqual([
      {
        score: 75,
        level: 'high',
        previous_level: 'low',
        level_since: later,
        inactive_newcomer: true,
        sub_scores: { recency: 0.5, frequency: 0.2, progress: 0, payment: 0, friction: 0 },
        reasons: [{ code: 'inactive', days: 7 }],
      },
    ]);
    // Same day: the history keeps the last score; the next day, a new row.
    await save(id, [score(u('mber_1'), 60, 'medium')], new Date(NOW.getTime() + 86_400_000));
    expect(
      await rows(
        'select day::text, score from stayput.risk_scores where company_id = $1 order by day',
        [id],
      ),
    ).toEqual([
      { day: '2026-10-01', score: 75 },
      { day: '2026-10-02', score: 60 },
    ]);
  });

  it('drops the score of a member who left, and ignores unknown members', async () => {
    const { id, u } = await company();
    await ingest(id, 'members', [member(u('mber_1'), u('user_1'))]);
    await save(id, [score(u('mber_1'), 30, 'low'), score('mber_nobody', 50, 'medium')]);
    await ingest(id, 'members', [member(u('mber_1'), u('user_1'), { status: 'left' })]);
    await save(id, []);
    expect(await rows('select 1 from stayput.member_risk where company_id = $1', [id])).toEqual([]);
  });

  it('refuses a score outside 0-100 or an unknown level', async () => {
    const { id, u } = await company();
    await ingest(id, 'members', [member(u('mber_1'), u('user_1'))]);
    await expect(save(id, [score(u('mber_1'), 130, 'high')])).rejects.toThrow();
    await expect(save(id, [score(u('mber_1'), 30, 'whatever')])).rejects.toThrow();
  });
});

describe('companies_to_score', () => {
  it('lists the companies with scores or analyses due, never a demo', async () => {
    const { id, u } = await company();
    await ingest(id, 'members', [member(u('mber_1'), u('user_1'))]);
    const due = async (at = NOW) =>
      (
        await rows<{ id: string }>(
          'select stayput.companies_to_score($1::timestamptz, 100) as id',
          [at.toISOString()],
        )
      ).map((r) => r.id);
    expect(await due()).toContain(id);
    await rows('select stayput.save_risk_scores($1, $2::text::jsonb, $3::timestamptz)', [
      id,
      JSON.stringify([[u('mber_1'), 10, 'low', [0, 0, 0, 0, 0], [], false]]),
      NOW.toISOString(),
    ]);
    await rows('select stayput.save_analyses($1, $2, $3, $4::timestamptz)', [
      id,
      '[]',
      '[]',
      NOW.toISOString(),
    ]);
    expect(await due()).not.toContain(id);
    expect(await due(new Date(NOW.getTime() + 3_600_000))).toContain(id);
  });
});

describe('analysis_features and save_analyses', () => {
  it('counts departures per cohort and horizon, and stalls per lesson', async () => {
    const { id, u } = await company();
    // Joined 100 days ago: 3 members, one left after 20 days, one after 70.
    await ingest(id, 'members', [
      member(u('mber_1'), u('user_1'), { joined_at: iso(100), most_recent_action_at: iso(1) }),
      member(u('mber_2'), u('user_2'), { joined_at: iso(100), status: 'left' }),
      member(u('mber_3'), u('user_3'), { joined_at: iso(100), status: 'left' }),
      // Joined a month ago, finished lesson 1 twenty days ago, then nothing: stalled there.
      member(u('mber_4'), u('user_4'), { joined_at: iso(30), most_recent_action_at: iso(20) }),
    ]);
    await ingest(id, 'memberships', [
      membership(u('mem_2'), u('user_2'), { status: 'canceled', current_period_end: iso(80) }),
      membership(u('mem_3'), u('user_3'), { status: 'expired', current_period_end: iso(30) }),
    ]);
    const done = (n: string, user: string, lesson: string, daysAgo: number) => ({
      id: u(`lint_${n}`),
      completed: true,
      completed_at: iso(daysAgo),
      user: { id: u(user) },
      lesson: { id: u(lesson), title: `Title ${lesson}`, chapter: { id: 'chap_1' } },
    });
    await ingest(
      id,
      'lesson_interactions',
      [
        done('1', 'user_1', 'lesn_1', 90),
        done('2', 'user_1', 'lesn_2', 80),
        done('3', 'user_2', 'lesn_1', 95),
        done('4', 'user_4', 'lesn_1', 20),
      ],
      u('cors_1'),
    );
    const [row] = await rows<{ data: string }>(
      'select stayput.analysis_features($1, $2::timestamptz)::text as data',
      [id, NOW.toISOString()],
    );
    const data = JSON.parse(row!.data) as { cohorts: unknown[]; lessons: unknown[] };
    const month = (daysAgo: number) => `${iso(daysAgo).slice(0, 7)}-01`;
    expect(data.cohorts).toEqual([
      {
        month: month(100),
        members: 3,
        eligible: { 30: 3, 60: 3, 90: 3 },
        left: { 30: 1, 60: 1, 90: 2 },
      },
      {
        month: month(30),
        members: 1,
        eligible: { 30: 1, 60: 0, 90: 0 },
        left: { 30: 0, 60: 0, 90: 0 },
      },
    ]);
    expect(data.lessons).toEqual([
      {
        lessonId: u('lesn_1'),
        courseId: u('cors_1'),
        title: 'Title lesn_1',
        reached: 3,
        stalled: 2,
      },
      {
        lessonId: u('lesn_2'),
        courseId: u('cors_1'),
        title: 'Title lesn_2',
        reached: 1,
        stalled: 0,
      },
    ]);

    await rows(
      'select stayput.save_analyses($1, $2::text::jsonb, $3::text::jsonb, $4::timestamptz)',
      [
        id,
        JSON.stringify([{ ...(data.cohorts[0] as object), alertHorizon: 90 }]),
        JSON.stringify([
          { ...(data.lessons[0] as object), rate: 0.6667, courseAverage: 0.3333, flagged: true },
        ]),
        NOW.toISOString(),
      ],
    );
    expect(
      await rows(
        `select members, left_by_90, eligible_90, alert, alert_horizon
           from stayput.cohort_stats where company_id = $1`,
        [id],
      ),
    ).toEqual([{ members: 3, left_by_90: 2, eligible_90: 3, alert: true, alert_horizon: 90 }]);
    expect(
      await rows(
        `select members_concerned, stalled, dropoff_rate::text, flagged
           from stayput.lesson_dropoff_stats where company_id = $1`,
        [id],
      ),
    ).toEqual([{ members_concerned: 3, stalled: 2, dropoff_rate: '0.6667', flagged: true }]);
    expect(
      (
        await rows<{ due: boolean }>('select stayput.analyses_due($1, $2::timestamptz) as due', [
          id,
          NOW.toISOString(),
        ])
      )[0]?.due,
    ).toBe(false);
  });
});
