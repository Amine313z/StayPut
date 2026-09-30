import { describe, expect, it } from 'vitest';
import { withHyperdriveBinding } from '../../../scripts/deploy/hyperdrive';
import { cloudflareAccountId, prepare, secretValue } from '../../../scripts/deploy/prepare';

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
});

describe('prepare', () => {
  it('requires Cloudflare and the database, and only warns about Whop', () => {
    expect(prepare({})).toEqual({
      accountId: null,
      missingRequired: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_DB_URL'],
      missingOptional: ['WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET'],
      cleaned: [],
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
