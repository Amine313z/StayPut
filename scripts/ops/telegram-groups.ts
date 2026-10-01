/**
 * The Telegram groups StayPut counts, as Telegram itself sees them: for each connected group,
 * whether the bot is still in it, what kind of chat it is (a group Telegram upgraded to a
 * supergroup has a new id), whether it is a channel's discussion group; then where the bot's
 * updates go and whether Telegram is holding any back. To tell why a message did not count.
 * Never prints the bot token, a group's name or its id.
 *
 *   DATABASE_URL=… TELEGRAM_BOT_TOKEN=… npx tsx scripts/ops/telegram-groups.ts
 *
 * The Inspect workflow runs it after the database report.
 */
import { appendFileSync } from 'node:fs';
import postgres from 'postgres';
import { TELEGRAM_API_BASE_URL } from '../../apps/worker/src/telegram';
import { secretValue } from '../deploy/prepare';

interface Answer {
  ok: boolean;
  result?: Record<string, unknown>;
  description?: string;
  parameters?: { migrate_to_chat_id?: number };
}

async function ask(token: string, method: string, params: object = {}): Promise<Answer> {
  try {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return ((await response.json().catch(() => null)) as Answer | null) ?? { ok: false };
  } catch {
    // The address holds the token: say nothing of the error.
    return { ok: false, description: 'unreachable' };
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'an address that is not one';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '?';
}

/** Telegram's own words, without the ids it sometimes quotes. */
function clean(description: string | undefined): string {
  return (description ?? 'no answer').replace(/-?\d{5,}/g, '…');
}

async function main() {
  const lines: string[] = ['### Telegram groups, as Telegram sees them', ''];
  const out = (line = '') => {
    lines.push(line);
    console.info(line);
  };
  const token = secretValue('TELEGRAM_BOT_TOKEN', process.env.TELEGRAM_BOT_TOKEN);
  const url = process.env.DATABASE_URL;
  if (!token || !url) {
    out('TELEGRAM_BOT_TOKEN or DATABASE_URL is not set: nothing to check.');
  } else {
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const sql = postgres(url, {
      max: 1,
      ssl: local ? false : 'require',
      prepare: !url.includes(':6543'),
      onnotice: () => {},
    });
    try {
      const me = await ask(token, 'getMe');
      const botId = me.result?.id;
      const chats = await sql<
        {
          company_id: string;
          chat_id: string;
          left_at: Date | null;
          last_message_at: Date | null;
        }[]
      >`select company_id, chat_id, left_at, last_message_at from stayput.telegram_chats
         order by company_id, connected_at`;
      if (chats.length === 0) out('No group connected.');
      else {
        out(
          '| company | stored as | Telegram says | channel discussion | bot in it | left_at | last_message_at |',
        );
        out('| --- | --- | --- | --- | --- | --- | --- |');
      }
      for (const chat of chats) {
        const stored = chat.chat_id.startsWith('-100') ? 'supergroup' : 'group';
        const info = await ask(token, 'getChat', { chat_id: chat.chat_id });
        const said = info.ok
          ? text(info.result?.type)
          : info.parameters?.migrate_to_chat_id
            ? 'upgraded to a supergroup: StayPut still has the old id'
            : clean(info.description);
        const discussion = info.ok ? (info.result?.linked_chat_id ? 'yes' : 'no') : '';
        const member =
          typeof botId === 'number'
            ? await ask(token, 'getChatMember', { chat_id: chat.chat_id, user_id: botId })
            : null;
        const status = member?.ok ? text(member.result?.status) : clean(member?.description);
        const when = (d: Date | null) => (d ? d.toISOString().replace('.000Z', 'Z') : '');
        out(
          `| ${chat.company_id} | ${stored} | ${said} | ${discussion} | ${status} | ${when(
            chat.left_at,
          )} | ${when(chat.last_message_at)} |`,
        );
      }
      const hook = await ask(token, 'getWebhookInfo');
      const info = hook.result ?? {};
      const target = typeof info.url === 'string' && info.url ? originOf(info.url) : 'none';
      out();
      out(
        `Updates go to ${target}; ${Number(info.pending_update_count ?? 0)} waiting at Telegram.`,
      );
      if (typeof info.last_error_date === 'number') {
        out(
          `Last delivery error, ${new Date(info.last_error_date * 1000).toISOString()}: ${clean(
            typeof info.last_error_message === 'string' ? info.last_error_message : undefined,
          )}.`,
        );
      }
      const allowed = Array.isArray(info.allowed_updates) ? info.allowed_updates.join(', ') : '';
      out(`Updates asked for: ${allowed || 'every kind but a few (Telegram default)'}.`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${lines.join('\n')}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'failed');
  process.exitCode = 1;
});
