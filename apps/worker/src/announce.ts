import type { AnnounceDestination } from '@stayput/core';
import type { WhopClient } from '@stayput/whop';
import { withUser, type TransactionalDb } from './db';
import type { DiscordClient } from './discord';

/**
 * Where the members' milestones can be announced (SPEC Phase 5, point 4): the Whop chats of the
 * community, the channels of its Discord servers where StayPut's bot may write, its Telegram
 * groups. Read now, so that the creator never picks a place StayPut cannot post in.
 */
export async function announceChoices(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  clients: { whop: WhopClient | null; discord: DiscordClient | null },
): Promise<{ choices: AnnounceDestination[]; whopUnavailable: boolean }> {
  const { guilds, chats } = await withUser(db, userId, async (tx) => ({
    guilds: await tx.query<{ guild_id: string; name: string | null }>(
      `select guild_id, name from stayput.discord_guilds
        where company_id = $1 order by connected_at, guild_id`,
      [companyId],
    ),
    chats: await tx.query<{ chat_id: string; title: string | null }>(
      `select chat_id, title from stayput.telegram_chats
        where company_id = $1 and left_at is null order by connected_at, chat_id`,
      [companyId],
    ),
  }));
  const choices: AnnounceDestination[] = [];
  let whopUnavailable = !clients.whop;
  if (clients.whop) {
    try {
      const page = await clients.whop.listPage<{ id?: unknown; experience?: { name?: unknown } }>(
        '/chat_channels',
        { account_id: companyId },
        { first: 50 },
      );
      for (const chat of page.items) {
        if (typeof chat.id !== 'string') continue;
        const name = chat.experience?.name;
        choices.push({
          platform: 'whop',
          id: chat.id,
          name: typeof name === 'string' ? name : null,
          place: 'Whop',
        });
      }
    } catch (error) {
      // Most often the app lacks a permission: the creator sees why Whop's chats are missing.
      console.error('Whop chats not listed:', error instanceof Error ? error.message : error);
      whopUnavailable = true;
    }
  }
  if (clients.discord) {
    for (const guild of guilds) {
      try {
        const channels = await clients.discord.guildChannels(guild.guild_id);
        for (const channel of channels) {
          if (!channel.writable) continue;
          choices.push({
            platform: 'discord',
            id: channel.id,
            name: `#${channel.name}`,
            place: guild.name,
          });
        }
      } catch (error) {
        // A server Discord does not answer for: its channels are not offered this time.
        console.error('Discord channels not read:', error instanceof Error ? error.message : error);
      }
    }
  }
  for (const chat of chats) {
    choices.push({ platform: 'telegram', id: chat.chat_id, name: chat.title, place: 'Telegram' });
  }
  return { choices, whopUnavailable };
}
