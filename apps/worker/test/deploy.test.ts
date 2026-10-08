import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  baseUrlFinding,
  checkRelay,
  readApp,
  readAppSettings,
  relayAnswer,
  settingsFindings,
  type AppSettings,
} from '../../../scripts/deploy/check-app';
import { checkDiscord, checkTelegram, type Finding } from '../../../scripts/deploy/check-bots';
import {
  FREE_PLAN_CRONS,
  PRODUCTION_WORKER,
  accountCrons,
  cronFindings,
  readCrons,
  tomlCrons,
  workerName,
} from '../../../scripts/deploy/check-crons';
import { checkWhopKey, deployedVar } from '../../../scripts/deploy/check-whop';
import {
  hyperdriveName,
  hyperdriveOrigin,
  sameOrigin,
  supabaseRegion,
  withHyperdriveBinding,
  withPlacement,
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
const WRANGLER_TOML = readFileSync(path.resolve(import.meta.dirname, '../wrangler.toml'), 'utf8');

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

describe('withPlacement', () => {
  it("pins the committed wrangler.toml's Worker to the database's region, nothing else", () => {
    const pinned = withPlacement(WRANGLER_TOML, 'eu-west-3');
    expect(pinned).toContain('[placement]\nmode = "targeted"\nregion = "aws:eu-west-3"\n');
    expect(pinned).not.toContain('mode = "smart"');
    // Every other line is kept: the comments, the next table and its own comments.
    expect(pinned.replace('mode = "targeted"\nregion = "aws:eu-west-3"', 'mode = "smart"')).toBe(
      WRANGLER_TOML,
    );
    expect(withPlacement(pinned, 'eu-west-2')).toBe(pinned.replace('eu-west-3', 'eu-west-2'));
  });

  it('refuses an odd region and a wrangler.toml without [placement]', () => {
    expect(() => withPlacement(WRANGLER_TOML, 'eu-west-3"\n[evil]')).toThrow(/unexpected AWS/);
    expect(() => withPlacement('[vars]\nA = "1"\n', 'eu-west-3')).toThrow(/no \[placement\]/);
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

  it("reads the database's region from the pooler's address, and only from it", () => {
    expect(supabaseRegion(pooler)).toBe('eu-west-3');
    expect(supabaseRegion(`postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`)).toBe(
      null,
    );
    expect(supabaseRegion('not a url')).toBe(null);
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

/** Whop's `GET /apps/{id}` answer for an app set as StayPut wants it (fields as of 2026-10-07). */
function whopApp(over: Record<string, unknown> = {}): Record<string, unknown> {
  const asked = [
    'company:basic:read',
    'member:basic:read',
    'access_pass:basic:read',
    'plan:basic:read',
    'payment:basic:read',
    'promo_code:basic:read',
    'shipment:basic:read',
    'chat:read',
    'forum:read',
    'support_chat:read',
    'courses:read',
    'course_analytics:read',
    'webhook_receive:memberships',
    'webhook_receive:payments',
    'webhook_receive:members',
    'webhook_receive:chat',
    'webhook_receive:courses',
    'member:manage',
    'payment:manage',
    'promo_code:create',
    'notification:create',
    'access_pass:create',
    'plan:create',
    'experience:create',
    'experience:attach',
  ];
  return {
    id: 'app_Prod1',
    name: 'StayPut',
    status: 'hidden',
    base_url: null,
    origin: 'https://abc123.apps.whop.com',
    experience_path: '/experiences/[experienceId]',
    dashboard_path: '/dashboard/[companyId]',
    discover_path: '/discover',
    api_key: null,
    requested_permissions: asked.map((action) => ({
      permission_action: { action, name: action },
      is_required: true,
      justification: 'why',
    })),
    ...over,
  };
}

const settingsOf = (over: Record<string, unknown> = {}): AppSettings => {
  const app = readAppSettings(whopApp(over));
  if (!app) throw new Error('not an app');
  return app;
};
const levels = (findings: { level: string }[]) => findings.map((f) => f.level);

describe('readAppSettings', () => {
  it("keeps what StayPut checks of Whop's answer, and nothing that is not an app", () => {
    expect(settingsOf()).toMatchObject({
      status: 'hidden',
      baseUrl: null,
      origin: 'https://abc123.apps.whop.com',
      paths: {
        experience_path: '/experiences/[experienceId]',
        dashboard_path: '/dashboard/[companyId]',
        discover_path: '/discover',
      },
    });
    expect(settingsOf().permissions).toHaveLength(25);
    expect(settingsOf({ discover_path: null, requested_permissions: [] })).toMatchObject({
      paths: { discover_path: null },
      permissions: null,
    });
    expect(readAppSettings(null)).toBeNull();
    expect(readAppSettings({ error: { type: 'not_found' } })).toBeNull();
  });
});

describe('settingsFindings', () => {
  it('passes an app set as StayPut serves it, the status said', () => {
    const findings = settingsFindings(settingsOf(), 'production');
    expect(levels(findings)).toEqual(['ok', 'ok', 'ok', 'ok', 'note']);
    expect(findings.at(-1)?.text).toBe('Status on Whop: hidden.');
  });

  it('stops production on a path typed wrong or left empty, naming where to fix it', () => {
    const findings = settingsFindings(
      settingsOf({ experience_path: '/experiences/[experienceid]', discover_path: null }),
      'production',
    );
    expect(findings.filter((f) => f.level === 'error').map((f) => f.text)).toEqual([
      'App path is "/experiences/[experienceid]" on Whop, StayPut serves /experiences/[experienceId]:' +
        ' type it by hand in Developer → StayPut → Hosting, then Save.',
      'Discover path is empty on Whop, StayPut serves /discover: type it by hand in Developer →' +
        ' StayPut → Hosting, then Save.',
    ]);
  });

  it('only reports in the sandbox, whose app predates the Discover view', () => {
    const findings = settingsFindings(
      settingsOf({ dashboard_path: '/dashboard', discover_path: null }),
      'sandbox',
    );
    expect(levels(findings)).toEqual(['ok', 'warning', 'note', 'ok', 'note']);
  });

  it('wants every permission StayPut needs, and none it never reads (SPEC 8.2)', () => {
    const asked = (whopApp().requested_permissions as Record<string, unknown>[]).filter(
      (p) =>
        !['member:manage', 'chat:read'].includes(
          (p.permission_action as { action: string }).action,
        ),
    );
    const extra = (action: string) => ({
      permission_action: { action, name: action },
      is_required: true,
    });
    const app = settingsOf({
      requested_permissions: [
        ...asked,
        extra('member:email:read'),
        extra('member:phone:read'),
        extra('stats:read'),
      ],
    });
    const production = settingsFindings(app, 'production');
    expect(production.filter((f) => f.level !== 'ok' && f.level !== 'note')).toEqual([
      {
        level: 'error',
        text:
          'The app does not ask for chat:read, member:manage: StayPut cannot work without them.' +
          ' Add them in Developer → StayPut → Permissions.',
      },
      {
        level: 'error',
        text:
          'The app asks for member:email:read and member:phone:read, which StayPut never reads' +
          ' (SPEC 8.2): remove them in Developer → StayPut → Permissions.',
      },
      { level: 'warning', text: 'The app asks for permissions StayPut does not use: stats:read.' },
    ]);
    // The sandbox app still asks for e-mail and phone (Phase 2): said, not held against it.
    expect(
      settingsFindings(app, 'sandbox').find((f) => f.text.includes('never reads'))?.level,
    ).toBe('note');
  });

  it('keeps the Alumni offer optional, and says when Whop lists no permission at all', () => {
    const withoutAlumni = (whopApp().requested_permissions as Record<string, unknown>[]).slice(
      0,
      21,
    );
    const findings = settingsFindings(
      settingsOf({ requested_permissions: withoutAlumni }),
      'production',
    );
    expect(findings.find((f) => f.text.startsWith("The Alumni offer's"))).toEqual({
      level: 'note',
      text:
        "The Alumni offer's permissions are not asked for (access_pass:create, plan:create," +
        ' experience:create, experience:attach): the offer stays off.',
    });
    expect(levels(findings)).not.toContain('error');
    const none = settingsFindings(settingsOf({ requested_permissions: null }), 'production');
    expect(none.find((f) => f.text.startsWith('Whop lists no permission'))?.level).toBe('error');
  });
});

describe('baseUrlFinding', () => {
  const url = 'https://stayput-app.chezbenz18.workers.dev';

  it('compares the base URL when Whop shows it, a trailing slash aside', () => {
    expect(baseUrlFinding(settingsOf({ base_url: `${url}/` }), url, 'production')).toEqual({
      level: 'ok',
      text: `Base URL: ${url}`,
    });
    expect(
      baseUrlFinding(
        settingsOf({ base_url: 'https://stayput.chezbenz18.workers.dev' }),
        url,
        'production',
      ),
    ).toEqual({
      level: 'error',
      text:
        'Base URL is "https://stayput.chezbenz18.workers.dev" on Whop, StayPut answers at' +
        ` ${url}: type it in Developer → StayPut → Hosting, then Save.`,
    });
  });

  it('leaves it to the relay when Whop hides it from the app key', () => {
    expect(baseUrlFinding(settingsOf(), url, 'production')).toEqual({
      level: 'note',
      text:
        'Base URL: Whop shows it only to the developers of the app, so StayPut is asked through' +
        ' Whop below.',
    });
  });
});

describe('relayAnswer', () => {
  it("tells StayPut's /health, the other deployment's, Whop's page and anything else apart", () => {
    const health = (whopEnv: string) => JSON.stringify({ status: 'ok', whopEnv, database: 'ok' });
    expect(relayAnswer(health('production'), 'production')).toEqual({
      kind: 'stayput',
      colo: null,
      databaseMs: null,
    });
    expect(
      relayAnswer(
        JSON.stringify({ ...JSON.parse(health('production')), colo: 'CDG', databaseMs: 12 }),
        'production',
      ),
    ).toEqual({ kind: 'stayput', colo: 'CDG', databaseMs: 12 });
    expect(relayAnswer(health('sandbox'), 'production')).toEqual({
      kind: 'wrong_env',
      whopEnv: 'sandbox',
    });
    expect(
      relayAnswer('<h1>App Base URL not set</h1><p>If you are the developer…', 'production'),
    ).toEqual({ kind: 'not_set' });
    expect(relayAnswer('{"status":"degraded","whopEnv":"production"}', 'production')).toEqual({
      kind: 'other',
    });
    expect(relayAnswer('<html>Sign in</html>', 'production')).toEqual({ kind: 'other' });
  });
});

describe('checkRelay', () => {
  const url = 'https://stayput-app.chezbenz18.workers.dev';
  const origin = 'https://abc123.apps.whop.com';
  const noSleep = () => Promise.resolve();
  const page =
    (body: string, status = 200, type = 'text/html') =>
    () =>
      Promise.resolve(new Response(body, { status, headers: { 'content-type': type } }));

  it("asks /health through the app's origin, and passes when StayPut answers", async () => {
    const asked: string[] = [];
    let attempt = 0;
    const fetch = (input: string) => {
      asked.push(input);
      attempt += 1;
      // Whop may take a moment to follow its settings: a first answer is not the last.
      return attempt === 1
        ? page('<p>App Base URL not set</p>')()
        : page(JSON.stringify({ status: 'ok', whopEnv: 'production' }), 200, 'application/json')();
    };
    expect(await checkRelay(`${origin}/`, 'production', url, { fetch, sleep: noSleep })).toEqual({
      level: 'ok',
      text: `Whop's relay (${origin}) reaches StayPut: /health ok.`,
    });
    expect(asked).toEqual([`${origin}/health`, `${origin}/health`]);
    // Where StayPut ran when Whop called it, and its database's answer time from there.
    const placed = page(
      JSON.stringify({ status: 'ok', whopEnv: 'production', colo: 'CDG', databaseMs: 9 }),
      200,
      'application/json',
    );
    expect(await checkRelay(origin, 'production', url, { fetch: placed, sleep: noSleep })).toEqual({
      level: 'ok',
      text: `Whop's relay (${origin}) reaches StayPut: /health ok (came in at Cloudflare's CDG data center, database probe 9 ms).`,
    });
  });

  it('stops production when Whop says the base URL is not set, or reaches the sandbox', async () => {
    const notSet = await checkRelay(origin, 'production', url, {
      fetch: page('<h1>App Base URL not set</h1>'),
      sleep: noSleep,
    });
    expect(notSet).toEqual({
      level: 'error',
      text:
        `Whop's relay (${origin}) answers « App Base URL not set »: the base URL is missing.` +
        ` Type ${url} in Developer → StayPut → Hosting, then Save.`,
    });
    const sandbox = await checkRelay(origin, 'production', url, {
      fetch: page(JSON.stringify({ status: 'ok', whopEnv: 'sandbox' }), 200, 'application/json'),
      sleep: noSleep,
    });
    expect(sandbox.level).toBe('error');
    expect(sandbox.text).toContain('reaches the sandbox StayPut');
  });

  it('only warns when the relay answers something else, or cannot be reached', async () => {
    expect(
      await checkRelay(origin, 'production', url, {
        fetch: page('', 302, 'text/html; charset=utf-8'),
        sleep: noSleep,
      }),
    ).toEqual({
      level: 'warning',
      text:
        "Whop's relay answered HTTP 302 (text/html): StayPut could not be confirmed through it." +
        ' Open StayPut in your community to check.',
    });
    const offline = () => Promise.reject(new TypeError('fetch failed'));
    expect(
      (await checkRelay(origin, 'production', url, { fetch: offline, sleep: noSleep })).level,
    ).toBe('warning');
    expect((await checkRelay(null, 'production', url)).level).toBe('warning');
  });

  it('is not asked in the sandbox, whose frames show no app', async () => {
    const never = () => Promise.reject(new Error('the relay must not be asked'));
    expect((await checkRelay(origin, 'sandbox', url, { fetch: never })).level).toBe('note');
  });
});

describe('readApp', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('reads the app with the app key, and again without it when Whop refuses the key', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetch = (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get('authorization');
      calls.push({ url, auth });
      return Promise.resolve(auth ? json({ error: {} }, 403) : json(whopApp()));
    };
    const read = await readApp('app_Prod1', 'production', 'apik_x', { fetch });
    expect(read.found).toBe(true);
    expect(calls).toEqual([
      { url: 'https://api.whop.com/api/v1/apps/app_Prod1', auth: 'Bearer apik_x' },
      { url: 'https://api.whop.com/api/v1/apps/app_Prod1', auth: null },
    ]);
  });

  it('tells a missing app from Whop being unreachable', async () => {
    expect(
      await readApp('app_Nope', 'sandbox', null, {
        fetch: () => Promise.resolve(json({ error: {} }, 404)),
      }),
    ).toEqual({ found: false, reason: 'missing', detail: 'Whop (sandbox) has no app app_Nope' });
    expect(
      await readApp('app_X', 'production', null, {
        fetch: () => Promise.resolve(json({ error: {} }, 503)),
      }),
    ).toEqual({ found: false, reason: 'unreachable', detail: 'Whop answered HTTP 503' });
    expect(
      (
        await readApp('app_X', 'production', null, {
          fetch: () => Promise.reject(new TypeError('fetch failed')),
        })
      ).found,
    ).toBe(false);
  });
});

describe('the cron triggers, read back from Cloudflare', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const schedules = (...crons: string[]) =>
    json({ success: true, result: { schedules: crons.map((cron) => ({ cron })) } });

  it('reads the Worker and its trigger from wrangler.toml, production under its own name', () => {
    expect(tomlCrons(WRANGLER_TOML)).toEqual(['*/5 * * * *']);
    expect(tomlCrons('crons = ["*/10 * * * *", "0  * * * *"]')).toEqual([
      '*/10 * * * *',
      '0 * * * *',
    ]);
    expect(tomlCrons('name = "stayput"')).toEqual([]);
    expect(workerName(undefined, WRANGLER_TOML)).toBe('stayput');
    expect(workerName('sandbox', WRANGLER_TOML)).toBe('stayput');
    expect(workerName('production', WRANGLER_TOML)).toBe(PRODUCTION_WORKER);
    expect(() => workerName('sandbox', 'main = "src/index.ts"')).toThrow();
  });

  it("asks Cloudflare for the Worker's schedules, with the token", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetch = (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') });
      return Promise.resolve(schedules('*/5 * * * *'));
    };
    expect(await readCrons(ID, 'cf_token', 'stayput-app', { fetch })).toEqual({
      crons: ['*/5 * * * *'],
    });
    expect(calls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${ID}/workers/scripts/stayput-app/schedules`,
        auth: 'Bearer cf_token',
      },
    ]);
  });

  it('says why the schedules could not be read', async () => {
    const missing = json(
      { success: false, errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }] },
      404,
    );
    expect(await readCrons(ID, 't', 'nope', { fetch: () => Promise.resolve(missing) })).toEqual({
      error: 'Cloudflare answered HTTP 404: 10007 workers.api.error.script_not_found',
    });
    const offline = await readCrons(ID, 't', 'stayput', {
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(offline).toEqual({ error: 'Cloudflare could not be reached (fetch failed)' });
  });

  it('counts the cron triggers of every Worker on the account', async () => {
    const held: Record<string, string[]> = {
      stayput: ['*/5 * * * *'],
      'stayput-app': ['*/5 * * * *'],
      other: ['0 0 * * *', '0 12 * * *'],
    };
    const fetch = (url: string) => {
      const worker = /\/workers\/scripts\/([^/]+)\/schedules$/.exec(url)?.[1];
      if (worker) return Promise.resolve(schedules(...(held[decodeURIComponent(worker)] ?? [])));
      return Promise.resolve(
        json({ success: true, result: Object.keys(held).map((id) => ({ id })) }),
      );
    };
    expect(await accountCrons(ID, 't', { fetch })).toEqual({ total: 4 });
    expect(
      await accountCrons(ID, 't', { fetch: () => Promise.resolve(json({ success: false }, 403)) }),
    ).toEqual({ error: 'Cloudflare answered HTTP 403' });
  });

  it('stops on a Worker without its triggers, and warns when the account is full', () => {
    const levels = (findings: { level: string }[]) => findings.map((finding) => finding.level);
    expect(
      levels(cronFindings('stayput', ['*/5 * * * *'], { crons: ['*/5 * * * *'] }, { total: 2 })),
    ).toEqual(['ok', 'note']);
    // 7 October 2026: production's three triggers refused, the sandbox's three filling the account.
    const refused = cronFindings(
      'stayput-app',
      ['*/10 * * * *', '0 * * * *', '30 7 * * 1'],
      { crons: [] },
      { total: 3 },
    );
    expect(refused[0]?.level).toBe('error');
    expect(refused[0]?.text).toContain('Cloudflare holds no cron trigger for stayput-app');
    expect(refused[0]?.text).toContain(`allows ${FREE_PLAN_CRONS} cron triggers per account`);
    const full = cronFindings(
      'stayput-app',
      ['*/5 * * * *'],
      { crons: ['*/5 * * * *'] },
      { total: FREE_PLAN_CRONS },
    );
    expect(levels(full)).toEqual(['ok', 'warning']);
    expect(full[1]?.text).toContain('one more would be refused');
    expect(
      levels(
        cronFindings('stayput', ['*/5 * * * *'], { error: 'HTTP 403' }, { error: 'HTTP 403' }),
      ),
    ).toEqual(['error', 'note']);
    expect(levels(cronFindings('stayput', [], { crons: [] }, { total: 0 }))).toEqual([
      'error',
      'note',
    ]);
  });
});
