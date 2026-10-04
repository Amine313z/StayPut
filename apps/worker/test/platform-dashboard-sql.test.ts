import type { PlatformDashboard, PlatformDayView, PlatformSlotView } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/db';
import { scoreCompany } from '../src/risk';
import { member, page } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0033 (fix prompt v4.1, block 7; brief v4 §9.6): Integrations › Discord and ›
 * Telegram, each a dashboard, from who wrote, where and when; the platforms' signals in the
 * score; the channels' and topics' names.
 */

const NOW = '2026-10-04T12:00:00Z';
const DAY = 86_400_000;
/** `days` before NOW, at this hour (UTC). */
const at = (days: number, hour = 10, minute = 0) => {
  const moment = new Date(Date.parse(NOW) - days * DAY);
  moment.setUTCHours(hour, minute, 0, 0);
  return moment.toISOString();
};

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);

let servers = 0;
/** A company's id without its prefix: members' and users' ids take no underscore after theirs. */
const short = (c: string) => c.replace(/^biz_/, '');
const GENERAL = '960000000000000011';
const WINS = '960000000000000012';
const QUIET = '960000000000000013';
const OWNER = 'user_PdOwner';

/**
 * A community with a Discord server (three channels followed, named) and five members: Alice
 * writes a lot, Bruno (high risk) went quiet 12 days ago, Chloé (medium) 20 days ago, Dan
 * (leaving) 60 days ago; Eve is the team. An account no member has yet wrote today.
 */
async function community(c: string) {
  // A server of its own: a server belongs to one company.
  const GUILD = String(960000000000000000n + BigInt(++servers * 100));
  await rows('select stayput.ensure_company($1, $2::timestamptz)', [c, NOW]);
  await rows(`update stayput.companies set timezone = 'UTC' where id = $1`, [c]);
  await rows(
    `insert into stayput.company_admins (company_id, user_id, verified_at) values ($1, $2, now())`,
    [c, OWNER],
  );
  const people = [
    ['A', 'Alice Martin', 'customer'],
    ['B', 'Bruno Petit', 'customer'],
    ['C', 'Chloé Dubois', 'customer'],
    ['D', 'Dan Roy', 'customer'],
    ['E', 'Eve Team', 'admin'],
  ] as const;
  await rows('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
    c,
    'members',
    JSON.stringify(
      page(
        people.map(([key, name, access]) =>
          member(`mber_${short(c)}${key}`, `user_${short(c)}${key}`, {
            access_level: access,
            user: { id: `user_${short(c)}${key}`, name, username: null },
          }),
        ),
      ),
    ),
  ]);
  const discordOf = (key: string) => `97000000000000000${'ABCDE'.indexOf(key)}`;
  for (const [key] of people) {
    await rows('update stayput.members set discord_user_id = $1 where id = $2', [
      discordOf(key),
      `mber_${short(c)}${key}`,
    ]);
  }
  await rows('select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz)', [
    c,
    GUILD,
    'Atlas',
    OWNER,
    NOW,
  ]);
  await rows('select stayput.set_discord_channels($1, $2, $3)', [
    c,
    GUILD,
    [GENERAL, WINS, QUIET].join(','),
  ]);
  await rows('select stayput.note_discord_channels($1, $2, $3::text::jsonb, $4::timestamptz)', [
    c,
    GUILD,
    JSON.stringify([
      { id: GENERAL, name: 'general', category: 'Community' },
      { id: WINS, name: 'wins', category: 'Community' },
      { id: QUIET, name: 'quiet', category: null },
    ]),
    NOW,
  ]);
  let sequence = 0;
  /** Messages in a channel: by a member's key (A–E), or by an account no member has. */
  const say = async (channel: string, who: string, times: string[]) => {
    const author =
      who.length === 1
        ? { id: discordOf(who), username: who.toLowerCase(), global_name: null }
        : { id: '980000000000000009', username: 'zed', global_name: who };
    await rows('select stayput.ingest_page($1, $2, $3, $4::text::jsonb)', [
      c,
      'discord_messages',
      channel,
      JSON.stringify(
        times.map((timestamp) => ({
          id: String(990000000000000000n + BigInt(++sequence)),
          type: 0,
          timestamp,
          content: 'never stored',
          author,
        })),
      ),
    ]);
  };
  await say(GENERAL, 'A', [at(0, 10, 0), at(0, 10, 5), at(0, 10, 10), at(3), at(3, 11)]);
  await say(WINS, 'A', [at(10)]);
  await say(GENERAL, 'B', [at(12), at(12, 14), at(40)]);
  await say(WINS, 'C', [at(20)]);
  await say(GENERAL, 'D', [at(60)]);
  await say(GENERAL, 'E', [at(0, 11), at(0, 11, 1), at(0, 11, 2), at(0, 11, 3)]);
  await say(GENERAL, 'Zed Unknown', [at(0, 10, 30)]);
  const risk = async (key: string, score: number, level: string, signals: unknown = {}) =>
    rows(
      `insert into stayput.member_risk (company_id, member_id, score, level, sub_scores,
                                        level_since, computed_at, signals)
       values ($1, $2, $3, $4, '{}', $5::timestamptz, $5::timestamptz, $6::text::jsonb)`,
      [c, `mber_${short(c)}${key}`, score, level, NOW, JSON.stringify(signals)],
    );
  await risk('A', 10, 'low', { base: 10, discord: 0, telegram: 0, rule: 0 });
  await risk('B', 80, 'high', { base: 70, discord: 1, telegram: 0, rule: 0 });
  await risk('C', 50, 'medium');
  await risk('D', 100, 'scheduled_departure', { base: 40, discord: 1, telegram: 0, rule: 1 });
  return { id: (key: string) => `mber_${short(c)}${key}`, guild: GUILD };
}

const read = async <T>(fn: string, args: unknown[], user = OWNER) =>
  (
    await withUser(t.db, user, (tx) => tx.query<{ view: T | null }>(`select ${fn} as view`, args))
  )[0]?.view ?? null;

describe('a platform’s dashboard', () => {
  it('counts who wrote, where and when, the team and the accounts not tied apart', async () => {
    const { id } = await community('biz_Pd1');
    const view = await read<PlatformDashboard>(
      'stayput.platform_dashboard($1, $2, $3::timestamptz)',
      ['biz_Pd1', 'discord', NOW],
    );
    expect(view).not.toBeNull();
    expect(view!.from).toBe('2026-09-05');
    expect(view!.to).toBe('2026-10-04');
    expect(view!.hero).toEqual({
      activeMembers7d: 1,
      silentMembers7d: 3,
      messages30d: 14,
      memberMessages30d: 9,
    });
    // Each of the 30 days: everyone's messages, the members', the members' at risk today.
    expect(view!.daily).toHaveLength(30);
    const day = (d: string) => view!.daily.find((x) => x.day === d);
    expect(day('2026-10-04')).toEqual({ day: '2026-10-04', messages: 8, members: 3, atRisk: 0 });
    expect(day('2026-09-22')).toEqual({ day: '2026-09-22', messages: 2, members: 2, atRisk: 2 });
    expect(view!.daily.reduce((n, d) => n + d.messages, 0)).toBe(14);
    // When: today (a Sunday) at 10 (Alice ×3, the account not tied) and 11 (the team ×4).
    expect(view!.heatmap).toContainEqual({ dow: 7, hour: 10, messages: 4, members: 1 });
    expect(view!.heatmap).toContainEqual({ dow: 7, hour: 11, messages: 4, members: 0 });
    expect(view!.heatmap.reduce((n, c) => n + c.messages, 0)).toBe(14);
    // Where: each followed channel by name, the quiet one too; its 3 most active members.
    expect(view!.places).toEqual([
      {
        id: GENERAL,
        kind: 'channel',
        name: 'general',
        parent: 'Atlas',
        messages: 12,
        members: 2,
        lastAt: expect.any(String) as string,
        top: [
          { id: id('A'), name: 'Alice Martin', messages: 5 },
          { id: id('B'), name: 'Bruno Petit', messages: 2 },
        ],
      },
      {
        id: WINS,
        kind: 'channel',
        name: 'wins',
        parent: 'Atlas',
        messages: 2,
        members: 2,
        lastAt: expect.any(String) as string,
        top: [
          { id: id('A'), name: 'Alice Martin', messages: 1 },
          { id: id('C'), name: 'Chloé Dubois', messages: 1 },
        ],
      },
      {
        id: QUIET,
        kind: 'channel',
        name: 'quiet',
        parent: 'Atlas',
        messages: 0,
        members: 0,
        lastAt: null,
        top: [],
      },
    ]);
  });

  it('lists the most active and the silent members over 7, 14 and 30 days', async () => {
    const { id } = await community('biz_Pd2');
    const view = await read<PlatformDashboard>(
      'stayput.platform_dashboard($1, $2, $3::timestamptz)',
      ['biz_Pd2', 'discord', NOW],
    );
    const names = (list: { id: string; messages: number }[]) =>
      list.map((m) => `${m.id.slice(-1)}${m.messages}`);
    expect(names(view!.active.d7)).toEqual(['A5']);
    expect(names(view!.active.d14)).toEqual(['A6', 'B2']);
    expect(names(view!.active.d30)).toEqual(['A6', 'B2', 'C1']);
    expect(view!.active.d7[0]).toMatchObject({ id: id('A'), score: 10, level: 'low' });
    // Silent: wrote there over 90 days, not over the window; the riskiest first.
    expect(view!.silent.d7.total).toBe(3);
    expect(names(view!.silent.d7.members)).toEqual(['D1', 'B3', 'C1']);
    expect(view!.silent.d7.members[0]).toMatchObject({ level: 'scheduled_departure' });
    expect(view!.silent.d14.total).toBe(2);
    expect(names(view!.silent.d14.members)).toEqual(['D1', 'C1']);
    expect(view!.silent.d30).toEqual({
      total: 1,
      members: [expect.objectContaining({ id: id('D') })],
    });
  });

  it('gives the signals’ settings and the scores as made, for the preview', async () => {
    await community('biz_Pd3');
    const view = await read<PlatformDashboard>(
      'stayput.platform_dashboard($1, $2, $3::timestamptz)',
      ['biz_Pd3', 'discord', NOW],
    );
    expect(view!.signals).toEqual({
      settings: {},
      mediumFrom: 40,
      highFrom: 70,
      // [base, discord, telegram, rule, how many]: a score not made yet counts as its base.
      groups: [
        [10, 0, 0, 0, 1],
        [40, 1, 0, 1, 1],
        [50, 0, 0, 0, 1],
        [70, 1, 0, 0, 1],
      ],
    });
  });

  it('answers the company’s team only, and a platform it knows', async () => {
    await community('biz_Pd4');
    const args = ['biz_Pd4', 'discord', NOW];
    expect(
      await read('stayput.platform_dashboard($1, $2, $3::timestamptz)', args, 'user_stranger'),
    ).toBeNull();
    expect(
      await read('stayput.platform_dashboard($1, $2, $3::timestamptz)', ['biz_Pd4', 'irc', NOW]),
    ).toBeNull();
    expect(
      await read(
        'stayput.platform_day($1, $2, $3::timestamptz, $4::date)',
        [...args, '2026-10-04'],
        'user_stranger',
      ),
    ).toBeNull();
  });
});

describe('a day and an hour, picked', () => {
  it('gives a day’s places and the members who wrote that day', async () => {
    const { id } = await community('biz_Pd5');
    const view = await read<PlatformDayView>(
      'stayput.platform_day($1, $2, $3::timestamptz, $4::date)',
      ['biz_Pd5', 'discord', NOW, '2026-10-04'],
    );
    expect(view).toEqual({
      day: '2026-10-04',
      messages: 8,
      places: [
        expect.objectContaining({
          id: GENERAL,
          name: 'general',
          messages: 8,
          members: 1,
          top: [{ id: id('A'), name: 'Alice Martin', messages: 3 }],
        }),
      ],
      active: [expect.objectContaining({ id: id('A'), messages: 3, score: 10 })],
    });
  });

  it('gives who wrote in a cell of the heatmap, in the company’s time zone', async () => {
    const { id } = await community('biz_Pd6');
    const slot = (dow: number, hour: number) =>
      read<PlatformSlotView>('stayput.platform_slot($1, $2, $3::timestamptz, $4, $5)', [
        'biz_Pd6',
        'discord',
        NOW,
        dow,
        hour,
      ]);
    expect(await slot(7, 10)).toEqual({
      dow: 7,
      hour: 10,
      messages: 4,
      others: 1,
      members: [expect.objectContaining({ id: id('A'), messages: 3 })],
    });
    expect(await slot(7, 11)).toMatchObject({ messages: 4, others: 4, members: [] });
    // In Paris (UTC+2 in October), Alice's 10:00 is noon.
    await rows(`update stayput.companies set timezone = 'Europe/Paris' where id = 'biz_Pd6'`);
    expect(await slot(7, 12)).toMatchObject({ messages: 4, others: 1 });
    expect(await slot(7, 10)).toMatchObject({ messages: 0, members: [] });
  });
});

describe('Telegram’s groups and topics', () => {
  it('counts a forum group’s topics by name, and its messages outside them', async () => {
    const c = 'biz_Pd7';
    const chat = '-1007770001';
    await rows('select stayput.ensure_company($1, $2::timestamptz)', [c, NOW]);
    await rows(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, $2, now())`,
      [c, OWNER],
    );
    await rows('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      c,
      chat,
      'VIP',
      at(5),
    ]);
    const say = (id: string, topic: string | null, when: string) =>
      rows('select stayput.record_telegram_message($1, $2, $3, $4::timestamptz, $5, $6, $7)', [
        chat,
        '5550001',
        id,
        when,
        'Nora',
        null,
        topic,
      ]);
    await say('1', '42', at(1));
    await say('2', '42', at(1, 11));
    await say('3', null, at(2));
    // A topic id that is not one is left out.
    await say('4', 'x', at(2, 12));
    expect(
      await rows<{ metadata: unknown }>(
        `select metadata from stayput.pending_activity where company_id = $1
          order by occurred_at desc`,
        [c],
      ),
    ).toEqual([
      { metadata: { chat_id: chat, topic_id: '42' } },
      { metadata: { chat_id: chat, topic_id: '42' } },
      { metadata: { chat_id: chat } },
      { metadata: { chat_id: chat } },
    ]);
    // Its name, from the message that created it; a later edit renames it.
    expect(
      await rows<{ ok: boolean }>(
        'select stayput.note_telegram_topic($1, $2, $3, $4::timestamptz) as ok',
        [chat, '42', 'Signals', at(1)],
      ),
    ).toEqual([{ ok: true }]);
    await rows('select stayput.note_telegram_topic($1, $2, $3, $4::timestamptz)', [
      chat,
      '42',
      '  Daily signals ',
      at(0),
    ]);
    // A group not connected: nothing.
    expect(
      await rows<{ ok: boolean }>(
        'select stayput.note_telegram_topic($1, $2, $3, $4::timestamptz) as ok',
        ['-1009990001', '1', 'X', at(0)],
      ),
    ).toEqual([{ ok: false }]);
    const view = await read<PlatformDashboard>(
      'stayput.platform_dashboard($1, $2, $3::timestamptz)',
      [c, 'telegram', NOW],
    );
    expect(view!.places.map((p) => [p.id, p.kind, p.name, p.parent, p.messages])).toEqual([
      [`${chat}:42`, 'topic', 'Daily signals', 'VIP', 2],
      [`${chat}:`, 'general', 'VIP', null, 2],
    ]);
    expect(view!.hero).toMatchObject({ messages30d: 4, memberMessages30d: 0 });
  });
});

describe('the platforms’ signals in the score', () => {
  it('keeps a platform’s settings checked, and makes every score due again', async () => {
    await community('biz_Pd8');
    const signals = {
      silent: { on: true, points: 15 },
      drop: { on: false, points: 5 },
      left: { on: true, points: 30 },
    };
    const save = (platform: string, value: unknown) =>
      rows<{ saved: unknown }>(
        'select stayput.set_platform_signals($1, $2, $3::text::jsonb, $4::timestamptz) as saved',
        ['biz_Pd8', platform, JSON.stringify(value), NOW],
      );
    expect(await save('discord', signals)).toEqual([{ saved: { discord: signals } }]);
    expect(await save('telegram', { ...signals, silent: { on: false, points: 0 } })).toEqual([
      { saved: { discord: signals, telegram: { ...signals, silent: { on: false, points: 0 } } } },
    ]);
    for (const wrong of [
      { ...signals, left: { on: true, points: 31 } },
      { ...signals, left: { on: true, points: 2.5 } },
      { ...signals, left: { on: 'yes', points: 5 } },
      { silent: signals.silent },
    ]) {
      await expect(save('discord', wrong)).rejects.toThrow(/signal/);
    }
    await expect(save('irc', signals)).rejects.toThrow(/platform/);
    expect(
      await rows<{ due: boolean }>(
        `select bool_and(computed_at <= $2::timestamptz - interval '1 hour') as due
           from stayput.member_risk where company_id = $1`,
        ['biz_Pd8', NOW],
      ),
    ).toEqual([{ due: true }]);
    const view = await read<PlatformDashboard>(
      'stayput.platform_dashboard($1, $2, $3::timestamptz)',
      ['biz_Pd8', 'discord', NOW],
    );
    expect(view!.signals.settings).toEqual({
      discord: signals,
      telegram: { ...signals, silent: { on: false, points: 0 } },
    });
  });

  it('gives each member’s messages there, and when they left', async () => {
    const { id, guild: GUILD } = await community('biz_Pd9');
    // Bruno left the server: its member list, read to its end, no longer has him.
    await rows('select stayput.note_presence($1, $2, $3, $4, null, null, null, $5::timestamptz)', [
      'biz_Pd9',
      'discord',
      GUILD,
      '970000000000000001',
      at(30),
    ]);
    await rows('select stayput.note_presence($1, $2, $3, $4, null, null, null, $5::timestamptz)', [
      'biz_Pd9',
      'discord',
      GUILD,
      '970000000000000000',
      at(30),
    ]);
    await rows('select stayput.discord_roster_start($1, $2)', ['biz_Pd9', GUILD]);
    await rows('select stayput.note_presence($1, $2, $3, $4, null, null, null, $5::timestamptz)', [
      'biz_Pd9',
      'discord',
      GUILD,
      '970000000000000000',
      at(1),
    ]);
    await rows('select stayput.discord_roster_end($1, $2, $3::timestamptz)', [
      'biz_Pd9',
      GUILD,
      at(2),
    ]);
    await rows('delete from stayput.member_risk where company_id = $1', ['biz_Pd9']);
    const [data] = await rows<{ data: { settings: unknown; members: unknown[][] } }>(
      'select stayput.risk_features($1, $2::timestamptz, 100) as data',
      ['biz_Pd9', NOW],
    );
    const of = (key: string) => data!.data.members.find((m) => m[0] === id(key))!.slice(14);
    const ms = (iso: string) => Date.parse(iso);
    // [discord: week, before, last, left; telegram: the same]
    expect(of('A')).toEqual([5, 1, ms(at(0, 10, 10)), null, 0, 0, null, null]);
    expect(of('B')).toEqual([0, 2, ms(at(12, 14)), ms(at(2)), 0, 0, null, null]);
    expect(of('C')).toEqual([0, 1, ms(at(20)), null, 0, 0, null, null]);
    expect(of('D')).toEqual([0, 0, null, null, 0, 0, null, null]);
    expect(data!.data.settings).toMatchObject({ platformSignals: {} });
  });

  it('scores with the signals turned on: their points, their reason, their making', async () => {
    const { id } = await community('biz_Pd12');
    await rows('delete from stayput.member_risk where company_id = $1', ['biz_Pd12']);
    const scored = async () =>
      Object.fromEntries(
        (
          await rows<{ member_id: string; score: number; reasons: unknown; signals: unknown }>(
            `select member_id, score, reasons, signals from stayput.member_risk
              where company_id = $1`,
            ['biz_Pd12'],
          )
        ).map((r) => [r.member_id, r]),
      );
    expect(await scoreCompany(t.db, 'biz_Pd12', new Date(NOW))).toBe(4);
    const before = await scored();
    // Bruno wrote twice 12 days ago, nothing this week: gone quiet, off for now.
    expect(before[id('B')]!.signals).toMatchObject({ discord: 1, telegram: 0, rule: 0 });
    await rows('select stayput.set_platform_signals($1, $2, $3::text::jsonb, $4::timestamptz)', [
      'biz_Pd12',
      'discord',
      JSON.stringify({
        silent: { on: true, points: 20 },
        drop: { on: false, points: 5 },
        left: { on: false, points: 20 },
      }),
      NOW,
    ]);
    expect(await scoreCompany(t.db, 'biz_Pd12', new Date(NOW))).toBe(4);
    const after = await scored();
    expect(after[id('B')]!.score).toBe(before[id('B')]!.score + 20);
    // Inactive everywhere already says he went quiet on Discord: said once.
    expect(after[id('B')]!.reasons).toEqual([{ code: 'inactive', days: 11 }]);
    // Alice writes there every day: nothing changes for her.
    expect(after[id('A')]!.score).toBe(before[id('A')]!.score);
  });

  it('keeps what each score was made of beside it', async () => {
    const { id } = await community('biz_Pd10');
    const making = { base: 55, discord: 4, telegram: 0, rule: 0 };
    await rows('select stayput.save_risk_scores($1, $2::text::jsonb, $3::timestamptz)', [
      'biz_Pd10',
      JSON.stringify([
        [
          id('A'),
          75,
          'high',
          [1, 1, 0, 0, 0],
          [{ code: 'platform_left', platform: 'discord' }],
          false,
          making,
        ],
        // An older Worker sends six elements: nothing beside the score.
        [id('C'), 20, 'low', [0, 0, 0, 0, 0], [], false],
      ]),
      NOW,
    ]);
    expect(
      await rows<{ member_id: string; signals: unknown }>(
        `select member_id, signals from stayput.member_risk
          where company_id = $1 and member_id = any (array[$2, $3]) order by member_id`,
        ['biz_Pd10', id('A'), id('C')],
      ),
    ).toEqual([
      { member_id: id('A'), signals: making },
      { member_id: id('C'), signals: {} },
    ]);
  });
});

describe('the channels’ names', () => {
  it('replaces a server’s names, and only for its company', async () => {
    const { guild: GUILD } = await community('biz_Pd11');
    const note = (company: string, channels: unknown) =>
      rows<{ n: number }>(
        'select stayput.note_discord_channels($1, $2, $3::text::jsonb, $4::timestamptz) as n',
        [company, GUILD, JSON.stringify(channels), NOW],
      );
    expect(
      await note('biz_Pd11', [
        { id: GENERAL, name: 'général', category: null },
        { id: 'not-a-channel', name: 'x' },
        { id: WINS, name: '' },
      ]),
    ).toEqual([{ n: 1 }]);
    expect(
      await rows(`select channel_names from stayput.discord_guilds where guild_id = $1`, [GUILD]),
    ).toEqual([{ channel_names: { [GENERAL]: { name: 'général' } } }]);
    expect(await note('biz_Pd1', [{ id: GENERAL, name: 'x' }])).toEqual([{ n: 0 }]);
  });
});
