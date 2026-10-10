import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0051, the plans: Free's monthly count of manual actions (never past its limit, even
 * clicked twice at once), the founders' registry (20 places, a leaked link flagged), and a
 * community on Free whose automatic actions and Monday report wait, its own actions still leaving.
 */

const NOW = '2026-10-12T10:00:00.000Z'; // a Monday
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function community(id: string, tier?: 'free' | 'pro' | 'scale') {
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [id, '2026-09-01']);
  if (tier) {
    await t.db.query(
      `insert into stayput.company_plans (company_id, tier, source) values ($1, $2, 'whop')`,
      [id, tier],
    );
  }
}

const take = (company: string, count: number) =>
  t.db
    .query<{ taken: { ok: boolean; used: number; limit: number } }>(
      'select stayput.take_manual_actions($1, $2, 5, $3::timestamptz) as taken',
      [company, count, NOW],
    )
    .then(([row]) => row!.taken);

describe('Free’s manual actions', () => {
  it('counts five a month, refuses the sixth, and gives back what was not made', async () => {
    await community('biz_Quota1');
    for (let i = 1; i <= 5; i += 1) {
      expect(await take('biz_Quota1', 1)).toEqual({ ok: true, used: i, limit: 5 });
    }
    expect(await take('biz_Quota1', 1)).toEqual({ ok: false, used: 5, limit: 5 });
    await t.db.query('select stayput.give_back_manual_actions($1, 2, $2::timestamptz)', [
      'biz_Quota1',
      NOW,
    ]);
    // Three left in the month; a request for three at once is refused whole.
    expect(await take('biz_Quota1', 3)).toEqual({ ok: false, used: 3, limit: 5 });
    expect(await take('biz_Quota1', 2)).toEqual({ ok: true, used: 5, limit: 5 });
    // A new month starts from zero.
    const [next] = await t.db.query<{ used: number }>(
      `select stayput.manual_actions_used($1, '2026-11-01T12:00:00Z'::timestamptz) as used`,
      ['biz_Quota1'],
    );
    expect(next?.used).toBe(0);
  });

  it('never lets two clicks at once pass the limit together', async () => {
    await community('biz_Quota2');
    const answers = await Promise.all(Array.from({ length: 9 }, () => take('biz_Quota2', 1)));
    expect(answers.filter((a) => a.ok)).toHaveLength(5);
  });

  it('starts the month in the community’s time zone', async () => {
    await community('biz_Quota3');
    await t.db.query(`update stayput.companies set timezone = 'America/New_York' where id = $1`, [
      'biz_Quota3',
    ]);
    // 1 November, 02:00 UTC is still 31 October in New York.
    const [month] = await t.db.query<{ month: string }>(
      `select to_char(stayput.action_month($1, '2026-11-01T02:00:00Z'::timestamptz),
                      'YYYY-MM-DD') as month`,
      ['biz_Quota3'],
    );
    expect(month?.month).toBe('2026-10-01');
  });
});

describe('the founders’ registry', () => {
  const invite = (company: string, places = 3) =>
    t.db
      .query<{ made: Record<string, unknown> }>(
        'select stayput.invite_founder($1, $2, $3, $4::timestamptz) as made',
        [company, 'met at the meetup', places, NOW],
      )
      .then(([row]) => row!.made);

  it('invites while places are left, once each', async () => {
    expect(await invite('biz_Founder1')).toEqual({ ok: true, left: 2 });
    expect(await invite('biz_Founder1')).toEqual({ ok: false, error: 'exists' });
    expect(await invite('biz_Founder2')).toEqual({ ok: true, left: 1 });
    expect(await invite('biz_Founder3')).toEqual({ ok: true, left: 0 });
    expect(await invite('biz_Founder4')).toEqual({ ok: false, error: 'full' });
  });

  it('marks an invited community subscribed, and flags one that was not invited', async () => {
    const note = (company: string) =>
      t.db
        .query<{ status: string }>(
          'select stayput.note_founder_plan($1, $2::timestamptz) as status',
          [company, NOW],
        )
        .then(([row]) => row!.status);
    expect(await note('biz_Founder1')).toBe('subscribed');
    expect(await note('biz_Leaked1')).toBe('flagged');
    // Again: it stays as it is.
    expect(await note('biz_Leaked1')).toBe('flagged');
    expect(await note('biz_Founder1')).toBe('subscribed');
    // A flagged one takes no place.
    expect(await invite('biz_Founder5', 4)).toEqual({ ok: true, left: 0 });
  });
});

describe('a community on Free', () => {
  beforeAll(async () => {
    for (const [id, tier] of [
      ['biz_TierFree', 'free'],
      ['biz_TierPro', 'pro'],
    ] as const) {
      await community(id, tier);
      await t.db.query(
        `insert into stayput.members (id, company_id, user_id, status)
         values ($1, $2, $3, 'joined')`,
        [`mber_${id.slice(4)}`, id, `user_${id.slice(4)}`],
      );
      // One action of StayPut's own, one the creator approved: both due.
      await t.db.query(
        `insert into stayput.actions (company_id, member_id, type, status, trigger, send_at,
                                      approved_by, message_kind)
         values ($1, $2, 'golden_hour_message', 'scheduled', 'score_high',
                 '2026-10-12T09:00:00Z', 'auto', 'relance'),
                ($1, $2, 'creator_note', 'scheduled', 'creator',
                 '2026-10-12T09:00:00Z', 'user_Creator', 'none')`,
        [id, `mber_${id.slice(4)}`],
      );
    }
  });

  it('runs only the creator’s own actions; Pro runs both', async () => {
    const [row] = await t.db.query<{ due: { companyId: string; type: string }[] }>(
      'select stayput.due_actions($1::timestamptz, 50) as due',
      [NOW],
    );
    const due = row!.due.map((a) => `${a.companyId} ${a.type}`).sort();
    expect(due).toEqual([
      'biz_TierFree creator_note',
      'biz_TierPro creator_note',
      'biz_TierPro golden_hour_message',
    ]);
    // Nothing was changed: StayPut's action still waits, scheduled.
    const [kept] = await t.db.query<{ status: string }>(
      `select status from stayput.actions where company_id = 'biz_TierFree'
          and type = 'golden_hour_message'`,
    );
    expect(kept?.status).toBe('scheduled');
  });

  it('gets no Monday report; Pro does', async () => {
    const rows = await t.db.query<{ company_id: string }>(
      `select company_id from stayput.weekly_reports_due($1::timestamptz, 50)
        where company_id like 'biz_Tier%' order by 1`,
      // Monday 10:00 in New York, the communities' time zone.
      ['2026-10-12T14:00:00Z'],
    );
    expect(rows.map((r) => r.company_id)).toEqual(['biz_TierPro']);
  });

  it('keeps everything until a level is stored (plans off, or never read)', async () => {
    await community('biz_TierUnread');
    const [row] = await t.db.query<{ free: string; pro: string; unread: string }>(
      `select stayput.company_tier('biz_TierFree') as free,
              stayput.company_tier('biz_TierPro') as pro,
              stayput.company_tier('biz_TierUnread') as unread`,
    );
    expect(row).toEqual({ free: 'free', pro: 'pro', unread: 'scale' });
  });
});
