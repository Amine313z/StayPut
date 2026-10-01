/**
 * Deployment step (.github/workflows/deploy.yml), once the Worker answers: asks Discord and
 * Telegram whether they accept the optional modules' secrets, and whether what a creator relies
 * on is in place. Discord: the bot token, the client secret, the redirect back to StayPut, a bot
 * that any server can add. Telegram: the bot token, privacy mode off, groups allowed, where the
 * updates go. A module whose secrets are not set is off and not checked (prepare.ts decides).
 *
 * A problem is a warning, never a failure: the modules are optional, and a deployment that fixes
 * something else must not wait on them. Never prints a secret; Telegram's addresses hold the bot
 * token, so no request address is ever repeated.
 *
 *   tsx scripts/deploy/check-bots.ts https://stayput.<account>.workers.dev
 */
import { appendFileSync } from 'node:fs';
import { DISCORD_API_BASE_URL } from '../../apps/worker/src/discord';
import { DISCORD_CALLBACK_PATH, TELEGRAM_WEBHOOK_PATH } from '../../apps/worker/src/integrations';
import { TELEGRAM_API_BASE_URL } from '../../apps/worker/src/telegram';
import { prepare } from './prepare';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface Finding {
  /** ok: checked and right; warning: to fix, or could not be checked; note: nothing to do. */
  level: 'ok' | 'warning' | 'note';
  text: string;
}

/** A code no Discord user was ever given: only the client secret is on trial. */
const PROBE_CODE = 'stayput-deploy-check';

const DISCORD_USER_AGENT = 'DiscordBot (https://github.com/Amine313z/StayPut, 1.0)';

interface Answer {
  /** 0 when the service could not be reached. */
  status: number;
  body: Record<string, unknown> | null;
}

async function ask(send: Fetch, url: string, init: RequestInit): Promise<Answer> {
  try {
    const response = await send(url, init);
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body: isRecord(body) ? body : null };
  } catch {
    // A network error may quote the address, which holds Telegram's token: say nothing of it.
    return { status: 0, body: null };
  }
}

/** Neither an answer about the secret nor a refusal of it: the service is busy or down. */
function unreachable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

export async function checkDiscord(
  input: { botToken: string; clientSecret: string; origin: string },
  inject: { fetch?: Fetch } = {},
): Promise<Finding[]> {
  const send: Fetch = inject.fetch ?? ((url, init) => fetch(url, init));
  const redirect = `${input.origin}${DISCORD_CALLBACK_PATH}`;

  // The bot token, with the very call the Worker makes first (the application's id).
  const app = await ask(send, `${DISCORD_API_BASE_URL}/applications/@me`, {
    method: 'GET',
    headers: { Authorization: `Bot ${input.botToken}`, 'User-Agent': DISCORD_USER_AGENT },
  });
  if (unreachable(app.status)) {
    return [{ level: 'warning', text: `Could not ask Discord (${describeStatus(app.status)}).` }];
  }
  const id = app.body?.id;
  if (app.status !== 200 || typeof id !== 'string') {
    const shape =
      input.botToken.split('.').length === 3
        ? ''
        : ' It does not look like a bot token (three parts separated by dots): the Client' +
          ' Secret or the Public Key may have been stored instead.';
    return [
      {
        level: 'warning',
        text:
          `Discord refuses DISCORD_BOT_TOKEN (${describeStatus(app.status)}).${shape} Developer Portal → the` +
          ' application → Bot → Reset Token, then store the new token in the DISCORD_BOT_TOKEN' +
          ' secret.',
      },
    ];
  }
  const name = typeof app.body?.name === 'string' ? app.body.name : 'without a name';
  const findings: Finding[] = [
    { level: 'ok', text: `Discord accepts DISCORD_BOT_TOKEN: application « ${name} » (${id}).` },
  ];

  // The client secret, on a made-up code: Discord checks the secret before the code.
  const authorization = `Basic ${Buffer.from(`${id}:${input.clientSecret}`).toString('base64')}`;
  const exchange = await ask(send, `${DISCORD_API_BASE_URL}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': DISCORD_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: PROBE_CODE,
      redirect_uri: redirect,
    }).toString(),
  });
  const error = typeof exchange.body?.error === 'string' ? exchange.body.error : null;
  if (exchange.status === 401 || error === 'invalid_client') {
    findings.push({
      level: 'warning',
      text:
        `Discord refuses DISCORD_CLIENT_SECRET (${describeStatus(exchange.status)}${
          error ? ` ${error}` : ''
        }). Developer Portal → the application → OAuth2 → Client Secret → Reset Secret, then` +
        ' store the new secret in the DISCORD_CLIENT_SECRET secret.',
    });
  } else if (exchange.status === 400 && error === 'invalid_grant') {
    findings.push({
      level: 'ok',
      text: 'Discord accepts DISCORD_CLIENT_SECRET (a made-up code is refused, as expected).',
    });
  } else {
    findings.push({
      level: 'warning',
      text: `Could not tell whether Discord accepts DISCORD_CLIENT_SECRET (${describeStatus(
        exchange.status,
      )}${error ? ` ${error}` : ''}).`,
    });
  }

  // Where Discord sends the creator back: refused by Discord unless declared on the application.
  const redirects = app.body?.redirect_uris;
  if (!Array.isArray(redirects)) {
    findings.push({
      level: 'note',
      text: `Discord did not list the redirects: check that ${redirect} is under OAuth2 → Redirects.`,
    });
  } else if (redirects.includes(redirect)) {
    findings.push({ level: 'ok', text: `The redirect ${redirect} is declared.` });
  } else {
    const declared = redirects.filter(isString);
    findings.push({
      level: 'warning',
      text:
        `The redirect ${redirect} is not declared (declared: ${
          declared.length > 0 ? declared.join(', ') : 'none'
        }). Developer Portal → OAuth2 → Redirects → Add Redirect, paste it exactly, then Save` +
        ' Changes.',
    });
  }

  // Creators add the bot to their own servers: a private bot only joins its owner's.
  if (app.body?.bot_public === false) {
    findings.push({
      level: 'warning',
      text:
        'The bot is private: only the owner of the application can add it to a server, creators' +
        ' could not. Developer Portal → Bot → Public Bot: on, then Save Changes.',
    });
  }
  const contexts = app.body?.integration_types_config;
  if (isRecord(contexts) && Object.keys(contexts).length > 0 && !('0' in contexts)) {
    findings.push({
      level: 'warning',
      text:
        'Servers cannot install the application. Developer Portal → Installation →' +
        ' Installation Contexts: tick Guild Install, then Save Changes.',
    });
  }
  // Everyone on a server, not only who writes (migration 0017): Discord gives a server's member
  // list only to an application with the Server Members Intent on (GATEWAY_GUILD_MEMBERS, or
  // its _LIMITED form under 100 servers).
  const flags = app.body?.flags;
  if (typeof flags === 'number') {
    findings.push(
      (flags & (SERVER_MEMBERS_INTENT | SERVER_MEMBERS_INTENT_LIMITED)) !== 0
        ? {
            level: 'ok',
            text: 'The Server Members Intent is on: StayPut reads the member list of each server.',
          }
        : {
            level: 'warning',
            text:
              'The Server Members Intent is off: StayPut only sees who writes on Discord, not' +
              ' everyone on the server. Developer Portal → the application → Bot → Privileged' +
              ' Gateway Intents → Server Members Intent: on, then Save Changes.',
          },
    );
  }
  return findings;
}

/** The application flags of the Server Members Intent (Discord's ApplicationFlags). */
const SERVER_MEMBERS_INTENT = 1 << 14;
const SERVER_MEMBERS_INTENT_LIMITED = 1 << 15;

export async function checkTelegram(
  input: { botToken: string; origin: string },
  inject: { fetch?: Fetch } = {},
): Promise<Finding[]> {
  const send: Fetch = inject.fetch ?? ((url, init) => fetch(url, init));
  const call = (method: string) =>
    ask(send, `${TELEGRAM_API_BASE_URL}/bot${input.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

  // The bot token, with the very call the Worker makes (getMe).
  const me = await call('getMe');
  if (unreachable(me.status)) {
    return [{ level: 'warning', text: `Could not ask Telegram (${describeStatus(me.status)}).` }];
  }
  const bot = isRecord(me.body?.result) ? me.body.result : null;
  const username = typeof bot?.username === 'string' ? bot.username : null;
  if (me.status !== 200 || me.body?.ok !== true || !bot || !username) {
    const shape = /^[0-9]+:[A-Za-z0-9_-]+$/.test(input.botToken)
      ? ''
      : ' It does not look like a bot token (digits, a colon, then letters: 123456789:ABC…).';
    return [
      {
        level: 'warning',
        text:
          `Telegram refuses TELEGRAM_BOT_TOKEN (${describeStatus(me.status)}).${shape} In Telegram, @BotFather →` +
          ' /mybots → the bot → API Token, then store it in the TELEGRAM_BOT_TOKEN secret.',
      },
    ];
  }
  const findings: Finding[] = [
    { level: 'ok', text: `Telegram accepts TELEGRAM_BOT_TOKEN: @${username}.` },
  ];
  if (bot.can_join_groups === false) {
    findings.push({
      level: 'warning',
      text: `The bot cannot be added to groups. @BotFather → /setjoingroups → @${username} → Enable.`,
    });
  }
  if (bot.can_read_all_group_messages === true) {
    findings.push({
      level: 'ok',
      text: 'Privacy mode is off: the bot sees every message of its groups (StayPut keeps only who and when).',
    });
  } else {
    findings.push({
      level: 'warning',
      text:
        'Privacy mode is on: the bot would only see the commands, not the members’ messages.' +
        ` @BotFather → /setprivacy → @${username} → Disable. A group the bot is already in keeps` +
        ' the old mode until the bot is removed and added again.',
    });
  }

  // Where Telegram sends the updates: set by the Worker when « Activity sources » first asks
  // for the link that adds the bot to a group (ensureTelegramWebhook).
  const expected = `${input.origin}${TELEGRAM_WEBHOOK_PATH}`;
  const hook = await call('getWebhookInfo');
  const info = isRecord(hook.body?.result) ? hook.body.result : null;
  const url = typeof info?.url === 'string' ? info.url : null;
  if (!info || url === null) {
    findings.push({
      level: 'warning',
      text: `Could not read where Telegram sends the updates (${describeStatus(hook.status)}).`,
    });
  } else if (url === '') {
    findings.push({
      level: 'note',
      text: 'No webhook yet: StayPut sets it the first time « Activity sources » is opened.',
    });
  } else if (url === expected) {
    const pending = typeof info.pending_update_count === 'number' ? info.pending_update_count : 0;
    findings.push({
      level: 'ok',
      text: `Telegram sends the updates to ${expected}${pending > 0 ? ` (${pending} waiting)` : ''}.`,
    });
    const lastError = info.last_error_message;
    const lastErrorAt = info.last_error_date;
    if (typeof lastError === 'string' && typeof lastErrorAt === 'number') {
      findings.push({
        level: 'warning',
        text: `Telegram's last delivery error, ${new Date(lastErrorAt * 1000).toISOString()}: ${lastError}.`,
      });
    }
  } else {
    findings.push({
      level: 'warning',
      text:
        `The updates go to ${originOf(url)}, not to StayPut: open « Activity sources » once and` +
        ` StayPut points them back to ${expected}.`,
    });
  }
  return findings;
}

function describeStatus(status: number): string {
  return status === 0 ? 'unreachable' : `HTTP ${status}`;
}

/** Only the origin of an address someone else set: its path or query could hold a secret. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'another address';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

const MARKS: Readonly<Record<Finding['level'], string>> = { ok: '✅', warning: '⚠️', note: 'ℹ️' };

async function main() {
  const [origin] = process.argv.slice(2);
  if (!origin || !/^https:\/\/[a-z0-9.-]+$/.test(origin)) {
    throw new Error('usage: check-bots.ts https://<the Worker address>');
  }
  const { modules, secrets } = prepare(process.env);
  const sections: { title: string; findings: Finding[] }[] = [
    {
      title: 'Discord',
      findings:
        modules.discord && secrets.DISCORD_BOT_TOKEN && secrets.DISCORD_CLIENT_SECRET
          ? await checkDiscord({
              botToken: secrets.DISCORD_BOT_TOKEN,
              clientSecret: secrets.DISCORD_CLIENT_SECRET,
              origin,
            })
          : [
              {
                level: 'note',
                text: 'Off: DISCORD_BOT_TOKEN and DISCORD_CLIENT_SECRET are not both set.',
              },
            ],
    },
    {
      title: 'Telegram',
      findings:
        modules.telegram && secrets.TELEGRAM_BOT_TOKEN
          ? await checkTelegram({ botToken: secrets.TELEGRAM_BOT_TOKEN, origin })
          : [{ level: 'note', text: 'Off: TELEGRAM_BOT_TOKEN is not set.' }],
    },
  ];
  const summary = ['### Discord and Telegram', ''];
  for (const { title, findings } of sections) {
    for (const { level, text } of findings) {
      console.info(level === 'warning' ? `::warning::${title}: ${text}` : `${title}: ${text}`);
      summary.push(`- ${MARKS[level]} ${title}: ${text}`);
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
