/**
 * Deployment step (.github/workflows/deploy.yml): checks what is configured, hands the
 * Cloudflare account id to the next steps (through $GITHUB_ENV), and writes the Worker's secrets
 * to a file for `wrangler deploy --secrets-file`. Only names are printed.
 *
 *   tsx scripts/deploy/prepare.ts <secrets file>
 */
import { appendFileSync, writeFileSync } from 'node:fs';

/** Without these the deployment cannot run at all. */
export const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_DB_URL'];

/** Without these the Worker runs, but Whop features answer "not configured". */
export const WORKER_SECRETS = ['WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET'];

/**
 * WHOP_ENV and WHOP_APP_ID default to wrangler.toml (the sandbox app); repository variables of
 * the same name replace them. Production needs its own app: WHOP_ENV=production alone would
 * check production tokens against the sandbox app.
 */
export const PRODUCTION_VARS = ['WHOP_APP_ID'];

/**
 * The 32-character account id, whether the secret holds the id alone or a dashboard address
 * that contains it (`https://dash.cloudflare.com/<id>/workers/…`, an easy paste mistake).
 */
export function cloudflareAccountId(raw: string | undefined): string | null {
  return raw?.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i)?.[0].toLowerCase() ?? null;
}

export function prepare(env: Record<string, string | undefined>): {
  accountId: string | null;
  missingRequired: string[];
  missingOptional: string[];
  secrets: Record<string, string>;
} {
  const accountId = cloudflareAccountId(env.CLOUDFLARE_ACCOUNT_ID);
  const present = (name: string) =>
    name === 'CLOUDFLARE_ACCOUNT_ID' ? accountId !== null : Boolean(env[name]?.trim());
  const required =
    env.WHOP_ENV?.trim() === 'production' ? [...REQUIRED, ...PRODUCTION_VARS] : REQUIRED;
  const secrets: Record<string, string> = {};
  for (const name of WORKER_SECRETS) {
    const value = env[name]?.trim();
    if (value) secrets[name] = value;
  }
  return {
    accountId,
    missingRequired: required.filter((name) => !present(name)),
    missingOptional: WORKER_SECRETS.filter((name) => !present(name)),
    secrets,
  };
}

function main() {
  const [secretsFile] = process.argv.slice(2);
  if (!secretsFile) throw new Error('usage: prepare.ts <secrets file>');
  const { accountId, missingRequired, missingOptional, secrets } = prepare(process.env);
  for (const name of missingOptional) {
    console.warn(`::warning::${name} is not set yet: the matching features stay off.`);
  }
  if (missingRequired.length > 0) {
    throw new Error(
      `missing or unreadable repository settings: ${missingRequired.join(', ')}` +
        ' (CLOUDFLARE_ACCOUNT_ID must contain the 32-character account id; production needs' +
        ' the WHOP_APP_ID variable)',
    );
  }
  // The next steps (Hyperdrive, wrangler) read the cleaned id from their environment.
  if (process.env.GITHUB_ENV && accountId) {
    appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_ACCOUNT_ID=${accountId}\n`);
  }
  writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  console.info(`Worker secrets to upload: ${Object.keys(secrets).join(', ') || 'none'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
