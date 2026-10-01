import type { AccountPlatform, AccountsView } from '@stayput/core';
import { withUser, type Db, type TransactionalDb } from './db';
import type { DiscordClient } from './discord';
import type { TelegramClient } from './telegram';

/**
 * The Discord and Telegram accounts StayPut saw writing, and the members they are (decision of
 * 2026-10-01): an account joins its member through the member's Whop profile (Discord), the
 * member's own link (Telegram), its name (StayPut, when one member surely matches) or the
 * creator's choice. Only the accounts' names are kept for that, never what they wrote.
 */

/** Names asked of Discord or Telegram per request: each is a call. */
export const NAMES_PER_REQUEST = 10;

export interface AccountClients {
  discord: DiscordClient | null;
  telegram: TelegramClient | null;
}

/** The accounts a creator sees, after asking for a few names StayPut lacks. */
export async function readAccounts(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  clients: AccountClients,
): Promise<AccountsView | null> {
  await fillNames(db, companyId, clients);
  return accountsView(db, userId, companyId);
}

export async function accountsView(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<AccountsView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: AccountsView | null }>('select stayput.platform_accounts_view($1) as view', [
      companyId,
    ]),
  );
  return row?.view ?? null;
}

/**
 * Accounts seen before StayPut kept names, or whose message came without them: Discord tells a
 * user's names, Telegram those of someone in one of the bot's groups. Noting them may tie the
 * account to its member by name.
 */
async function fillNames(db: Db, companyId: string, clients: AccountClients): Promise<void> {
  const missing = await db.query<{
    platform: AccountPlatform;
    account_id: string;
    chat_id: string | null;
  }>('select platform, account_id, chat_id from stayput.accounts_without_names($1, $2)', [
    companyId,
    NAMES_PER_REQUEST,
  ]);
  for (const account of missing) {
    let names: { name: string | null; username: string | null } | null = null;
    try {
      if (account.platform === 'discord' && clients.discord) {
        names = await clients.discord.user(account.account_id);
      } else if (account.platform === 'telegram' && clients.telegram && account.chat_id) {
        names = await clients.telegram.chatMember(account.chat_id, account.account_id);
      }
    } catch (error) {
      // Someone who left the group, an outage: the names wait for the next message.
      console.error('Account names not read:', error instanceof Error ? error.message : error);
      continue;
    }
    if (!names?.name && !names?.username) continue;
    await db.query('select stayput.note_account($1, $2, $3, $4, $5, null)', [
      companyId,
      account.platform,
      account.account_id,
      names.name,
      names.username,
    ]);
  }
}

/** The account a creator names in a request, when it is one. */
export function accountOf(body: unknown): { platform: AccountPlatform; accountId: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { platform, accountId } = body as Record<string, unknown>;
  if (typeof accountId !== 'string') return null;
  if (platform === 'discord' && /^[0-9]{5,25}$/.test(accountId)) {
    return { platform, accountId };
  }
  if (platform === 'telegram' && /^[0-9]{1,20}$/.test(accountId)) {
    return { platform, accountId };
  }
  return null;
}
