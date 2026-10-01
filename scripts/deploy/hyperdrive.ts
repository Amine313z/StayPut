/**
 * Deployment step (.github/workflows/deploy.yml): makes sure the Hyperdrive configuration
 * "stayput-db" exists and points at Supabase's direct connection (caching disabled, see
 * DECISIONS.md), then writes its binding into wrangler.toml for this deployment only; the
 * committed file has none.
 *
 *   tsx scripts/deploy/hyperdrive.ts apps/worker/wrangler.toml
 *
 * Needs CLOUDFLARE_API_TOKEN (with Hyperdrive: Edit), CLOUDFLARE_ACCOUNT_ID and SUPABASE_DB_URL.
 * Prints the configuration id and the origin's host, never a password.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const HYPERDRIVE_NAME = 'stayput-db';

/**
 * The connection Hyperdrive should use. Hyperdrive pools connections itself: behind Supabase's
 * pooler in session mode, its ~20 connections (kept 10 minutes) queue on a pool of about 15 and
 * the database stops answering for minutes (seen after deployments, DECISIONS.md). So Hyperdrive
 * goes to the direct connection, as Cloudflare's Supabase guide says. The secret holds the
 * session pooler URI (IPv4, needed by GitHub's runners for the migrations), which gives the
 * direct one: user `postgres.<ref>` → `postgres`, host → `db.<ref>.supabase.co`, port 5432, same
 * password. Any other URI is kept as is.
 */
export function hyperdriveOrigin(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const ref = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(url.username))?.[1];
  if (!ref || !url.hostname.endsWith('.pooler.supabase.com')) return databaseUrl;
  url.username = 'postgres';
  url.hostname = `db.${ref}.supabase.co`;
  url.port = '5432';
  return url.toString();
}

/** wrangler.toml with the HYPERDRIVE binding added, unless an active one is already there. */
export function withHyperdriveBinding(toml: string, id: string): string {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`unexpected Hyperdrive id "${id}"`);
  if (/^\[\[hyperdrive\]\]/m.test(toml)) return toml;
  return `${toml.trimEnd()}\n\n[[hyperdrive]]\nbinding = "HYPERDRIVE"\nid = "${id}"\n`;
}

interface HyperdriveConfig {
  id: string;
  name: string;
  origin?: { host?: string; port?: number; user?: string; database?: string };
}

async function findConfig(account: string, token: string): Promise<HyperdriveConfig | null> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive/configs`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as {
    success?: boolean;
    errors?: unknown;
    result?: HyperdriveConfig[];
  };
  if (!response.ok || !body.success || !body.result) {
    throw new Error(
      `listing Hyperdrive configurations failed (${response.status}): ${JSON.stringify(body.errors)}`,
    );
  }
  return body.result.find((config) => config.name === HYPERDRIVE_NAME) ?? null;
}

/** Whether the configuration already points at `origin` (host, port, user, database). */
export function sameOrigin(config: HyperdriveConfig['origin'], origin: string): boolean {
  const url = new URL(origin);
  return (
    config?.host === url.hostname &&
    String(config.port) === (url.port || '5432') &&
    config.user === decodeURIComponent(url.username) &&
    config.database === decodeURIComponent(url.pathname.slice(1))
  );
}

/** Runs wrangler with the connection string kept out of the logs (its output repeats it). */
function wranglerHyperdrive(args: string[], cwd: string) {
  execFileSync('npx', ['wrangler', 'hyperdrive', ...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
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
  if (!databaseUrl) throw new Error('SUPABASE_DB_URL is needed for Hyperdrive');
  const origin = hyperdriveOrigin(databaseUrl);
  const password = decodeURIComponent(new URL(origin).password);
  // GitHub masks the whole secret, not a password found inside it: mask both forms.
  if (process.env.GITHUB_ACTIONS && password) console.info(`::add-mask::${password}`);
  if (process.env.GITHUB_ACTIONS) console.info(`::add-mask::${origin}`);
  const cwd = path.dirname(tomlPath);

  let config = await findConfig(account, token);
  if (!config) {
    wranglerHyperdrive(
      ['create', HYPERDRIVE_NAME, `--connection-string=${origin}`, '--caching-disabled'],
      cwd,
    );
    config = await findConfig(account, token);
    if (!config) throw new Error('the Hyperdrive configuration was not created');
    console.info(`Created Hyperdrive configuration ${HYPERDRIVE_NAME}.`);
  } else if (!sameOrigin(config.origin, origin)) {
    // Cloudflare connects to the new origin before accepting it: a wrong one fails here.
    wranglerHyperdrive(
      ['update', config.id, `--connection-string=${origin}`, '--caching-disabled'],
      cwd,
    );
    console.info(`Hyperdrive ${HYPERDRIVE_NAME} now goes to ${new URL(origin).hostname}.`);
  }
  writeFileSync(tomlPath, withHyperdriveBinding(readFileSync(tomlPath, 'utf8'), config.id));
  console.info(`Hyperdrive ${HYPERDRIVE_NAME}: ${config.id}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
