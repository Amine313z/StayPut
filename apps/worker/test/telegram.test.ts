import { describe, expect, it } from 'vitest';
import {
  BOT_TEXTS,
  botText,
  createTelegramClient,
  readTelegramMemberToken,
  readTelegramStartToken,
  telegramAction,
  telegramMemberLink,
  telegramMemberToken,
  telegramStartLink,
  telegramStartToken,
  telegramWebhookSecret,
} from '../src/telegram';

const TOKEN = '123456:secret-bot-token';
const NOW_S = 1_790_000_000;

describe('the Telegram client', () => {
  function fakeTelegram(answers: Record<string, () => Response>) {
    const calls: { method: string; body: unknown }[] = [];
    const fetch = (input: string, init: RequestInit) => {
      const method = input.split('/').at(-1) ?? '';
      calls.push({ method, body: JSON.parse(init.body as string) as unknown });
      const answer = answers[method];
      return answer
        ? Promise.resolve(answer())
        : Promise.reject(new Error(`network down for ${input}`));
    };
    return { fetch, calls };
  }
  const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));

  it('reads the bot once: its name, and whether it sees every message', async () => {
    const telegram = fakeTelegram({
      getMe: () => ok({ username: 'StayPutBot', can_read_all_group_messages: false }),
    });
    const client = createTelegramClient({ botToken: TOKEN, fetch: telegram.fetch });
    expect(await client.bot()).toEqual({ username: 'StayPutBot', readsAllMessages: false });
    await client.bot();
    expect(telegram.calls).toHaveLength(1);
  });

  it('sets the webhook for messages and its own membership, with the secret', async () => {
    const telegram = fakeTelegram({ setWebhook: () => ok(true) });
    const client = createTelegramClient({ botToken: TOKEN, fetch: telegram.fetch });
    await client.setWebhook('https://w.example/webhooks/telegram', 'abc');
    expect(telegram.calls[0]!.body).toEqual({
      url: 'https://w.example/webhooks/telegram',
      secret_token: 'abc',
      allowed_updates: ['message', 'my_chat_member'],
    });
  });

  it('never repeats its token in an error', async () => {
    const telegram = fakeTelegram({
      leaveChat: () =>
        new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), {
          status: 400,
        }),
    });
    const client = createTelegramClient({ botToken: TOKEN, fetch: telegram.fetch });
    const refused = await client.leaveChat('-100').catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 400 });
    expect(String(refused)).toContain('chat not found');
    const down = await client.sendMessage('-100', 'hi').catch((e: unknown) => e);
    expect(down).toMatchObject({ status: 0 });
    for (const error of [refused, down]) expect(String(error)).not.toContain('secret-bot-token');
  });
});

describe('signed links', () => {
  it('derives a webhook secret Telegram accepts, from the token alone', async () => {
    const secret = await telegramWebhookSecret(TOKEN);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await telegramWebhookSecret(TOKEN)).toBe(secret);
    expect(await telegramWebhookSecret('654321:other')).not.toBe(secret);
  });

  it('signs the company of a group link, until it expires', async () => {
    const token = await telegramStartToken('biz_2whAzkbCRpcGqQ', NOW_S + 3600, TOKEN);
    expect(token).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const company = async (t: string, now = NOW_S, bot = TOKEN) =>
      (await readTelegramStartToken(t, now, bot)).companyId;
    expect(await company(token)).toBe('biz_2whAzkbCRpcGqQ');
    expect(await company(token, NOW_S + 3600)).toBeNull();
    expect(await company(token, NOW_S, '999:another-bot')).toBeNull();
    const forged = token.replace(/^[A-Za-z0-9]+/, 'OtherCompany');
    expect(await company(forged)).toBeNull();
    expect(await readTelegramStartToken('nonsense', NOW_S, TOKEN)).toEqual({
      companyId: null,
      language: null,
    });
    expect(telegramStartLink('StayPutBot', token)).toBe(
      `https://t.me/StayPutBot?startgroup=${token}`,
    );
  });

  it("carries the creator's StayPut language in a group link, signed with it", async () => {
    const token = await telegramStartToken('biz_2whAzkbCRpcGqQ', NOW_S + 3600, TOKEN, 'fr');
    expect(token).toMatch(/^2whAzkbCRpcGqQ_[0-9a-z]+_fr_[A-Za-z0-9_-]{22}$/);
    expect(await readTelegramStartToken(token, NOW_S, TOKEN)).toEqual({
      companyId: 'biz_2whAzkbCRpcGqQ',
      language: 'fr',
    });
    // Expired, the link still says in which language to answer.
    expect(await readTelegramStartToken(token, NOW_S + 3600, TOKEN)).toEqual({
      companyId: null,
      language: 'fr',
    });
    // The language is signed: changing it breaks the link.
    expect(
      (await readTelegramStartToken(token.replace('_fr_', '_en_'), NOW_S, TOKEN)).companyId,
    ).toBeNull();
    // A link made before languages existed still works.
    const before = await telegramStartToken('biz_2whAzkbCRpcGqQ', NOW_S + 3600, TOKEN);
    expect(await readTelegramStartToken(before, NOW_S, TOKEN)).toEqual({
      companyId: 'biz_2whAzkbCRpcGqQ',
      language: null,
    });
  });

  it('signs the member and the company of a member link, distinct from a group link', async () => {
    const token = await telegramMemberToken(
      'biz_2whAzkbCRpcGqQ',
      'user_v9KUoZvTGp6ID',
      NOW_S + 3600,
      TOKEN,
    );
    expect(token.length).toBeLessThanOrEqual(64);
    const member = async (t: string, now = NOW_S) =>
      (await readTelegramMemberToken(t, now, TOKEN)).member;
    expect(await member(token)).toEqual({
      companyId: 'biz_2whAzkbCRpcGqQ',
      userId: 'user_v9KUoZvTGp6ID',
    });
    expect(await member(token, NOW_S + 3601)).toBeNull();
    // A group link is no member link, and the other way round.
    const group = await telegramStartToken('biz_2whAzkbCRpcGqQ', NOW_S + 3600, TOKEN, 'fr');
    expect(await member(group)).toBeNull();
    expect((await readTelegramStartToken(token, NOW_S, TOKEN)).companyId).toBeNull();
    // Another member's id in a link signed for someone else.
    const swapped = token.replace('v9KUoZvTGp6ID', 'mallory000000');
    expect(await member(swapped)).toBeNull();
    expect(telegramMemberLink('StayPutBot', token)).toBe(`https://t.me/StayPutBot?start=${token}`);

    // In the member's StayPut language, signed with it.
    const french = await telegramMemberToken(
      'biz_2whAzkbCRpcGqQ',
      'user_v9KUoZvTGp6ID',
      NOW_S + 3600,
      TOKEN,
      'fr',
    );
    expect(french.length).toBeLessThanOrEqual(64);
    expect(await readTelegramMemberToken(french, NOW_S, TOKEN)).toEqual({
      member: { companyId: 'biz_2whAzkbCRpcGqQ', userId: 'user_v9KUoZvTGp6ID' },
      language: 'fr',
    });
    expect(await member(french.replace('_fr_', '_en_'))).toBeNull();
    expect(await readTelegramMemberToken(french, NOW_S + 3601, TOKEN)).toEqual({
      member: null,
      language: 'fr',
    });
  });

  it('refuses to make a link Telegram would cut', async () => {
    await expect(
      telegramMemberToken(`biz_${'a'.repeat(30)}`, `user_${'b'.repeat(30)}`, NOW_S, TOKEN),
    ).rejects.toThrow(/64 characters/);
  });
});

describe('telegramAction', () => {
  const group = { id: -1001234567890, type: 'supergroup', title: 'Ma communauté' };
  const person = { id: 42, is_bot: false, first_name: 'Ana', language_code: 'fr' };
  const message = (over: Record<string, unknown>) => ({
    update_id: 1,
    message: { message_id: 7, date: 1_790_000_000, chat: group, from: person, ...over },
  });

  it("counts a person's message in a group, with their names, never its text", () => {
    expect(telegramAction(message({ text: 'bonjour' }))).toEqual({
      kind: 'message',
      chatId: '-1001234567890',
      fromId: '42',
      messageId: '7',
      at: new Date(1_790_000_000_000),
      name: 'Ana',
      username: null,
    });
    expect(telegramAction(message({ photo: [{}] }))).toMatchObject({ kind: 'message' });
    // First and last names together; nothing when Telegram gives none.
    expect(
      telegramAction(
        message({
          text: 'x',
          from: { id: 43, is_bot: false, first_name: ' Zoé ', last_name: 'Lambert' },
        }),
      ),
    ).toMatchObject({ name: 'Zoé Lambert', username: null });
    expect(
      telegramAction(message({ text: 'x', from: { id: 44, is_bot: false, first_name: '' } })),
    ).toMatchObject({ name: null, username: null });
  });

  it('skips what a chat sends instead of a person: channel posts copied into its group', () => {
    const channel = { id: -1009876543210, type: 'channel', title: 'Mon canal' };
    // Telegram copies each channel post into the channel's discussion group, as a stand-in user.
    const copied = message({
      text: 'Nouvelle vidéo',
      from: { id: 777000, is_bot: false, first_name: 'Telegram' },
      sender_chat: channel,
      is_automatic_forward: true,
    });
    expect(telegramAction(copied)).toEqual({ kind: 'ignore' });
    // An anonymous administrator, or someone commenting as their own channel.
    expect(
      telegramAction(
        message({ text: 'x', from: { id: 136817688, is_bot: false }, sender_chat: channel }),
      ),
    ).toEqual({ kind: 'ignore' });
    // A member's comment under a post is theirs: it counts.
    expect(
      telegramAction(message({ text: 'Merci !', reply_to_message: { message_id: 3 } })),
    ).toMatchObject({ kind: 'message', fromId: '42' });
  });

  it("skips bots, service messages and what is not a group's", () => {
    expect(telegramAction(message({ text: 'x', from: { id: 9, is_bot: true } }))).toEqual({
      kind: 'ignore',
    });
    expect(telegramAction(message({ new_chat_members: [person] }))).toEqual({ kind: 'ignore' });
    expect(telegramAction(message({ text: 'x', chat: { id: -5, type: 'channel' } })).kind).toBe(
      'ignore',
    );
    expect(telegramAction({ update_id: 2, edited_message: {} })).toEqual({ kind: 'ignore' });
    expect(telegramAction(null)).toEqual({ kind: 'ignore' });
  });

  it('reads the link that added the bot to a group', () => {
    expect(telegramAction(message({ text: '/start@StayPutBot abc_123-x' }))).toEqual({
      kind: 'link',
      chatId: '-1001234567890',
      title: 'Ma communauté',
      token: 'abc_123-x',
      language: 'fr',
    });
  });

  it('follows the bot in and out of groups, and groups that become supergroups', () => {
    const change = (status: string) => ({
      update_id: 3,
      my_chat_member: { chat: group, new_chat_member: { status, user: { id: 1 } } },
    });
    expect(telegramAction(change('member'))).toEqual({
      kind: 'membership',
      chatId: '-1001234567890',
      present: true,
    });
    expect(telegramAction(change('kicked'))).toMatchObject({ present: false });
    expect(telegramAction(change('left'))).toMatchObject({ present: false });
    expect(
      telegramAction(message({ chat: { id: -4001, type: 'group' }, migrate_to_chat_id: -1009 })),
    ).toEqual({ kind: 'migrate', fromChatId: '-4001', toChatId: '-1009' });
  });

  it('reads /start in a private chat, with or without a member link', () => {
    const chat = { id: 42, type: 'private' };
    expect(telegramAction(message({ chat, text: '/start u1_b2_x_0123456789abcdef' }))).toEqual({
      kind: 'private_start',
      chatId: '42',
      fromId: '42',
      token: 'u1_b2_x_0123456789abcdef',
      language: 'fr',
    });
    expect(telegramAction(message({ chat, text: '/start' }))).toMatchObject({ token: null });
    expect(telegramAction(message({ chat, text: 'salut' }))).toEqual({ kind: 'ignore' });
  });
});

describe('what the bot says', () => {
  it('speaks French to a French-speaking user, English otherwise', () => {
    expect(botText('help', 'fr-CA')).toBe(BOT_TEXTS.help.fr);
    expect(botText('help', 'de')).toBe(BOT_TEXTS.help.en);
    expect(botText('help', null)).toBe(BOT_TEXTS.help.en);
  });

  it('keeps every reply to one short paragraph', () => {
    for (const text of Object.values(BOT_TEXTS).flatMap((t) => [t.fr, t.en])) {
      expect(text.length).toBeLessThan(400);
    }
  });
});
