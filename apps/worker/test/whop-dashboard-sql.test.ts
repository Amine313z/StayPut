import type { PlatformDashboard, PlatformDayView, PlatformSlotView } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/db';
import { member, message, page } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0049 (the founder, 2026-10-10): Integrations › Whop, a dashboard like Discord's and
 * Telegram's, from what members write on Whop: chat messages and forum posts (who, where and
 * when, never what), each chat and forum by the name its Whop listing gives.
 */

const NOW = '2026-10-10T12:00:00Z';
const DAY = 86_400_000;
const at = (days: number, hour = 10, minute = 0) => {
  const moment = new Date(Date.parse(NOW) - days * DAY);
  moment.setUTCHours(hour, minute, 0, 0);
  return moment.toISOString();
};
const OWNER = 'user_WdOwner';
const CHAT = 'chat_WdGeneral';
const FORUM = 'exp_WdForum';
const QUIET = 'chat_WdQuiet';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);
const short = (c: string) => c.replace(/^biz_/, '');

/**
 * A community on Whop: a chat « General » and a forum « Wins » named by their listings, a quiet
 * chat; Alice writes a lot, Bruno (high risk) went quiet 12 days ago, Eve is the team.
 */
async function community(c: string) {
  await rows('select stayput.ensure_company($1, $2::timestamptz)', [c, NOW]);
  await rows(`update stayput.companies set timezone = 'UTC' where id = $1`, [c]);
  await rows(
    `insert into stayput.company_admins (company_id, user_id, verified_at) values ($1, $2, now())`,
    [c, OWNER],
  );
  const user = (key: string) => `user_${short(c)}${key}`;
  const people = [
    ['A', 'Alice Martin', 'customer'],
    ['B', 'Bruno Petit', 'customer'],
    ['E', 'Eve Team', 'admin'],
  ] as const;
  await rows('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
    c,
    'members',
    JSON.stringify(
      page(
        people.map(([key, name, access]) =>
          member(`mber_${short(c)}${key}`, user(key), {
            access_level: access,
            user: { id: user(key), name, username: null },
          }),
        ),
      ),
    ),
  ]);
  // The names, as Whop's listings give them.
  const named = await rows<{ n: number }>(
    'select stayput.note_whop_places($1, $2, $3::text::jsonb, $4::timestamptz) as n',
    [
      c,
      'chat_channels',
      JSON.stringify(
        page([
          { id: CHAT, experience: { id: 'exp_WdChatExp', name: 'General' } },
          { id: QUIET, experience: { id: 'exp_WdQuietExp', name: 'Announcements' } },
          { id: 'not an id', experience: { name: 'Broken' } },
        ]),
      ),
      NOW,
    ],
  );
  expect(named[0]?.n).toBe(2);
  await rows('select stayput.note_whop_places($1, $2, $3::text::jsonb, $4::timestamptz)', [
    c,
    'forums',
    JSON.stringify(page([{ id: 'forum_WdX', experience: { id: FORUM, name: 'Wins' } }])),
    NOW,
  ]);
  let n = 0;
  const say = async (
    kind: 'messages' | 'forum_posts',
    scope: string,
    key: string,
    when: string[],
  ) =>
    rows('select stayput.ingest_page($1, $2, $3, $4::text::jsonb)', [
      c,
      kind,
      scope,
      JSON.stringify(page(when.map((w) => message(`post_${short(c)}${(n += 1)}`, user(key), w)))),
    ]);
  await say('messages', CHAT, 'A', [at(0, 10), at(0, 10, 5), at(3), at(3, 11)]);
  await say('forum_posts', FORUM, 'A', [at(1)]);
  await say('messages', CHAT, 'B', [at(12), at(40)]);
  await say('forum_posts', FORUM, 'B', [at(13)]);
  await say('messages', CHAT, 'E', [at(0, 11), at(0, 11, 1)]);
  await rows(
    `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                      level_since, computed_at)
     values ($1, $2, 80, 'high', '{}', $3::timestamptz, $3::timestamptz)`,
    [c, `mber_${short(c)}B`, NOW],
  );
  return { id: (key: string) => `mber_${short(c)}${key}` };
}

const read = async <T>(fn: string, args: unknown[], user = OWNER) =>
  (
    await withUser(t.db, user, (tx) => tx.query<{ view: T | null }>(`select ${fn} as view`, args))
  )[0]?.view ?? null;

describe('Integrations › Whop', () => {
  it('counts chat messages and forum posts: who wrote, where and when, the team apart', async () => {
    const c = await community('biz_Wd1');
    const view = await read<PlatformDashboard>(
      'stayput.platform_dashboard($1, $2, $3::timestamptz)',
      ['biz_Wd1', 'whop', NOW],
    );
    expect(view).not.toBeNull();
    expect(view!.platform).toBe('whop');
    // 30 days: Alice's 5, Bruno's 2 (12 and 13 days ago), Eve's 2 (the team).
    expect(view!.hero).toEqual({
      activeMembers7d: 1,
      silentMembers7d: 1,
      messages30d: 9,
      memberMessages30d: 7,
    });
    // Each chat and forum by its name, the busiest first; a quiet chat shows all the same.
    expect(
      view!.places.map((p) => [p.id, p.kind, p.name, p.messages, p.members, p.top.length]),
    ).toEqual([
      [CHAT, 'chat', 'General', 7, 2, 2],
      [FORUM, 'forum', 'Wins', 2, 2, 2],
      [QUIET, 'chat', 'Announcements', 0, 0, 0],
    ]);
    expect(view!.active.d7.map((m) => [m.id, m.messages])).toEqual([[c.id('A'), 5]]);
    expect(view!.silent.d7).toMatchObject({
      total: 1,
      members: [{ id: c.id('B'), level: 'high' }],
    });
    expect(view!.daily).toHaveLength(30);
    expect(view!.daily.at(-1)).toMatchObject({ day: '2026-10-10', messages: 4, members: 2 });
  });

  it('opens a day and an hour of it, and stays the team’s', async () => {
    await community('biz_Wd2');
    const day = await read<PlatformDayView>(
      'stayput.platform_day($1, $2, $3::timestamptz, $4::date)',
      ['biz_Wd2', 'whop', NOW, '2026-10-10'],
    );
    expect(day).toMatchObject({ day: '2026-10-10', messages: 4 });
    expect(day!.places.map((p) => [p.id, p.kind, p.name])).toEqual([[CHAT, 'chat', 'General']]);
    const slot = await read<PlatformSlotView>(
      'stayput.platform_slot($1, $2, $3::timestamptz, $4, $5)',
      ['biz_Wd2', 'whop', NOW, 6, 10],
    );
    // Saturday 10 October, 10 h: Alice's two messages.
    expect(slot).toMatchObject({ dow: 6, hour: 10, messages: 2, others: 0 });
    expect(
      await read(
        'stayput.platform_dashboard($1, $2, $3::timestamptz)',
        ['biz_Wd2', 'whop', NOW],
        'user_stranger',
      ),
    ).toBeNull();
  });

  it('keeps the latest name of a chat, and only for its own community', async () => {
    await community('biz_Wd3');
    await rows('select stayput.note_whop_places($1, $2, $3::text::jsonb, $4::timestamptz)', [
      'biz_Wd3',
      'chat_channels',
      JSON.stringify([{ id: CHAT, experience: { id: 'exp_WdChatExp', name: 'Lounge' } }]),
      NOW,
    ]);
    expect(
      await rows<{ company_id: string; name: string }>(
        `select company_id, name from stayput.whop_places where id = $1 order by company_id`,
        [CHAT],
      ),
    ).toEqual([
      { company_id: 'biz_Wd1', name: 'General' },
      { company_id: 'biz_Wd2', name: 'General' },
      { company_id: 'biz_Wd3', name: 'Lounge' },
    ]);
    // Courses and other listings name nothing here.
    expect(
      (
        await rows<{ n: number }>(
          'select stayput.note_whop_places($1, $2, $3::text::jsonb, $4::timestamptz) as n',
          ['biz_Wd3', 'courses', JSON.stringify(page([{ id: 'cors_X', title: 'Course' }])), NOW],
        )
      )[0]?.n,
    ).toBe(0);
  });
});
