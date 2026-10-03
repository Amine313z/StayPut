import type { PeopleView, PlatformActivityView } from '@stayput/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '../src/db';
import { member, page } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0012: the Discord and Telegram accounts StayPut saw writing join their member by
 * name when one member surely matches, or by the creator's choice; their activity waits 30 days;
 * the weekly reading of Whop profiles never undoes a link it did not make.
 */

const NOW = '2026-10-01T12:00:00Z';
let t: TestDb;
let companies = 0;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const rows = <T>(sql: string, params: unknown[] = []) => t.db.query<T>(sql, params);

/** A company with a Telegram group, its members named as given (Whop name and username). */
async function community(people: { name: string; username?: string }[]) {
  companies += 1;
  const c = `biz_Acc${companies}`;
  const chat = `-100${companies}0077`;
  await t.db.query('select stayput.ensure_company($1, $2::timestamptz)', [c, NOW]);
  const ids = people.map((_, i) => `mber_Acc${companies}x${i}`);
  await rows('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
    c,
    'members',
    JSON.stringify(
      page(
        people.map((p, i) =>
          member(ids[i]!, `user_Acc${companies}x${i}`, {
            user: { id: `user_Acc${companies}x${i}`, name: p.name, username: p.username ?? null },
          }),
        ),
      ),
    ),
  ]);
  await t.db.query('select stayput.connect_telegram_chat($1, $2, $3, $4::timestamptz)', [
    c,
    chat,
    'Group',
    NOW,
  ]);
  let messages = 0;
  /** A message in the group, by a Telegram account with these names. */
  const say = async (from: string, name: string | null, username: string | null = null) => {
    messages += 1;
    await rows('select stayput.record_telegram_message($1, $2, $3, $4::timestamptz, $5, $6)', [
      chat,
      from,
      String(messages),
      '2026-09-30T20:00:00Z',
      name,
      username,
    ]);
  };
  const telegramOf = async () =>
    Object.fromEntries(
      (
        await rows<{ id: string; telegram_user_id: string | null; telegram_link: string | null }>(
          `select id, telegram_user_id, telegram_link from stayput.members
            where company_id = $1 order by id`,
          [c],
        )
      ).map((m) => [m.id, m.telegram_user_id ? `${m.telegram_user_id}/${m.telegram_link}` : null]),
    );
  const waiting = async () =>
    (
      await rows<{ user_id: string }>(
        `select distinct user_id from stayput.pending_activity where company_id = $1
          order by user_id`,
        [c],
      )
    ).map((r) => r.user_id);
  return { c, chat, ids, say, telegramOf, waiting };
}

async function admin(c: string, user: string) {
  await rows(
    `insert into stayput.company_admins (company_id, user_id, verified_at) values ($1, $2, now())`,
    [c, user],
  );
}

const change = (fn: string, args: unknown[]) =>
  rows<{ done: boolean }>(`select stayput.${fn} as done`, args).then((r) => r[0]?.done);

describe('tying an account by name', () => {
  it('ties it when one member surely matches: same username, or same full name', async () => {
    const { ids, say, telegramOf, waiting } = await community([
      { name: 'Alice Martin', username: 'alicem' },
      { name: 'Bruno Petit', username: 'brunop' },
      { name: 'Thomas Durand' },
      { name: 'Thomas Durand' },
      { name: 'Zoé' },
    ]);
    await say('1001', 'alice MARTIN'); // the full name, written otherwise
    await say('1002', 'B', 'BrunoP'); // the username
    await say('1003', 'Thomas Durand'); // two members: not sure
    await say('1004', 'Zoé'); // a first name alone: not sure
    expect(await telegramOf()).toEqual({
      [ids[0]!]: '1001/name',
      [ids[1]!]: '1002/name',
      [ids[2]!]: null,
      [ids[3]!]: null,
      [ids[4]!]: null,
    });
    // The messages of the tied accounts count for their members; the others wait.
    expect(await waiting()).toEqual(['telegram:1003', 'telegram:1004']);
  });

  it('ties a Discord author from the names of its messages', async () => {
    const { c, ids } = await community([{ name: 'Chloé Dubois', username: 'chloe' }]);
    await rows('select stayput.ingest_page($1, $2, $3, $4::text::jsonb)', [
      c,
      'discord_messages',
      '920000000000000001',
      JSON.stringify([
        {
          id: '930000000000000001',
          type: 0,
          timestamp: '2026-09-30T10:00:00Z',
          content: 'never stored',
          author: { id: '940000000000000001', username: 'chloe.d', global_name: 'chloe dubois' },
        },
      ]),
    ]);
    expect(
      await rows('select discord_user_id, discord_link from stayput.members where id = $1', [
        ids[0],
      ]),
    ).toEqual([{ discord_user_id: '940000000000000001', discord_link: 'name' }]);
    expect(
      await rows(
        `select display_name, username from stayput.platform_accounts
          where company_id = $1 and platform = 'discord'`,
        [c],
      ),
    ).toEqual([{ display_name: 'chloe dubois', username: 'chloe.d' }]);
  });

  it('ties it later, when the member arrives (the pass every 10 minutes)', async () => {
    const { c, say, telegramOf, waiting } = await community([{ name: 'Alice Martin' }]);
    await say('2001', 'Nora Ben Ali');
    expect(await waiting()).toEqual(['telegram:2001']);
    await rows('select stayput.ingest_page($1, $2, null, $3::text::jsonb)', [
      c,
      'members',
      JSON.stringify(
        page([
          member('mber_AccNora', 'user_AccNora', {
            user: { id: 'user_AccNora', name: 'Nora Ben Ali' },
          }),
        ]),
      ),
    ]);
    expect(await change('link_accounts_by_name($1)', [c])).toBe(1);
    expect((await telegramOf()).mber_AccNora).toBe('2001/name');
    expect(await waiting()).toEqual([]);
  });
});

describe('the creator ties and unties', () => {
  it('ties any account to any member, and StayPut then leaves it alone', async () => {
    const { c, ids, say, telegramOf, waiting } = await community([
      { name: 'Thomas Durand' },
      { name: 'Thomas Durand' },
    ]);
    await say('3001', 'Thomas Durand');
    const link = (account: string, memberId: string) =>
      change('link_account($1, $2, $3, $4, $5::timestamptz)', [
        c,
        'telegram',
        account,
        memberId,
        NOW,
      ]);
    expect(await link('3001', ids[1]!)).toBe(true);
    expect(await telegramOf()).toEqual({ [ids[0]!]: null, [ids[1]!]: '3001/creator' });
    expect(await waiting()).toEqual([]);
    expect(await link('9999', ids[0]!)).toBe(false); // never seen here
    expect(await link('3001', 'mber_Elsewhere')).toBe(false);

    // Untied: what it brought stays, and its next messages wait, even with a name that matches.
    expect(
      await change('unlink_account($1, $2, $3, $4::timestamptz)', [c, 'telegram', '3001', NOW]),
    ).toBe(true);
    await rows(`update stayput.members set display_name = 'Lou Bernard' where id = $1`, [ids[0]]);
    await say('3001', 'Lou Bernard');
    expect(await telegramOf()).toEqual({ [ids[0]!]: null, [ids[1]!]: null });
    expect(await waiting()).toEqual(['telegram:3001']);
    expect(
      await rows('select member_id from stayput.activity_events where company_id = $1', [c]),
    ).toEqual([{ member_id: ids[1] }]);
  });

  it('keeps the creator’s Discord link when the Whop profile shows none', async () => {
    const { c, ids } = await community([{ name: 'Alice Martin' }, { name: 'Bruno Petit' }]);
    const account = '950000000000000001';
    await rows('select stayput.note_account($1, $2, $3, $4, $5, $6::timestamptz)', [
      c,
      'discord',
      account,
      'someone',
      'someone',
      NOW,
    ]);
    await change('link_account($1, $2, $3, $4, $5::timestamptz)', [
      c,
      'discord',
      account,
      ids[0],
      NOW,
    ]);
    const profile = (user: string, discord: string | null) =>
      rows('select stayput.link_member_discord($1, $2::text::jsonb, $3::timestamptz)', [
        c,
        JSON.stringify({
          id: user,
          social_accounts: discord ? [{ platform: 'discord', external_id: discord }] : [],
        }),
        NOW,
      ]);
    await profile(`user_Acc${companies}x0`, null);
    const discordOf = () =>
      rows<{ id: string; discord_user_id: string | null; discord_link: string | null }>(
        'select id, discord_user_id, discord_link from stayput.members where company_id = $1 order by id',
        [c],
      );
    expect(await discordOf()).toEqual([
      { id: ids[0], discord_user_id: account, discord_link: 'creator' },
      { id: ids[1], discord_user_id: null, discord_link: null },
    ]);
    // The account's owner says it is theirs on Whop: Whop is right.
    await profile(`user_Acc${companies}x1`, account);
    expect(await discordOf()).toEqual([
      { id: ids[0], discord_user_id: null, discord_link: null },
      { id: ids[1], discord_user_id: account, discord_link: 'whop' },
    ]);
  });
});

describe('what the creator sees', () => {
  it('lists the accounts to tie with suggestions, and the tied ones, to the team only', async () => {
    const { c, ids, say } = await community([
      { name: 'Alice Martin', username: 'alicem' },
      { name: 'Thomas Durand' },
      { name: 'Thomas Durand' },
      { name: 'Zoé Lambert' },
    ]);
    await say('4001', 'Alice Martin');
    await say('4002', 'Thomas Durand');
    await say('4002', 'Thomas Durand');
    await say('4003', 'Zoé', 'zoe_l');
    await say('4004', null);
    await admin(c, 'user_AccOwner');
    const view = async (user: string) =>
      (
        await withUser(t.db, user, (tx) =>
          tx.query<{ view: unknown }>('select stayput.platform_accounts_view($1) as view', [c]),
        )
      )[0]?.view;

    expect(await view('user_AccStranger')).toBeNull();
    const seen = (await view('user_AccOwner')) as {
      unlinked: { accountId: string; messages: number; suggestions: unknown[] }[];
      linked: unknown[];
    };
    const thomas = [
      { memberId: ids[1], name: 'Thomas Durand', strong: true },
      { memberId: ids[2], name: 'Thomas Durand', strong: true },
    ].sort((a, b) => a.memberId!.localeCompare(b.memberId!));
    expect(
      seen.unlinked.map((a) => ({
        accountId: a.accountId,
        messages: a.messages,
        suggestions: a.suggestions,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          accountId: '4002',
          messages: 2,
          suggestions: expect.arrayContaining(thomas) as unknown[],
        },
        {
          accountId: '4003',
          messages: 1,
          suggestions: [{ memberId: ids[3], name: 'Zoé Lambert', strong: false }],
        },
        { accountId: '4004', messages: 1, suggestions: [] },
      ]),
    );
    expect(seen.unlinked).toHaveLength(3);
    expect(seen.linked).toEqual([
      {
        platform: 'telegram',
        accountId: '4001',
        name: 'Alice Martin',
        username: null,
        member: { id: ids[0], name: 'Alice Martin' },
        via: 'name',
      },
    ]);
  });

  it('sets an account aside as the team’s or a guest’s, and brings it back', async () => {
    const { c, say } = await community([{ name: 'Alice Martin' }]);
    await say('5001', 'A friend');
    await admin(c, 'user_AccOwner2');
    const counted = async () =>
      (
        await withUser(t.db, 'user_AccOwner2', (tx) =>
          tx.query<{ accounts: number }>('select accounts from stayput.unlinked_authors($1)', [c]),
        )
      )[0]?.accounts ?? 0;
    expect(await counted()).toBe(1);
    const dismiss = (as: string | null) =>
      change('dismiss_account($1, $2, $3, $4::text, $5::timestamptz)', [
        c,
        'telegram',
        '5001',
        as,
        NOW,
      ]);
    const setAside = async () =>
      (
        (
          await withUser(t.db, 'user_AccOwner2', (tx) =>
            tx.query<{ view: { dismissed: unknown[] } }>(
              'select stayput.platform_accounts_view($1) as view',
              [c],
            ),
          )
        )[0]?.view.dismissed ?? []
      ).map((d) => (d as { as: string }).as);
    expect(await dismiss('team')).toBe(true);
    expect(await counted()).toBe(0);
    expect(await setAside()).toEqual(['team']);
    expect(await dismiss(null)).toBe(true);
    expect(await counted()).toBe(1);
    expect(await setAside()).toEqual([]);
    await expect(dismiss('friend')).rejects.toThrow(/team or guest/);
    // The Worker of 0012, during a deployment: a guest's.
    expect(
      await change('dismiss_account($1, $2, $3, $4::boolean, $5::timestamptz)', [
        c,
        'telegram',
        '5001',
        true,
        NOW,
      ]),
    ).toBe(true);
    expect(await setAside()).toEqual(['guest']);
  });
});

describe('waiting activity', () => {
  it('waits 30 days under a Discord or Telegram account, 7 under a Whop user', async () => {
    const { c, say, waiting } = await community([{ name: 'Alice Martin' }]);
    await say('6001', 'Someone');
    await rows(
      `insert into stayput.pending_activity (company_id, user_id, type, occurred_at, external_id,
                                             received_at)
       values ($1, 'user_AccLater', 'message', $2::timestamptz, 'x1', $2::timestamptz)`,
      [c, '2026-09-30T20:00:00Z'],
    );
    await rows(
      `update stayput.pending_activity set received_at = $2::timestamptz
                 where company_id = $1`,
      [c, '2026-09-20T12:00:00Z'],
    );
    await rows('select stayput.purge_pending_activity($1::timestamptz)', [NOW]);
    // 11 days: the Whop user's activity is gone, the Telegram account's waits.
    expect(await waiting()).toEqual(['telegram:6001']);
    await rows('select stayput.purge_pending_activity($1::timestamptz)', ['2026-10-21T12:00:00Z']);
    expect(await waiting()).toEqual([]);
    // Its names stay while it is in the group (0017), however quiet; they go 30 days after it
    // left, nobody having the account.
    const named = () =>
      rows('select display_name from stayput.platform_accounts where company_id = $1', [c]);
    await rows('select stayput.purge_pending_activity($1::timestamptz)', ['2026-11-01T12:00:00Z']);
    expect(await named()).toEqual([{ display_name: 'Someone' }]);
    await rows(
      `select stayput.telegram_people(chat_id, '[]', '["6001"]', $2::timestamptz)
         from stayput.telegram_chats where company_id = $1`,
      [c, '2026-10-02T12:00:00Z'],
    );
    await rows('select stayput.purge_pending_activity($1::timestamptz)', ['2026-11-01T11:00:00Z']);
    expect(await named()).toEqual([{ display_name: 'Someone' }]);
    await rows('select stayput.purge_pending_activity($1::timestamptz)', ['2026-11-01T12:00:01Z']);
    expect(await named()).toEqual([]);
  });
});

describe('the activity the creator sees', () => {
  it('counts the messages per platform, day, author and place, over 30 days', async () => {
    const { c, chat, ids, say } = await community([
      { name: 'Alice Martin' },
      { name: 'Bruno Petit' },
    ]);
    await say('7001', 'Alice Martin'); // tied by name: a member
    await say('7001', 'Alice Martin');
    await say('7002', 'Mexico 17'); // the creator, set aside as the team
    await say('7003', 'Someone'); // not tied yet
    await change('dismiss_account($1, $2, $3, $4::text, $5::timestamptz)', [
      c,
      'telegram',
      '7002',
      'team',
      NOW,
    ]);
    // Beyond 30 days: not counted.
    await rows(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id)
       values ($1, $2, 'telegram_message', '2026-08-01T10:00:00Z', 'old:1')`,
      [c, ids[0]],
    );
    await admin(c, 'user_AccOwner3');
    const read = async (user: string) =>
      (
        await withUser(t.db, user, (tx) =>
          tx.query<{ view: PlatformActivityView | null }>(
            'select stayput.platform_activity($1, $2::timestamptz) as view',
            [c, NOW],
          ),
        )
      )[0]?.view;

    const view = (await read('user_AccOwner3'))!;
    expect(view).toMatchObject({ from: '2026-09-02', to: '2026-10-01' });
    const telegram = view.platforms.find((p) => p.platform === 'telegram')!;
    expect(telegram).toMatchObject({
      messages: 4,
      authors: 3,
      members: 1,
      team: 1,
      guests: 0,
      unlinked: 1,
      // The messages by who wrote them (0031): the members' part is Alice's two, her own.
      messagesBy: { members: 2, team: 1, guests: 0, unlinked: 1 },
    });
    // 30 days, the messages on 30 September (the 29th of them).
    expect(telegram.daily).toHaveLength(30);
    expect(telegram.daily[28]).toBe(4);
    expect(telegram.daily.reduce((a, b) => a + b, 0)).toBe(4);
    expect(view.platforms.find((p) => p.platform === 'discord')).toMatchObject({
      messages: 0,
      authors: 0,
      lastAt: null,
    });
    expect(view.places).toEqual([
      {
        platform: 'telegram',
        id: chat,
        name: 'Group',
        messages: 4,
        lastAt: expect.any(String) as string,
      },
    ]);
    expect(view.topMembers).toEqual([
      {
        id: ids[0],
        name: 'Alice Martin',
        discord: 0,
        telegram: 2,
        lastAt: expect.any(String) as string,
      },
    ]);
    expect(await read('user_AccNobody')).toBeNull();
  });
});

describe('everyone on Discord and Telegram (0017)', () => {
  it('lists who is on the server and in the group, who they are, and who left', async () => {
    const { c, chat, ids, say } = await community([
      { name: 'Alice Martin', username: 'alice.m' },
      { name: 'Bruno Petit' },
    ]);
    const guild = `96600${companies}`;
    await rows('select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz)', [
      c,
      guild,
      'Le Club',
      'user_AccOwner4',
      NOW,
    ]);
    // The server's member list: Alice by her username (tied to her at once), someone not tied,
    // the creator (set aside as the team), and a bot.
    const listed = (people: unknown[]) =>
      rows(
        `select stayput.discord_roster_start($1, $2),
                stayput.sync_page($1, 'discord_members:' || $2, 'discord_members', $2,
                                  $3::text::jsonb, $4::timestamptz, true, null, true, 'end'),
                stayput.discord_roster_end($1, $2, $4::timestamptz)`,
        [c, guild, JSON.stringify(people), NOW],
      );
    const person = (id: string, name: string | null, username: string) => ({
      user: { id, username, global_name: name, bot: false },
      nick: null,
      joined_at: '2026-09-01T10:00:00.000000+00:00',
    });
    await listed([
      person('9660001', 'Alice', 'alice.m'),
      person('9660002', 'Zed', 'zed'),
      person('9660003', 'Le A', 'am.17zz'),
      { user: { id: '9660009', username: 'bot', bot: true }, joined_at: null },
    ]);
    await change('dismiss_account($1, $2, $3, $4::text, $5::timestamptz)', [
      c,
      'discord',
      '9660003',
      'team',
      NOW,
    ]);
    await rows('select stayput.discord_guild_count($1, $2, $3::timestamptz)', [guild, 12, NOW]);

    // The group: Léa joined and Marc wrote; the administrators come with the head count; Paul
    // joined, then left.
    await rows(`select stayput.telegram_people($1, $2::text::jsonb, '[]', $3::timestamptz)`, [
      chat,
      JSON.stringify([
        { id: '7101', name: 'Léa', username: null },
        { id: '7104', name: 'Paul', username: 'paul' },
      ]),
      '2026-09-29T09:00:00Z',
    ]);
    await say('7102', 'Marc');
    await rows(`select stayput.telegram_chat_people($1, 34, $2::text::jsonb, $3::timestamptz)`, [
      chat,
      JSON.stringify([{ id: '7103', name: 'Chef', username: 'chef' }]),
      NOW,
    ]);
    await rows(`select stayput.telegram_people($1, '[]', '["7104"]', $2::timestamptz)`, [
      chat,
      '2026-09-30T09:00:00Z',
    ]);
    // Over 30 days, Alice wrote twice on Discord, as herself.
    await rows(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id)
       values ($1, $2, 'discord_message', '2026-09-30T10:00:00Z', 'd:1'),
              ($1, $2, 'discord_message', '2026-09-30T11:00:00Z', 'd:2')`,
      [c, ids[0]],
    );

    await admin(c, 'user_AccOwner4');
    const read = async (user: string) =>
      (
        await withUser(t.db, user, (tx) =>
          tx.query<{ view: PeopleView | null }>(
            'select stayput.platform_people($1, $2::timestamptz) as view',
            [c, NOW],
          ),
        )
      )[0]?.view;
    const view = (await read('user_AccOwner4'))!;
    expect(view.places).toEqual([
      { platform: 'discord', id: guild, name: 'Le Club', total: 12, known: 3, list: 'listed' },
      { platform: 'telegram', id: chat, name: 'Group', total: 34, known: 3, list: 'joins' },
    ]);
    expect(view.total).toBe(7);
    const who = Object.fromEntries(view.people.map((p) => [p.accountId, p]));
    expect(who['9660001']).toMatchObject({
      platform: 'discord',
      status: 'member',
      member: { id: ids[0], name: 'Alice Martin' },
      here: true,
      joinedAt: expect.stringMatching(/^2026-09-01/) as string,
      messages: 2,
    });
    expect(who['9660002']).toMatchObject({ status: 'unlinked', here: true, messages: 0 });
    expect(who['9660003']).toMatchObject({ status: 'team', here: true });
    expect(who['9660009']).toBeUndefined();
    expect(who['7101']).toMatchObject({ name: 'Léa', status: 'unlinked', here: true });
    expect(who['7102']).toMatchObject({ name: 'Marc', here: true, messages: 1 });
    expect(who['7103']).toMatchObject({ name: 'Chef', username: 'chef', here: true });
    expect(who['7104']).toMatchObject({
      name: 'Paul',
      here: false,
      leftAt: expect.stringMatching(/^2026-09-30/) as string,
    });
    // The latest to write first, then who is there, the newest arrivals first.
    expect(view.people.map((p) => p.accountId)).toEqual([
      '7102',
      '9660001',
      '7101',
      '9660003',
      '9660002',
      '7103',
      '7104',
    ]);
    expect(await read('user_AccNobody')).toBeNull();

    // The server disconnected: who StayPut saw there goes with it.
    await rows('select stayput.disconnect_discord_guild($1, $2)', [c, guild]);
    const after = (await read('user_AccOwner4'))!;
    expect(after.places.map((p) => p.platform)).toEqual(['telegram']);
    expect(after.people.find((p) => p.accountId === '9660002')).toMatchObject({ here: null });
  });

  it('marks who left a server when its list no longer has them, and keeps a guest out', async () => {
    const { c } = await community([]);
    const guild = `96700${companies}`;
    await rows('select stayput.connect_discord_guild($1, $2, $3, $4, $5::timestamptz)', [
      c,
      guild,
      'Server',
      'user_AccOwner5',
      NOW,
    ]);
    const read = (people: string[], at: string) =>
      rows(
        `select stayput.discord_roster_start($1, $2),
                stayput.ingest_page($1, 'discord_members', $2, $3::text::jsonb),
                stayput.discord_roster_end($1, $2, $4::timestamptz)`,
        [
          c,
          guild,
          JSON.stringify(
            people.map((id) => ({ user: { id, username: `u${id}` }, joined_at: null })),
          ),
          at,
        ],
      );
    await read(['9670001', '9670002'], NOW);
    await read(['9670002'], '2026-10-01T13:00:00Z');
    const presence = await rows<{ account_id: string; left_at: string | null }>(
      `select account_id, left_at::text from stayput.platform_presence
        where company_id = $1 order by account_id`,
      [c],
    );
    expect(presence).toEqual([
      { account_id: '9670001', left_at: expect.stringMatching(/^2026-10-01 13:00/) as string },
      { account_id: '9670002', left_at: null },
    ]);
    // Back on the server: there again.
    await read(['9670001', '9670002'], '2026-10-01T14:00:00Z');
    expect(
      await rows(
        'select count(*)::int as n from stayput.platform_presence where company_id = $1 and left_at is null',
        [c],
      ),
    ).toEqual([{ n: 2 }]);
  });
});
