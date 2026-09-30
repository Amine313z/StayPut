import { describe, expect, it } from 'vitest';
import { withHyperdriveBinding } from '../../../scripts/deploy/hyperdrive';
import { prepare } from '../../../scripts/deploy/prepare';

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

describe('prepare', () => {
  it('requires Cloudflare and the database, and only warns about Whop', () => {
    expect(prepare({})).toEqual({
      missingRequired: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_DB_URL'],
      missingOptional: ['WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET', 'WHOP_APP_ID'],
      secrets: {},
    });
  });

  it('keeps only the Worker secrets that are set', () => {
    const result = prepare({
      CLOUDFLARE_API_TOKEN: 't',
      CLOUDFLARE_ACCOUNT_ID: 'a',
      SUPABASE_DB_URL: 'postgres://x',
      WHOP_API_KEY: ' key ',
      WHOP_WEBHOOK_SECRET: '',
      WHOP_APP_ID: 'app_1',
    });
    expect(result.missingRequired).toEqual([]);
    expect(result.missingOptional).toEqual(['WHOP_WEBHOOK_SECRET']);
    expect(result.secrets).toEqual({ WHOP_API_KEY: 'key' });
  });
});
