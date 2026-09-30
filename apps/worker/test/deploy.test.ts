import { describe, expect, it } from 'vitest';
import { checkWhopKey, deployedVar } from '../../../scripts/deploy/check-whop';
import { withHyperdriveBinding } from '../../../scripts/deploy/hyperdrive';
import {
  cloudflareAccountId,
  describeValue,
  prepare,
  secretValue,
} from '../../../scripts/deploy/prepare';

const ID = '0123456789abcdef0123456789abcdef';

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

  it('never takes a key followed by "=" for a variable name', () => {
    const shape = describeValue('apik_SeCrEt123=\nABC');
    expect(shape).toBe('2 lines: apik_… (15 characters); other text (3 characters)');
    expect(shape).not.toContain('SeCrEt');
  });
});

describe('prepare', () => {
  it('requires Cloudflare and the database, and only warns about Whop', () => {
    expect(prepare({})).toEqual({
      accountId: null,
      missingRequired: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_DB_URL'],
      missingOptional: ['WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET'],
      cleaned: [],
      malformed: [],
      secrets: {},
    });
  });

  it('refuses production without its own app id (the sandbox one is in wrangler.toml)', () => {
    const base = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: ID, SUPABASE_DB_URL: 'x' };
    expect(prepare({ ...base, WHOP_ENV: 'production' }).missingRequired).toEqual(['WHOP_APP_ID']);
    expect(
      prepare({ ...base, WHOP_ENV: 'production', WHOP_APP_ID: 'app_prod' }).missingRequired,
    ).toEqual([]);
    expect(prepare({ ...base, WHOP_ENV: 'sandbox' }).missingRequired).toEqual([]);
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
