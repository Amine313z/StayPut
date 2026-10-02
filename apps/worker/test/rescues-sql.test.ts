import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinRescue, planRescues, readRescues, readRescuesView, saveRescues } from '../src/space';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0026, the rescue challenges (SPEC Phase 5, point 9): a member inactive for 14 days
 * shown, without their name, to the community's members with the way to their last message; the
 * Rescuer badge for who took it up when they come back.
 */

// 1 October 2026, 10:00 in Paris.
const NOW = new Date('2026-10-01T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY);
const GUILD = '930000000000000001';
const CHANNEL = '930000000000000002';
const SUPERGROUP = '-1001234567890';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

/** A community with a Discord server and a Telegram supergroup, its challenges on or off. */
async function community(on = true) {
  n += 1;
  const c = `biz_Res${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale)
     values ($1, 'Le Club', 'Europe/Paris', 'fr')`,
    [c],
  );
  await t.db.query(`insert into stayput.company_settings (company_id) values ($1)`, [c]);
  await t.db.query(
    `insert into stayput.discord_guilds (guild_id, company_id, name, channel_ids, connected_at)
     values ($1, $2, 'Le Club Discord', array[$3], $4::timestamptz)`,
    [`${GUILD.slice(0, -2)}${String(n).padStart(2, '0')}`, c, CHANNEL, NOW.toISOString()],
  );
  await t.db.query(
    `insert into stayput.telegram_chats (chat_id, company_id, title, connected_at)
     values ($1, $2, 'Le Club Telegram', $3::timestamptz)`,
    [`${SUPERGROUP}${n}`, c, NOW.toISOString()],
  );
  if (on) await saveRescues(t.db, c, true);
  const guild = `${GUILD.slice(0, -2)}${String(n).padStart(2, '0')}`;
  const chat = `${SUPERGROUP}${n}`;

  const member = async (
    name: string,
    joined: number,
    options: { admin?: boolean; dnc?: boolean } = {},
  ) => {
    const id = `mber_${name}${n}`;
    const user = `user_${name}${n}`;
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                    access_level, do_not_contact)
       values ($1, $2, $3, $4, $5::timestamptz, 'joined', $6, $7)`,
      [
        id,
        c,
        user,
        `${name} Martin`,
        days(joined).toISOString(),
        options.admin ? 'admin' : null,
        !!options.dnc,
      ],
    );
    return { id, user };
  };

  let events = 0;
  /** A message of the member `at` days from NOW, on a platform. */
  const message = async (
    memberId: string,
    at: number,
    platform: 'discord' | 'telegram' | 'whop' | 'lesson',
  ) => {
    events += 1;
    const id = `${n}${String(events).padStart(4, '0')}`;
    const [type, external, metadata] =
      platform === 'discord'
        ? ['discord_message', `94000000000000${id}`, { channel_id: CHANNEL }]
        : platform === 'telegram'
          ? ['telegram_message', `${chat}:${id}`, { chat_id: chat }]
          : platform === 'whop'
            ? ['message', `post_${id}`, { channel_id: 'chat_Club' }]
            : ['lesson_completed', `lesson_${id}`, {}];
    await t.db.query(
      `insert into stayput.activity_events (company_id, member_id, type, occurred_at, external_id,
                                            metadata)
       values ($1, $2, $3, $4::timestamptz, $5, $6::text::jsonb)`,
      [c, memberId, type, days(at).toISOString(), external, JSON.stringify(metadata)],
    );
    return external;
  };
  return { c, member, message, guild, chat };
}

const challenges = (c: string) =>
  t.db.query<{
    target_member_id: string;
    status: string;
    last_message: Record<string, unknown>;
    resolved_at: Date | null;
  }>(
    `select target_member_id, status, last_message, resolved_at from stayput.rescue_challenges
      where company_id = $1 order by created_at, (last_message ->> 'at') desc`,
    [c],
  );

describe('the rescue challenges (0026)', () => {
  it('makes one of a member inactive for 14 days, with the way to their last message', async () => {
    const { c, member, message, guild, chat } = await community(false);
    const zoe = await member('Zoe', -60);
    const discordId = await message(zoe.id, -20, 'discord');
    const tim = await member('Tim', -60);
    await message(tim.id, -40, 'discord');
    const telegramId = await message(tim.id, -16, 'telegram');
    const wil = await member('Wil', -60);
    await message(wil.id, -15, 'whop');
    // Active, gone too long, too new, of the team, never to be contacted, never wrote.
    await message((await member('Act', -60)).id, -2, 'whop');
    await message((await member('Old', -200)).id, -100, 'discord');
    await message((await member('New', -10)).id, -10, 'whop');
    await message((await member('Boss', -60, { admin: true })).id, -20, 'whop');
    await message((await member('Dnc', -60, { dnc: true })).id, -20, 'whop');
    await message((await member('Mute', -60)).id, -20, 'lesson');

    expect(await planRescues(t.db, c, NOW)).toBe(0);
    await saveRescues(t.db, c, true);
    expect(await planRescues(t.db, c, NOW)).toBe(3);
    // The members who stalled most recently first.
    expect(await challenges(c)).toEqual([
      {
        target_member_id: wil.id,
        status: 'open',
        last_message: {
          platform: 'whop',
          place: null,
          url: null,
          at: days(-15).toISOString().replace('Z', '+00:00').replace('.000', ''),
        },
        resolved_at: null,
      },
      {
        target_member_id: tim.id,
        status: 'open',
        last_message: {
          platform: 'telegram',
          place: 'Le Club Telegram',
          url: `https://t.me/c/${chat.slice(4)}/${telegramId.split(':')[1]}`,
          at: days(-16).toISOString().replace('Z', '+00:00').replace('.000', ''),
        },
        resolved_at: null,
      },
      {
        target_member_id: zoe.id,
        status: 'open',
        last_message: {
          platform: 'discord',
          place: 'Le Club Discord',
          url: `https://discord.com/channels/${guild}/${CHANNEL}/${discordId}`,
          at: days(-20).toISOString().replace('Z', '+00:00').replace('.000', ''),
        },
        resolved_at: null,
      },
    ]);
    // Made once.
    expect(await planRescues(t.db, c, days(0.1))).toBe(0);
  });

  it('gives the Rescuer badge to who took it up before the member came back', async () => {
    const { c, member, message } = await community();
    const zoe = await member('Zoe', -60);
    await message(zoe.id, -20, 'discord');
    const act = await member('Act', -60);
    await message(act.id, -1, 'whop');
    const late = await member('Late', -60);
    await message(late.id, -1, 'whop');
    await planRescues(t.db, c, NOW);
    const [challenge] = (await readRescues(t.db, c, act.user))!.challenges;
    expect(await joinRescue(t.db, c, act.user, challenge!.id, days(1))).toMatchObject({
      challenges: [{ id: challenge!.id, joined: true, helpers: 1 }],
      rescued: 0,
    });
    // Zoe comes back on day 2; Late took it up after.
    await message(zoe.id, 2, 'whop');
    await joinRescue(t.db, c, late.user, challenge!.id, days(2.5));
    await planRescues(t.db, c, days(3));
    expect(await challenges(c)).toMatchObject([
      { target_member_id: zoe.id, status: 'resolved', resolved_at: days(2) },
    ]);
    const badges = await t.db.query<{ member_id: string; context: Record<string, unknown> }>(
      `select member_id, context from stayput.member_badges
        where company_id = $1 and badge_code = 'rescuer'`,
      [c],
    );
    expect(badges).toEqual([{ member_id: act.id, context: { challenge_id: challenge!.id } }]);
    expect(await readRescues(t.db, c, act.user)).toEqual({ challenges: [], rescued: 1 });
    expect(await readRescues(t.db, c, late.user)).toEqual({ challenges: [], rescued: 0 });
  });

  it('ends one after 14 days, or when its member leaves or may not be contacted', async () => {
    const { c, member, message } = await community();
    const zoe = await member('Zoe', -60);
    await message(zoe.id, -20, 'discord');
    const tim = await member('Tim', -60);
    await message(tim.id, -20, 'telegram');
    const wil = await member('Wil', -60);
    await message(wil.id, -20, 'whop');
    expect(await planRescues(t.db, c, NOW)).toBe(3);
    await t.db.query(`update stayput.members set status = 'left' where id = $1`, [tim.id]);
    await t.db.query(`update stayput.members set do_not_contact = true where id = $1`, [wil.id]);
    expect(await planRescues(t.db, c, days(1))).toBe(0);
    expect(
      Object.fromEntries((await challenges(c)).map((r) => [r.target_member_id, r.status])),
    ).toEqual({ [zoe.id]: 'open', [tim.id]: 'expired', [wil.id]: 'expired' });
    await planRescues(t.db, c, days(14));
    expect((await challenges(c)).find((r) => r.target_member_id === zoe.id)).toMatchObject({
      status: 'expired',
    });
    // Once a month at most for the same member; then again, while their message is recent.
    expect(await planRescues(t.db, c, days(20))).toBe(0);
    expect(await planRescues(t.db, c, days(30.5))).toBe(1);
    expect(await planRescues(t.db, c, days(80))).toBe(0);
  });

  it('shows members the open ones, anonymized, never their own, 5 at most', async () => {
    const { c, member, message } = await community();
    const act = await member('Act', -60);
    await message(act.id, -1, 'whop');
    const stalled: { id: string; user: string }[] = [];
    for (let i = 0; i < 7; i += 1) {
      const someone = await member(`Gone${i}`, -60);
      await message(someone.id, -15 - i, 'discord');
      stalled.push(someone);
    }
    expect(await planRescues(t.db, c, NOW)).toBe(7);
    const seen = (await readRescues(t.db, c, act.user))!;
    expect(seen.challenges).toHaveLength(5);
    expect(seen.challenges[0]).toEqual({
      id: expect.any(String) as string,
      platform: 'discord',
      place: 'Le Club Discord',
      url: expect.stringMatching(/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/) as string,
      lastMessageAt: days(-15).toISOString(),
      createdAt: NOW.toISOString(),
      helpers: 0,
      joined: false,
    });
    // Nobody's name, nor anything that says who.
    expect(JSON.stringify(seen)).not.toMatch(/Gone|Martin|mber_|user_/);
    // A stalled member does not see their own challenge, and cannot take it up.
    const own = (
      await t.db.query<{ id: string }>(
        `select id from stayput.rescue_challenges where target_member_id = $1`,
        [stalled[0]!.id],
      )
    )[0]!.id;
    const theirs = (await readRescues(t.db, c, stalled[0]!.user))!;
    expect(theirs.challenges.map((x) => x.id)).not.toContain(own);
    expect(await joinRescue(t.db, c, stalled[0]!.user, own, NOW)).toBeNull();
    // A challenge taken up goes after those nobody took up yet.
    const first = seen.challenges[0]!.id;
    await joinRescue(t.db, c, act.user, first, NOW);
    const after = (await readRescues(t.db, c, stalled[3]!.user))!;
    expect(after.challenges.map((x) => x.id)).not.toContain(first);
    // Off: nothing shown, nothing taken up.
    await saveRescues(t.db, c, false);
    expect(await readRescues(t.db, c, act.user)).toBeNull();
    expect(await joinRescue(t.db, c, 'user_Nobody', first, NOW)).toBeNull();
  });

  it('tells the creator where they stand, under RLS', async () => {
    const { c, member, message } = await community();
    const zoe = await member('Zoe', -60);
    await message(zoe.id, -20, 'discord');
    const act = await member('Act', -60);
    // RLS checks the team's access against the database's own clock (is_company_admin).
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, 'user_owner', now())`,
      [c],
    );
    await planRescues(t.db, c, NOW);
    const [challenge] = (await readRescues(t.db, c, act.user))!.challenges;
    await joinRescue(t.db, c, act.user, challenge!.id, days(1));
    await message(zoe.id, 2, 'lesson');
    await planRescues(t.db, c, days(3));
    expect(await readRescuesView(t.db, 'user_owner', c, days(3))).toEqual({
      enabled: true,
      open: 0,
      rescuedLast30: 1,
      rescuers: 1,
    });
    expect(await readRescuesView(t.db, 'user_stranger', c, days(3))).toBeNull();
  });
});
