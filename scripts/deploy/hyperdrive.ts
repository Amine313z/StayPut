/**
 * Deployment step (.github/workflows/deploy.yml): makes sure the Hyperdrive configuration
 * "stayput-db" exists (created with caching disabled, see DECISIONS.md), then writes its
 * binding into wrangler.toml for this deployment only; the committed file has none.
 *
 *   tsx scripts/deploy/hyperdrive.ts apps/worker/wrangler.toml
 *
 * Needs CLOUDFLARE_API_TOKEN (with Hyperdrive: Edit), CLOUDFLARE_ACCOUNT_ID and, the first
 * time, SUPABASE_DB_URL. Prints the configuration id, never the connection string.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const HYPERDRIVE_NAME = 'stayput-db';

/** wrangler.toml with the HYPERDRIVE binding added, unless an active one is already there. */
export function withHyperdriveBinding(toml: string, id: string): string {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`unexpected Hyperdrive id "${id}"`);
  if (/^\[\[hyperdrive\]\]/m.test(toml)) return toml;
  return `${toml.trimEnd()}\n\n[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${id}"\n`;
}

async function findConfig(account: string, token: string): Promise<string | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as {
    success?: boolean;
    errors?: unknown;
    result?: { id: string; name: string }[];
  };
  if (!response.ok || !body.success || !body.result) {
    throw new Error(
      `listing Hyperdrive configurations failed (${response.status}): ${JSON.stringify(body.errors)}`,
    );
  }
  return body.result.find((config) => config.name === HYPERDRIVE_NAME)?.id ?? null;
}

async function main() {
  const [tomlPath] = process.argv.slice(2);
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
  const databaseUrl = process.env.SUPABASE_DB_URL;
  if (!tomlPath || !token || !account) {
    throw new Error(
      'usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… hyperdrive.ts <wrangler.toml>',
    );
  }
  let id = await findConfig(account, token);
  if (!id) {
    if (!databaseUrl)
      throw new Error('SUPABASE_DB_URL is needed to create the Hyperdrive configuration');
    // Wrangler's output would repeat the origin: kept out of the logs.
    execFileSync(
      'npx',
      [
        'wrangler',
        'hyperdrive',
        'create',
        HYPERDRIVE_NAME,
        `--connection-string=${databaseUrl}`,
        '--caching-disabled',
      ],
      { cwd: path.dirname(tomlPath), stdio: ['ignore', 'ignore', 'inherit'] },
    );
    id = await findConfig(account, token);
    if (!id) throw new Error('the Hyperdrive configuration was not created');
    console.info(`Created Hyperdrive configuration ${HYPERDRIVE_NAME}.`);
  }
  writeFileSync(tomlPath, withHyperdriveBinding(readFileSync(tomlPath, 'utf8'), id));
  console.info(`Hyperdrive ${HYPERDRIVE_NAME}: ${id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
