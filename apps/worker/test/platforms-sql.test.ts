import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { member, page } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0007: Discord and Telegram as activity sources. Messages count for the member whose
 * account it is (Discord: linked on Whop; Telegram: linked from StayPut), wait under the account
 * until then, and never keep their content.
 */

const NOW = '2026-10-01T12:00:00Z';
let t: TestDb;
let companies = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function company(): Promise<string> {
  companies += 1;
  const id = `biz_P${companies}`;
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [id, NOW]);
  return id;
}

const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);
const u = (base: string) => `${base}P${companies}`;
/** A Discord id (a snowflake), unique to the current company. */
const snowflake = (n: number) => `${100000 + companies}${String(n).padStart(6, '0')}`;

/** A Discord message as `GET /channels/{id}/messages` returns it. */
const discordMessage = (id: string, author: string, at: string, over = {}) => ({
  id,
  type: 0,
  timestamp: at,
  content: 'never stored',
  author: { id: author, username: 'someone', bot: false },
  ...over,
});

async function ingest(c: string, kind: string, body: unknown, scope: string | null = null) {
  const [row] = await rows<{ result: Record<string, unknown> }>(
    'select stayput.ingest_page($1, $2, $3, $4::text::jsonb) as result',
    [c, kind, scope, JSON.stringify(body)],
  );
  return row?.result ?? {};
}

/** The Whop user of a member, with the accounts Whop shows of them. */
const whopUser = (id: string, socials: { platform: string; external_id: string }[]) => ({
  id,
  username: 'someone',
  email: 'someone@mail.test',
  social_accounts: socials.map((s) => ({ ...s, username: 'someone', verified: true })),
});

async function link(c: string, user: unknown) {
  const [row] = await rows<{ linked: boolean }>(
    'select stayput.link_member_discord($1, $2::text::jsonb, $3::timestamptz) as linked',
    [c, JSON.stringify(user), NOW],
  );
  return row?.linked;
}

async function linkTelegram(c: string, user: string, telegram: string) {
  const [row] = await rows<{ status: string }>(
    'select stayput.link_telegram_member($1, $2, $3, $4::timestamptz) as status',
    [c, user, telegram, NOW],
  );
  return row?.status;
}

describe('Discord', () => {
  it("reads a channel's page, counts people's messages, and keeps none of their words", async () => {
    const c = await company();
    await ingest(c, 'members', page([member(u('mber_A'), u('user_A'))]));
    await link(c, whopUser(u('user_A'), [{ platform: 'discord', external_id: snowflake(1) }]));

    const result = await ingest(
      c,
      'discord_messages',
      [
        discordMessage(snowflake(103), snowflake(1), '2026-09-30T18:00:00.000000+00:00'),
        discordMessage(snowflake(102), snowflake(2), '2026-09-30T17:00:00.000000+00:00'),
        discordMessage(snowflake(101), snowflake(9), '2026-09-30T16:00:00+00:00', {
          author: { id: snowflake(9), bot: true },
        }),
        discordMessage(snowflake(100), snowflake(1), '2026-09-30T15:00:00+00:00', { type: 7 }),
      ],
      '5551234567',
    );
    expect(result).toMatchObject({
      count: 4,
      stored: 1,
      end_cursor: snowflake(100),
      has_next_page: false,
      newest_at: '2026-09-30T18:00:00+00:00',
    });
    expect(
      await rows(
        'select member_id, type, external_id, metadata from stayput.activity_events where company_id = $1',
        [c],
      ),
    ).toEqual([
      {
        member_id: u('mber_A'),
        type: 'discord_message',
        external_id: snowflake(103),
        metadata: { channel_id: '5551234567' },
      },
    ]);
    // The author no member linked yet waits under their Discord account.
    expect(
      await rows('select user_id, type from stayput.pending_activity where company_id = $1', [c]),
    ).toEqual([{ user_id: `discord:${snowflake(2)}`, type: 'discord_message' }]);
    expect(
      await rows(
        `select 1 from stayput.activity_events where company_id = $1
            and metadata::text like '%never stored%'`,
        [c],
      ),
    ).toEqual([]);
  });

  it('says a full page of 100 messages may have more behind it', async () => {
    const c = await company();
    const messages = Array.from({ length: 100 }, (_, i) =>
      discordMessage(snowflake(1000 - i), snowflake(5), `2026-09-${10 + (i % 20)}T10:00:00Z`),
    );
    expect(await ingest(c, 'discord_messages', messages, '5551234567')).toMatchObject({
      count: 100,
      end_cursor: snowflake(901),
      has_next_page: true,
    });
  });

  it('follows the channels a creator chooses, one stream each', async () => {
    const a = await company();
    const guild = snowflake(77);
    const connect = async (c: string, user: string) =>
      (
        await rows<{ followed: number }>(
          'select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz) as followed',
          [c, guild, 'Server A', user, NOW],
        )
      )[0]?.followed;
    expect(await connect(a, 'user_owner')).toBe(0);
    const choose = async (c: string, channels: string) =>
      (
        await rows<{ n: number }>('select stayput.set_discord_channels($1, $2, $3) as n', [
          c,
          guild,
          channels,
        ])
      )[0]?.n;
    const streams = async (c: string) =>
      (
        await rows<{ stream: string }>(
          `select stream from stayput.sync_state
            where company_id = $1 and stream like 'discord%' order by stream`,
          [c],
        )
      ).map((r) => r.stream);

    // The server's member list is a stream of its own (0017), the channels one each.
    const members = `discord_members:${guild}`;
    expect(await choose(a, '111111,222222,not-an-id,111111')).toBe(2);
    expect(await streams(a)).toEqual([
      members,
      'discord_messages:111111',
      'discord_messages:222222',
    ]);
    expect(await choose(a, '222222,333333')).toBe(2);
    expect(await streams(a)).toEqual([
      members,
      'discord_messages:222222',
      'discord_messages:333333',
    ]);
    // Connecting it again (the bot was added back) keeps the choice.
    expect(await connect(a, 'user_owner')).toBe(2);

    // A channel deleted on Discord (404) is no longer followed.
    await t.db.query(
      "select stayput.sync_error($1, 'discord_messages:333333', $2::timestamptz, 404, 'gone')",
      [a, NOW],
    );
    expect(await streams(a)).toEqual([members, 'discord_messages:222222']);
    expect(
      await rows('select channel_ids from stayput.discord_guilds where guild_id = $1', [guild]),
    ).toEqual([{ channel_ids: '{222222}' }]);

    // Another company connects the same server: it moves, and leaves no stream behind.
    const b = await company();
    expect(await connect(b, 'user_other')).toBe(0);
    expect(await streams(a)).toEqual([]);
    await expect(choose(a, '444444')).rejects.toThrow(/not connected/);
    expect(
      await rows('select company_id, channel_ids from stayput.discord_guilds where guild_id = $1', [
        guild,
      ]),
    ).toEqual([{ company_id: b, channel_ids: '{}' }]);

    await choose(b, '555555');
    expect(
      (
        await rows<{ gone: boolean }>('select stayput.disconnect_discord_guild($1, $2) as gone', [
          b,
          guild,
        ])
      )[0]?.gone,
    ).toBe(true);
    expect(await streams(b)).toEqual([]);
  });
});

describe('Telegram', () => {
  it("counts a connected group's messages, until the bot is removed", async () => {
    const c = await company();
    const chat = `-100${companies}0042`;
    await ingest(c, 'members', page([member(u('mber_T'), u('user_T'))]));
    expect(await linkTelegram(c, u('user_T'), '700123')).toBe('linked');
    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      c,
      chat,
      'Group',
      NOW,
    ]);
    const message = async (from: string, id: string) =>
      (
        await rows<{ ok: boolean }>(
          'select stayput.record_telegram_message($1, $2, $3, $4::timestamptz) as ok',
          [chat, from, id, '2026-09-30T20:00:00Z'],
        )
      )[0]?.ok;

    expect(await message('700123', '1')).toBe(true);
    expect(await message('700999', '2')).toBe(false);
    expect(
      await rows(
        'select type, external_id, metadata from stayput.activity_events where company_id = $1',
        [c],
      ),
    ).toEqual([
      { type: 'telegram_message', external_id: `${chat}:1`, metadata: { chat_id: chat } },
    ]);
    expect(
      await rows('select user_id from stayput.pending_activity where company_id = $1', [c]),
    ).toEqual([{ user_id: 'telegram:700999' }]);

    await t.db.query('select stayput.telegram_chat_membership($1, false, $2::timestamptz)', [
      chat,
      NOW,
    ]);
    expect(await message('700123', '3')).toBe(false);
    await t.db.query('select stayput.telegram_chat_membership($1, true, $2::timestamptz)', [
      chat,
      NOW,
    ]);
    expect(await message('700123', '4')).toBe(true);
  });
});

describe('linking members to their accounts', () => {
  it('reads only the Discord of a Whop profile, and unlinks it when the member did', async () => {
    const c = await company();
    await ingest(c, 'members', page([member(u('mber_D'), u('user_D'))]));
    expect(
      await link(
        c,
        whopUser(u('user_D'), [
          { platform: 'x', external_id: '42' },
          { platform: 'discord', external_id: snowflake(8) },
        ]),
      ),
    ).toBe(true);
    expect(await linkTelegram(c, u('user_D'), '900123')).toBe('linked');
    // Unlinked on Whop: StayPut forgets the Discord account, the Telegram one stays.
    expect(await link(c, whopUser(u('user_D'), []))).toBe(false);
    expect(
      await rows('select discord_user_id, telegram_user_id from stayput.members where id = $1', [
        u('mber_D'),
      ]),
    ).toEqual([{ discord_user_id: null, telegram_user_id: '900123' }]);
  });

  it('files the activity waiting under an account once the member links it on Whop', async () => {
    const c = await company();
    await ingest(c, 'members', page([member(u('mber_L'), u('user_L'))]));
    await ingest(
      c,
      'discord_messages',
      [discordMessage(snowflake(201), snowflake(3), '2026-09-29T10:00:00Z')],
      '5550001',
    );
    expect(await link(c, whopUser(u('user_L'), []))).toBe(false);
    expect(await rows('select 1 from stayput.activity_events where company_id = $1', [c])).toEqual(
      [],
    );

    expect(
      await link(c, whopUser(u('user_L'), [{ platform: 'discord', external_id: snowflake(3) }])),
    ).toBe(true);
    expect(
      await rows(
        'select member_id, external_id from stayput.activity_events where company_id = $1',
        [c],
      ),
    ).toEqual([{ member_id: u('mber_L'), external_id: snowflake(201) }]);
    expect(await rows('select 1 from stayput.pending_activity where company_id = $1', [c])).toEqual(
      [],
    );
    expect(
      await rows(`select discord_user_id, discord_checked_at from stayput.members where id = $1`, [
        u('mber_L'),
      ]),
    ).toEqual([{ discord_user_id: snowflake(3), discord_checked_at: new Date(NOW) }]);
  });

  it('links a Telegram account the member opened the bot with, and unlinks it', async () => {
    const c = await company();
    await ingest(
      c,
      'members',
      page([member(u('mber_G'), u('user_G')), member(u('mber_H'), u('user_H'))]),
    );
    const chat = `-100${companies}0007`;
    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      c,
      chat,
      'Group',
      NOW,
    ]);
    await t.db.query('select stayput.record_telegram_message($1, $2, $3, $4::timestamptz)', [
      chat,
      '600555',
      '1',
      '2026-09-30T09:00:00Z',
    ]);
    expect(await linkTelegram(c, 'user_unknown', '600555')).toBe('no_member');
    expect(await linkTelegram(c, u('user_G'), '600555')).toBe('linked');
    expect(
      await rows('select member_id from stayput.activity_events where company_id = $1', [c]),
    ).toEqual([{ member_id: u('mber_G') }]);
    // The same account linked by another member moves to them.
    expect(await linkTelegram(c, u('user_H'), '600555')).toBe('linked');
    expect(
      await rows(
        'select id, telegram_user_id from stayput.members where company_id = $1 order by id',
        [c],
      ),
    ).toEqual([
      { id: u('mber_G'), telegram_user_id: null },
      { id: u('mber_H'), telegram_user_id: '600555' },
    ]);
    await expect(linkTelegram(c, u('user_H'), 'not-a-number')).rejects.toThrow(/Telegram/);
    const unlink = async () =>
      (
        await rows<{ done: boolean }>('select stayput.unlink_telegram_member($1, $2) as done', [
          c,
          u('user_H'),
        ])
      )[0]?.done;
    expect(await unlink()).toBe(true);
    expect(await unlink()).toBe(false);
  });

  it('gives an account to one member only, the last one who linked it', async () => {
    const c = await company();
    await ingest(
      c,
      'members',
      page([member(u('mber_X'), u('user_X')), member(u('mber_Y'), u('user_Y'))]),
    );
    const account = [{ platform: 'discord', external_id: snowflake(4) }];
    await link(c, whopUser(u('user_X'), account));
    await link(c, whopUser(u('user_Y'), account));
    expect(
      await rows(
        'select id, discord_user_id from stayput.members where company_id = $1 order by id',
        [c],
      ),
    ).toEqual([
      { id: u('mber_X'), discord_user_id: null },
      { id: u('mber_Y'), discord_user_id: snowflake(4) },
    ]);
  });

  it('reads Whop profiles only for a company that connected a Discord server', async () => {
    const c = await company();
    await ingest(
      c,
      'members',
      page([member(u('mber_1'), u('user_1')), member(u('mber_2'), u('user_2'))]),
    );
    const due = async () =>
      (
        await rows<{ id: string }>(
          'select stayput.members_to_link($1, $2::timestamptz, 10) as id',
          [c, NOW],
        )
      ).map((r) => r.id);
    expect(await due()).toEqual([]);
    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      c,
      `-100${companies}0001`,
      null,
      NOW,
    ]);
    // Whop shows no one's Telegram: a Telegram group alone needs no profile.
    expect(await due()).toEqual([]);
    await t.db.query('select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz)', [
      c,
      snowflake(1),
      'S',
      'user_owner',
      NOW,
    ]);
    expect((await due()).sort()).toEqual([u('user_1'), u('user_2')]);
    await t.db.query('select stayput.mark_discord_checked($1, $2, $3::timestamptz)', [
      c,
      u('user_1'),
      NOW,
    ]);
    expect(await due()).toEqual([u('user_2')]);
  });
});

describe('statistics', () => {
  it('counts Discord and Telegram messages with the others', async () => {
    const c = await company();
    await ingest(c, 'members', page([member(u('mber_S'), u('user_S'))]));
    await link(c, whopUser(u('user_S'), [{ platform: 'discord', external_id: snowflake(6) }]));
    await linkTelegram(c, u('user_S'), '800123');
    await ingest(
      c,
      'discord_messages',
      [discordMessage(snowflake(301), snowflake(6), '2026-09-30T10:00:00Z')],
      '5550002',
    );
    const chat = `-100${companies}0003`;
    await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
      c,
      chat,
      'G',
      NOW,
    ]);
    await t.db.query('select stayput.record_telegram_message($1, $2, $3, $4::timestamptz)', [
      chat,
      '800123',
      '9',
      '2026-09-30T11:00:00Z',
    ]);
    await t.db.query('select stayput.refresh_stats($1::timestamptz, $2)', [NOW, c]);
    expect(
      await rows(
        'select day::text, messages from stayput.member_stats_daily where company_id = $1',
        [c],
      ),
    ).toEqual([{ day: '2026-09-30', messages: 2 }]);
  });
});
