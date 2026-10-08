/**
 * Deployment step (.github/workflows/deploy.yml): makes sure the Hyperdrive configuration
 * "stayput-db" ("stayput-db-production" for production, STAYPUT_TARGET) exists and points at
 * Supabase's direct connection with the current password (caching disabled, see DECISIONS.md),
 * then writes its binding into wrangler.toml for this deployment only; the committed file has
 * none.
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

/** Each deployment its own database, so its own Hyperdrive configuration (STAYPUT_TARGET). */
export function hyperdriveName(target: string | undefined): string {
  return target?.trim() === 'production' ? `${HYPERDRIVE_NAME}-production` : HYPERDRIVE_NAME;
}

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

/**
 * The AWS region of a Supabase database, read from its pooler's address
 * (`aws-0-eu-west-2.pooler.supabase.com`): where the Worker had better run (withPlacement).
 * Null for any other address.
 */
export function supabaseRegion(databaseUrl: string): string | null {
  try {
    return (
      /^aws-\d+-([a-z]{2}-[a-z]+-\d)\.pooler\.supabase\.com$/.exec(
        new URL(databaseUrl).hostname,
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
}

/**
 * wrangler.toml with the Worker pinned to the database's AWS region (targeted placement) instead
 * of Smart Placement: a screen of the dashboard reads the database several times while the
 * browser waits once, and Smart Placement moves a Worker only after it has seen steady traffic,
 * which a community in testing never sends (/health measured 486 ms for one transaction from
 * Seattle, 2026-10-08).
 */
export function withPlacement(toml: string, region: string): string {
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new Error(`unexpected AWS region "${region}"`);
  const table = /^\[placement\]\n(?:[a-z_]+ *=[^\n]*\n)*/m;
  if (!table.test(toml)) throw new Error('wrangler.toml has no [placement] table');
  return toml.replace(table, `[placement]\nmode = "targeted"\nregion = "aws:${region}"\n`);
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

async function findConfig(
  account: string,
  token: string,
  name: string,
): Promise<HyperdriveConfig | null> {
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
  return body.result.find((config) => config.name === name) ?? null;
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
  const name = hyperdriveName(process.env.STAYPUT_TARGET);

  let config = await findConfig(account, token, name);
  if (!config) {
    wranglerHyperdrive(
      ['create', name, `--connection-string=${origin}`, '--caching-disabled'],
      cwd,
    );
    config = await findConfig(account, token, name);
    if (!config) throw new Error('the Hyperdrive configuration was not created');
    console.info(`Created Hyperdrive configuration ${name}.`);
  } else {
    // Every deployment hands Hyperdrive the connection again: Cloudflare never shows the stored
    // password, so a new one (a rotation, docs/operations.md) can only be noticed by sending it.
    // Cloudflare connects to the origin before accepting it: a wrong one fails here.
    const moved = !sameOrigin(config.origin, origin);
    wranglerHyperdrive(
      ['update', config.id, `--connection-string=${origin}`, '--caching-disabled'],
      cwd,
    );
    console.info(
      moved
        ? `Hyperdrive ${name} now goes to ${new URL(origin).hostname}.`
        : `Hyperdrive ${name}: connection checked and refreshed.`,
    );
  }
  let toml = withHyperdriveBinding(readFileSync(tomlPath, 'utf8'), config.id);
  console.info(`Hyperdrive ${name}: ${config.id}`);
  const region = supabaseRegion(databaseUrl);
  if (region) {
    toml = withPlacement(toml, region);
    console.info(`The database is in AWS ${region} (its pooler's address): the Worker runs there.`);
  } else {
    console.info("The database's address names no region: Smart Placement places the Worker.");
  }
  writeFileSync(tomlPath, toml);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
