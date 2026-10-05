import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkDiscord, checkTelegram, type Finding } from '../../../scripts/deploy/check-bots';
import { checkWhopKey, deployedVar } from '../../../scripts/deploy/check-whop';
import {
  hyperdriveName,
  hyperdriveOrigin,
  sameOrigin,
  withHyperdriveBinding,
} from '../../../scripts/deploy/hyperdrive';
import {
  cloudflareAccountId,
  describeValue,
  prepare,
  secretValue,
  settingName,
  targetProblem,
} from '../../../scripts/deploy/prepare';
import {
  SATOSHI_FILE,
  checkSatoshi,
  readZip,
  satoshiFiles,
  sha256,
} from '../../../scripts/deploy/satoshi';

const ID = '0123456789abcdef0123456789abcdef';

describe('hyperdriveName', () => {
  it('gives each deployment its own configuration, the sandbox keeping its first one', () => {
    expect(hyperdriveName(undefined)).toBe('stayput-db');
    expect(hyperdriveName('sandbox')).toBe('stayput-db');
    expect(hyperdriveName('production')).toBe('stayput-db-production');
  });
});

describe('withHyperdriveBinding', () => {
  it('adds the binding to the committed wrangler.toml, where it is only a comment', () => {
    const toml = '[vars]\nWHOP_ENV = "sandbox"\n# [[hyperdrive]]\n# binding = "HYPERDRIVE"\n';
    expect(withHyperdriveBinding(toml, ID)).toBe(
      `${toml.trimEnd()}\n\n[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${ID}"\n`,
    );
  });

  it('leaves an active binding alone and refuses an odd id', () => {
    const toml = `[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${ID}"\n`;
    expect(withHyperdriveBinding(toml, ID)).toBe(toml);
    expect(() => withHyperdriveBinding('', 'x"\n[evil]')).toThrow(/unexpected Hyperdrive id/);
  });
});

describe('hyperdriveOrigin', () => {
  const ref = 'abcdefghij0123456789';
  const pooler = `postgresql://postgres.${ref}:p%40ss%2Fword@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`;

  it("turns Supabase's session pooler URI into its direct connection, same password", () => {
    const direct = new URL(hyperdriveOrigin(pooler));
    expect(direct.hostname).toBe(`db.${ref}.supabase.co`);
    expect(direct.port).toBe('5432');
    expect(direct.username).toBe('postgres');
    expect(decodeURIComponent(direct.password)).toBe('p@ss/word');
    expect(direct.pathname).toBe('/postgres');
    expect(hyperdriveOrigin(pooler.replace(':5432/', ':6543/'))).toContain(':5432/');
  });

  it('keeps any other URI as it is', () => {
    const direct = `postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`;
    expect(hyperdriveOrigin(direct)).toBe(direct);
    expect(hyperdriveOrigin('postgres://u:p@localhost:5432/db')).toBe(
      'postgres://u:p@localhost:5432/db',
    );
  });

  it('tells whether the Hyperdrive configuration already points there', () => {
    const origin = hyperdriveOrigin(pooler);
    const current = {
      host: `db.${ref}.supabase.co`,
      port: 5432,
      user: 'postgres',
      database: 'postgres',
    };
    expect(sameOrigin(current, origin)).toBe(true);
    expect(sameOrigin({ ...current, host: 'aws-0-eu-west-3.pooler.supabase.com' }, origin)).toBe(
      false,
    );
    expect(sameOrigin({ ...current, user: `postgres.${ref}` }, origin)).toBe(false);
    expect(sameOrigin(undefined, origin)).toBe(false);
  });
});

describe('cloudflareAccountId', () => {
  it('reads the id alone, or inside a dashboard address pasted by mistake', () => {
    expect(cloudflareAccountId(ID)).toBe(ID);
    expect(cloudflareAccountId(` ${ID.toUpperCase()}\n`)).toBe(ID);
    expect(
      cloudflareAccountId(
        `https://dash.cloudflare.com/${ID}/workers/services/view/stayput/production/settings`,
      ),
    ).toBe(ID);
  });

  it('finds nothing in a value without a 32-character id', () => {
    expect(cloudflareAccountId(undefined)).toBeNull();
    expect(cloudflareAccountId('my-account')).toBeNull();
    expect(cloudflareAccountId(`${ID}0`)).toBeNull();
  });
});

describe('secretValue', () => {
  it('keeps a value pasted alone, spaces aside', () => {
    expect(secretValue('WHOP_API_KEY', ' apik_abc \n')).toBe('apik_abc');
    expect(secretValue('WHOP_WEBHOOK_SECRET', 'ws_a=b')).toBe('ws_a=b');
  });

  it('drops the .env line around it, as Whop shows the key', () => {
    expect(secretValue('WHOP_API_KEY', 'WHOP_API_KEY=apik_abc')).toBe('apik_abc');
    expect(secretValue('WHOP_API_KEY', 'WHOP_API_KEY="apik_abc"')).toBe('apik_abc');
    expect(secretValue('WHOP_API_KEY', "'apik_abc'")).toBe('apik_abc');
    expect(
      secretValue('WHOP_API_KEY', 'NEXT_PUBLIC_WHOP_APP_ID=app_x\r\nWHOP_API_KEY=apik_abc\n'),
    ).toBe('apik_abc');
    expect(secretValue('WHOP_API_KEY', 'WHOP_API_KEY=')).toBe('');
    expect(secretValue('WHOP_API_KEY', undefined)).toBe('');
  });

  it('reads the other ways of writing that line', () => {
    expect(secretValue('WHOP_API_KEY', 'WHOP_API_KEY = apik_abc')).toBe('apik_abc');
    expect(secretValue('WHOP_API_KEY', 'WHOP_API_KEY: "apik_abc"')).toBe('apik_abc');
    expect(secretValue('WHOP_API_KEY', 'export WHOP_API_KEY=apik_abc')).toBe('apik_abc');
    expect(secretValue('WHOP_API_KEY', 'OTHER_WHOP_API_KEY=apik_abc')).toBe(
      'OTHER_WHOP_API_KEY=apik_abc',
    );
  });

  it("keeps the one line that assigns no other variable (Whop's block pasted in part)", () => {
    expect(secretValue('WHOP_API_KEY', 'apik_abc\nNEXT_PUBLIC_WHOP_APP_ID=app_x')).toBe('apik_abc');
    expect(secretValue('WHOP_API_KEY', 'NEXT_PUBLIC_WHOP_APP_ID=app_x\n"apik_abc"\n')).toBe(
      'apik_abc',
    );
    // A key cut in two, or two values: no way to tell which is right, so nothing is dropped.
    expect(secretValue('WHOP_API_KEY', 'apik_ab\ncd')).toBe('apik_ab\ncd');
    expect(secretValue('WHOP_API_KEY', 'apik_abc\nws_def\nNEXT_PUBLIC_WHOP_APP_ID=app_x')).toBe(
      'apik_abc\nws_def\nNEXT_PUBLIC_WHOP_APP_ID=app_x',
    );
  });
});

describe('describeValue', () => {
  it('describes each line by its known beginning and its length, never its secret part', () => {
    expect(describeValue('apik_abcdef\nws_12345\n')).toBe(
      '2 lines: apik_… (11 characters); ws_… (8 characters)',
    );
    expect(describeValue(' NEXT_PUBLIC_WHOP_APP_ID="app_x"\r\nsomething')).toBe(
      '2 lines: NEXT_PUBLIC_WHOP_APP_ID=… (31 characters); other text (9 characters)',
    );
  });

  it('names the other public beginnings a wrong paste may have', () => {
    expect(describeValue('hook_abc')).toBe('1 line: hook_… (8 characters)');
    expect(describeValue('https://stayput.example/webhooks/whop')).toBe(
      '1 line: https://… (37 characters)',
    );
  });

  it('never takes a key followed by "=" for a variable name', () => {
    const shape = describeValue('apik_SeCrEt123=\nABC');
    expect(shape).toBe('2 lines: apik_… (15 characters); other text (3 characters)');
    expect(shape).not.toContain('SeCrEt');
  });
});

describe('prepare', () => {
  it('requires Cloudflare and the database, and only warns about Whop', () => {
    expect(prepare({})).toEqual({
      target: 'sandbox',
      targetProblem: null,
      accountId: null,
      missingRequired: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_DB_URL'],
      missingOptional: ['WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET'],
      modules: { discord: false, telegram: false },
      cleaned: [],
      malformed: [],
      secrets: {},
    });
  });

  it('uploads the optional modules when set, and never warns about them', () => {
    const result = prepare({
      CLOUDFLARE_API_TOKEN: 't',
      CLOUDFLARE_ACCOUNT_ID: ID,
      SUPABASE_DB_URL: 'x',
      DISCORD_BOT_TOKEN: 'MTIz.GAbc.def',
      TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN=123456:AAbc-def',
    });
    expect(result.secrets).toEqual({
      DISCORD_BOT_TOKEN: 'MTIz.GAbc.def',
      TELEGRAM_BOT_TOKEN: '123456:AAbc-def',
    });
    // Discord also needs the client secret to add its bot to a server.
    expect(result.modules).toEqual({ discord: false, telegram: true });
    expect(result.missingOptional).toEqual(['WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET']);
    expect(prepare({ DISCORD_BOT_TOKEN: 'a', DISCORD_CLIENT_SECRET: 'b' }).modules.discord).toBe(
      true,
    );
    expect(prepare({ TELEGRAM_BOT_TOKEN: '123:a b' }).malformed).toEqual([
      { name: 'TELEGRAM_BOT_TOKEN', shape: '1 line: other text (7 characters)' },
    ]);
  });

  it('refuses production without its own app id (the sandbox one is in wrangler.toml)', () => {
    const base = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: ID, SUPABASE_DB_URL: 'x' };
    expect(prepare({ ...base, WHOP_ENV: 'production' }).missingRequired).toEqual(['WHOP_APP_ID']);
    expect(
      prepare({ ...base, WHOP_ENV: 'production', WHOP_APP_ID: 'app_prod' }).missingRequired,
    ).toEqual([]);
    expect(prepare({ ...base, WHOP_ENV: 'sandbox' }).missingRequired).toEqual([]);
  });

  it('deploys production only with Whop’s production, and the sandbox only without', () => {
    expect(targetProblem('production', 'production')).toBeNull();
    expect(targetProblem(undefined, undefined)).toBeNull();
    expect(targetProblem('sandbox', 'sandbox')).toBeNull();
    expect(targetProblem('production', undefined)).toMatch(/needs WHOP_ENV=production/);
    expect(targetProblem('sandbox', 'production')).toMatch(/deploy to production instead/);
    expect(targetProblem('staging', 'sandbox')).toMatch(/unknown deployment target/);
    expect(prepare({ STAYPUT_TARGET: 'production', WHOP_ENV: 'production' })).toMatchObject({
      target: 'production',
      targetProblem: null,
    });
  });

  it('reads production’s own settings as PRODUCTION_…, never the sandbox’s', () => {
    const shared = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: ID };
    const production = { ...shared, STAYPUT_TARGET: 'production', WHOP_ENV: 'production' };
    // Whop's key, webhook secret and app, the database and the operator: all required, each
    // named as the founder stores it.
    expect(prepare(production).missingRequired).toEqual([
      'PRODUCTION_SUPABASE_DB_URL',
      'PRODUCTION_WHOP_APP_ID',
      'PRODUCTION_WHOP_API_KEY',
      'PRODUCTION_WHOP_WEBHOOK_SECRET',
      'PRODUCTION_OPERATOR_COMPANY_ID',
    ]);
    const complete = {
      ...production,
      SUPABASE_DB_URL: 'postgresql://db',
      WHOP_APP_ID: 'app_Prod1',
      WHOP_API_KEY: 'apik_prod',
      WHOP_WEBHOOK_SECRET: 'ws_prod',
      OPERATOR_COMPANY_ID: 'biz_Prod1',
    };
    expect(prepare(complete)).toMatchObject({
      missingRequired: [],
      missingOptional: [],
      // Under the names the Worker reads.
      secrets: { WHOP_API_KEY: 'apik_prod', WHOP_WEBHOOK_SECRET: 'ws_prod' },
    });
    // An address pasted for an id is unreadable; a secret that is not one value is named as
    // stored.
    expect(
      prepare({ ...complete, OPERATOR_COMPANY_ID: 'https://whop.com/dashboard/biz_Prod1/' })
        .missingRequired,
    ).toEqual(['PRODUCTION_OPERATOR_COMPANY_ID']);
    expect(prepare({ ...complete, WHOP_API_KEY: 'apik_a b' })).toMatchObject({
      missingRequired: [],
      malformed: [{ name: 'PRODUCTION_WHOP_API_KEY', shape: '1 line: apik_… (8 characters)' }],
    });
    expect(settingName('SUPABASE_DB_URL', 'production')).toBe('PRODUCTION_SUPABASE_DB_URL');
    expect(settingName('TELEGRAM_BOT_TOKEN', 'production')).toBe('PRODUCTION_TELEGRAM_BOT_TOKEN');
    expect(settingName('CLOUDFLARE_API_TOKEN', 'production')).toBe('CLOUDFLARE_API_TOKEN');
    expect(settingName('SUPABASE_DB_URL', 'sandbox')).toBe('SUPABASE_DB_URL');
  });

  it('uploads the cleaned value and says which secret needed it', () => {
    const result = prepare({
      CLOUDFLARE_API_TOKEN: 't',
      CLOUDFLARE_ACCOUNT_ID: ID,
      SUPABASE_DB_URL: 'x',
      WHOP_API_KEY: 'WHOP_API_KEY=apik_abc',
      WHOP_WEBHOOK_SECRET: 'WHOP_WEBHOOK_SECRET=',
    });
    expect(result.secrets).toEqual({ WHOP_API_KEY: 'apik_abc' });
    expect(result.cleaned).toEqual(['WHOP_API_KEY']);
    expect(result.missingOptional).toEqual(['WHOP_WEBHOOK_SECRET']);
  });

  it('refuses a secret that is not one single value, and says what it looks like', () => {
    const result = prepare({
      CLOUDFLARE_API_TOKEN: 't',
      CLOUDFLARE_ACCOUNT_ID: ID,
      SUPABASE_DB_URL: 'x',
      WHOP_API_KEY: 'apik_abc\nws_def',
    });
    expect(result.secrets).toEqual({});
    expect(result.malformed).toEqual([
      { name: 'WHOP_API_KEY', shape: '2 lines: apik_… (8 characters); ws_… (6 characters)' },
    ]);
    expect(result.missingOptional).toEqual(['WHOP_WEBHOOK_SECRET']);
  });

  it('keeps only the Worker secrets that are set', () => {
    const result = prepare({
      CLOUDFLARE_API_TOKEN: 't',
      CLOUDFLARE_ACCOUNT_ID: `https://dash.cloudflare.com/${ID}/home`,
      SUPABASE_DB_URL: 'postgres://x',
      WHOP_API_KEY: ' key ',
      WHOP_WEBHOOK_SECRET: '',
      WHOP_APP_ID: 'app_1',
    });
    expect(result.accountId).toBe(ID);
    expect(result.missingRequired).toEqual([]);
    expect(result.missingOptional).toEqual(['WHOP_WEBHOOK_SECRET']);
    expect(result.secrets).toEqual({ WHOP_API_KEY: 'key' });
  });

  it('treats an account id it cannot read as missing', () => {
    expect(
      prepare({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'oops', SUPABASE_DB_URL: 'x' })
        .missingRequired,
    ).toEqual(['CLOUDFLARE_ACCOUNT_ID']);
  });
});

describe('deployedVar', () => {
  const toml = '[vars]\n# "sandbox" first\nWHOP_ENV = "sandbox"\nWHOP_APP_ID = "app_sandbox"\n';

  it("reads wrangler.toml's value unless the repository variable is set", () => {
    expect(deployedVar('WHOP_ENV', undefined, toml)).toBe('sandbox');
    expect(deployedVar('WHOP_ENV', ' ', toml)).toBe('sandbox');
    expect(deployedVar('WHOP_ENV', 'production', toml)).toBe('production');
    expect(deployedVar('WHOP_APP_ID', '', toml)).toBe('app_sandbox');
    expect(deployedVar('MISSING', undefined, toml)).toBeUndefined();
  });
});

describe('checkWhopKey', () => {
  const answer = (status: number) => () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { type: `type_${status}`, message: 'm' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const noSleep = () => Promise.resolve();

  it('asks with the access check the Worker makes, about a user that does not exist', async () => {
    const urls: string[] = [];
    const fetch = (input: string) => {
      urls.push(input);
      return answer(404)();
    };
    expect(await checkWhopKey('apik_x', 'sandbox', { fetch, sleep: noSleep })).toEqual({
      check: 'accepted',
      detail: '404 type_404',
    });
    expect(urls).toEqual([
      'https://sandbox-api.whop.com/api/v1/users/user_xxxxxxxxxxxxx/access/biz_xxxxxxxxxxxxxx',
    ]);
  });

  it('fails a key Whop refuses, and only that', async () => {
    const check = async (status: number) =>
      (await checkWhopKey('apik_x', 'production', { fetch: answer(status), sleep: noSleep })).check;
    expect(await check(401)).toBe('refused');
    expect(await check(403)).toBe('accepted');
    expect(await check(422)).toBe('accepted');
    expect(await check(429)).toBe('unreachable');
    expect(await check(503)).toBe('unreachable');
    const never = () => Promise.reject(new Error('Whop must not be called'));
    expect(await checkWhopKey('apik_a\nws_b', 'sandbox', { fetch: never })).toEqual({
      check: 'refused',
      detail: 'not one single value',
    });
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    expect(
      (await checkWhopKey('apik_x', 'sandbox', { fetch: offline, sleep: noSleep })).check,
    ).toBe('unreachable');
  });
});

describe('checkDiscord', () => {
  const ORIGIN = 'https://stayput.example.workers.dev';
  const BOT = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDe.secret-part-of-the-bot-token';
  const SECRET = 'client-secret-0123456789abcdefgh';
  const APP = {
    id: '123456789012345678',
    name: 'StayPut',
    bot_public: true,
    redirect_uris: [`${ORIGIN}/auth/discord/callback`],
    integration_types_config: { '0': {}, '1': {} },
  };
  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  const discord = (
    app: { status: number; body: unknown },
    token: { status: number; body: unknown },
  ) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/applications/@me')
        ? json(app.status, app.body)
        : json(token.status, token.body);
    };
    return { calls, fetch };
  };
  const levels = (findings: Finding[]) => findings.map((f) => f.level);
  const never = (findings: Finding[]) => {
    for (const { text } of findings) {
      expect(text).not.toContain(BOT);
      expect(text).not.toContain(SECRET);
    }
  };

  it('asks for the application with the bot token, then tries the secret on a made-up code', async () => {
    const { calls, fetch } = discord(
      { status: 200, body: APP },
      { status: 400, body: { error: 'invalid_grant' } },
    );
    const findings = await checkDiscord(
      { botToken: BOT, clientSecret: SECRET, origin: ORIGIN },
      { fetch },
    );
    expect(levels(findings)).toEqual(['ok', 'ok', 'ok']);
    expect(findings[0]?.text).toContain('« StayPut » (123456789012345678)');
    expect(findings[2]?.text).toContain(`${ORIGIN}/auth/discord/callback`);
    never(findings);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', 'https://discord.com/api/v10/applications/@me'],
      ['POST', 'https://discord.com/api/v10/oauth2/token'],
    ]);
    const headers = (i: number) => calls[i]?.init.headers as Record<string, string>;
    expect(headers(0).Authorization).toBe(`Bot ${BOT}`);
    expect(headers(1).Authorization).toBe(
      `Basic ${Buffer.from(`${APP.id}:${SECRET}`).toString('base64')}`,
    );
    const form = new URLSearchParams(calls[1]?.init.body as string);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('stayput-deploy-check');
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/auth/discord/callback`);
  });

  it('stops at a refused bot token, and says when it is not a bot token at all', async () => {
    const { calls, fetch } = discord(
      { status: 401, body: { message: '401: Unauthorized' } },
      {
        status: 500,
        body: null,
      },
    );
    const refused = await checkDiscord(
      { botToken: BOT, clientSecret: SECRET, origin: ORIGIN },
      { fetch },
    );
    expect(levels(refused)).toEqual(['warning']);
    expect(refused[0]?.text).toContain('Discord refuses DISCORD_BOT_TOKEN (HTTP 401). Developer');
    expect(refused[0]?.text).toContain('Reset Token');
    expect(calls).toHaveLength(1);
    const pasted = await checkDiscord(
      { botToken: 'a'.repeat(64), clientSecret: SECRET, origin: ORIGIN },
      { fetch },
    );
    expect(pasted[0]?.text).toContain('the Client Secret or the Public Key');
    never([...refused, ...pasted]);
  });

  it('names each thing to fix: the secret, the redirect, a private bot, no server install', async () => {
    const { fetch } = discord(
      {
        status: 200,
        body: {
          ...APP,
          bot_public: false,
          redirect_uris: [`${ORIGIN}/auth/discord/callback/`],
          integration_types_config: { '1': {} },
        },
      },
      { status: 401, body: { error: 'invalid_client' } },
    );
    const findings = await checkDiscord(
      { botToken: BOT, clientSecret: SECRET, origin: ORIGIN },
      { fetch },
    );
    expect(levels(findings)).toEqual(['ok', 'warning', 'warning', 'warning', 'warning']);
    expect(findings[1]?.text).toContain('DISCORD_CLIENT_SECRET (HTTP 401 invalid_client)');
    expect(findings[2]?.text).toContain(
      `declared: ${ORIGIN}/auth/discord/callback/). Developer Portal → OAuth2 → Redirects`,
    );
    expect(findings[3]?.text).toContain('Public Bot: on');
    expect(findings[4]?.text).toContain('Guild Install');
    never(findings);
  });

  it('says whether Discord gives StayPut the member list of each server', async () => {
    const check = async (flags: number) => {
      const { fetch } = discord(
        { status: 200, body: { ...APP, flags } },
        { status: 400, body: { error: 'invalid_grant' } },
      );
      return (
        await checkDiscord({ botToken: BOT, clientSecret: SECRET, origin: ORIGIN }, { fetch })
      ).at(-1);
    };
    // On, as GATEWAY_GUILD_MEMBERS_LIMITED (fewer than 100 servers) or in full.
    expect(await check(1 << 15)).toMatchObject({ level: 'ok' });
    expect(await check((1 << 14) | (1 << 23))).toMatchObject({ level: 'ok' });
    const off = await check(1 << 23);
    expect(off?.level).toBe('warning');
    expect(off?.text).toContain('Server Members Intent: on, then Save Changes');
  });

  it('only warns when Discord cannot be asked or says nothing it can be sure of', async () => {
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    expect(
      await checkDiscord(
        { botToken: BOT, clientSecret: SECRET, origin: ORIGIN },
        { fetch: offline },
      ),
    ).toEqual([{ level: 'warning', text: 'Could not ask Discord (unreachable).' }]);
    const { fetch } = discord(
      { status: 200, body: { id: APP.id, name: 'StayPut' } },
      { status: 429, body: { message: 'rate limited' } },
    );
    const findings = await checkDiscord(
      { botToken: BOT, clientSecret: SECRET, origin: ORIGIN },
      { fetch },
    );
    expect(levels(findings)).toEqual(['ok', 'warning', 'note']);
    expect(findings[1]?.text).toBe(
      'Could not tell whether Discord accepts DISCORD_CLIENT_SECRET (HTTP 429).',
    );
  });
});

describe('checkTelegram', () => {
  const ORIGIN = 'https://stayput.example.workers.dev';
  const TOKEN = '123456789:AAHsecret-part-of-the-telegram-token';
  const telegram = (me: { status: number; body: unknown }, hook: unknown) => {
    const methods: string[] = [];
    const fetch = (url: string, init: RequestInit) => {
      const method = url.split('/').pop() ?? '';
      methods.push(`${init.method} ${url.replace(TOKEN, '<token>')}`);
      const answer = method === 'getMe' ? me : { status: 200, body: { ok: true, result: hook } };
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    return { methods, fetch };
  };
  const BOT = {
    id: 1,
    is_bot: true,
    username: 'StayPutBot',
    can_join_groups: true,
    can_read_all_group_messages: true,
  };
  const never = (findings: Finding[]) => {
    for (const { text } of findings) expect(text).not.toContain(TOKEN.split(':')[1]);
  };

  it('reads the bot (getMe) and where its updates go, as the Worker calls Telegram', async () => {
    const { methods, fetch } = telegram(
      { status: 200, body: { ok: true, result: BOT } },
      { url: '' },
    );
    const findings = await checkTelegram({ botToken: TOKEN, origin: ORIGIN }, { fetch });
    expect(findings).toEqual([
      { level: 'ok', text: 'Telegram accepts TELEGRAM_BOT_TOKEN: @StayPutBot.' },
      {
        level: 'ok',
        text: 'Privacy mode is off: the bot sees every message of its groups (StayPut keeps only who wrote, where and when).',
      },
      {
        level: 'note',
        text: 'No webhook yet: StayPut sets it the first time « Activity sources » is opened.',
      },
    ]);
    expect(methods).toEqual([
      'POST https://api.telegram.org/bot<token>/getMe',
      'POST https://api.telegram.org/bot<token>/getWebhookInfo',
    ]);
  });

  it('names what to change in BotFather: privacy mode, groups, and the webhook state', async () => {
    const quiet = { ...BOT, can_join_groups: false, can_read_all_group_messages: false };
    const own = await checkTelegram(
      { botToken: TOKEN, origin: ORIGIN },
      {
        fetch: telegram(
          { status: 200, body: { ok: true, result: quiet } },
          {
            url: `${ORIGIN}/webhooks/telegram`,
            pending_update_count: 2,
            last_error_date: 1_790_000_000,
            last_error_message: 'Wrong response from the webhook: 401 Unauthorized',
          },
        ).fetch,
      },
    );
    expect(own.map((f) => f.level)).toEqual(['ok', 'warning', 'warning', 'ok', 'warning']);
    expect(own[1]?.text).toContain('/setjoingroups → @StayPutBot → Enable');
    expect(own[2]?.text).toContain('/setprivacy → @StayPutBot → Disable');
    expect(own[3]?.text).toBe(
      `Telegram sends the updates to ${ORIGIN}/webhooks/telegram (2 waiting).`,
    );
    expect(own[4]?.text).toContain('401 Unauthorized');
    const elsewhere = await checkTelegram(
      { botToken: TOKEN, origin: ORIGIN },
      {
        fetch: telegram(
          { status: 200, body: { ok: true, result: BOT } },
          { url: 'https://other.example/hook?key=abc' },
        ).fetch,
      },
    );
    expect(elsewhere[2]).toEqual({
      level: 'warning',
      text:
        'The updates go to https://other.example, not to StayPut: open « Activity sources »' +
        ` once and StayPut points them back to ${ORIGIN}/webhooks/telegram.`,
    });
    never([...own, ...elsewhere]);
  });

  it('says a token is refused (401, or 404 when it is not even shaped like one)', async () => {
    const refused = await checkTelegram(
      { botToken: TOKEN, origin: ORIGIN },
      {
        fetch: telegram(
          { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } },
          null,
        ).fetch,
      },
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]?.text).toContain('Telegram refuses TELEGRAM_BOT_TOKEN (HTTP 401). In');
    const shapeless = await checkTelegram(
      { botToken: 'AAHsecret-without-the-bot-id', origin: ORIGIN },
      {
        fetch: telegram(
          { status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } },
          null,
        ).fetch,
      },
    );
    expect(shapeless[0]?.text).toContain('(HTTP 404). It does not look like a bot token');
    const offline = () => Promise.reject(new TypeError(`fetch failed: ${TOKEN}`));
    expect(await checkTelegram({ botToken: TOKEN, origin: ORIGIN }, { fetch: offline })).toEqual([
      { level: 'warning', text: 'Could not ask Telegram (unreachable).' },
    ]);
    never([...refused, ...shapeless]);
  });
});

/** A zip archive as zip tools write it: each file stored or deflated, then the directory. */
function zipOf(files: readonly { name: string; text: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const raw = Buffer.from(file.text);
    const data = file.deflate ? deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(file.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    directory.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

describe('Satoshi, downloaded at deployment', () => {
  const zip = zipOf([
    { name: 'Satoshi_Complete/License/FFL.txt', text: 'ITF Free Font License', deflate: true },
    { name: 'Satoshi_Complete/Fonts/WEB/fonts/Satoshi-VariableItalic.woff2', text: 'italic' },
    { name: `Satoshi_Complete/Fonts/WEB/fonts/${SATOSHI_FILE}`, text: 'wOF2 upright' },
  ]);

  it('reads the files of a zip archive, stored or deflated', () => {
    const entries = readZip(zip);
    expect(entries.map((entry) => entry.name)).toEqual([
      'Satoshi_Complete/License/FFL.txt',
      'Satoshi_Complete/Fonts/WEB/fonts/Satoshi-VariableItalic.woff2',
      `Satoshi_Complete/Fonts/WEB/fonts/${SATOSHI_FILE}`,
    ]);
    expect(entries[0]?.read().toString()).toBe('ITF Free Font License');
    expect(entries[2]?.read().toString()).toBe('wOF2 upright');
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/not a zip archive/);
  });

  it('takes the upright variable font and the license, never the italic', () => {
    const { font, licenses } = satoshiFiles(readZip(zip));
    expect(font?.read().toString()).toBe('wOF2 upright');
    expect(licenses.map((license) => license.name)).toEqual(['Satoshi_Complete/License/FFL.txt']);
  });

  it('serves only the file reviewed, once its fingerprint is pinned', () => {
    const digest = sha256(Buffer.from('wOF2 upright'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(checkSatoshi(digest, '')).toBe('unpinned');
    expect(checkSatoshi(digest, digest)).toBe('reviewed');
    expect(checkSatoshi(digest, sha256(Buffer.from('another file')))).toBe('changed');
  });
});
