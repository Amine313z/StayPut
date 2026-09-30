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

/**
 * A Worker secret as the Worker needs it. Whop shows the app's key as a `.env` line
 * (`WHOP_API_KEY=apik_…`): a pasted `NAME=` prefix (alone or among other lines, `NAME = …`,
 * `NAME: …` or `export NAME=…` too) and surrounding quotes are dropped.
 */
export function secretValue(name: string, raw: string | undefined): string {
  const text = raw?.trim() ?? '';
  const named = new RegExp(`^(?:export\\s+)?${name}\\s*[=:]\\s*(.*)$`);
  const match = text
    .split(/\r?\n/)
    .map((line) => named.exec(line.trim()))
    .find((found) => found !== null);
  const value = match ? (match[1] ?? '').trim() : text;
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted ? (quoted[2] ?? '').trim() : value;
}

/** Known beginnings of Whop values, safe to print: they are formats, not secrets. */
const KNOWN_PREFIXES = ['apik_', 'ws_', 'whsec_', 'app_', 'biz_'];

/**
 * What a stored value looks like, for the logs, without any of its secret characters: its lines,
 * each described by a known prefix, or by the NAME of a `NAME=` line (upper case only, so a key
 * followed by `=` is never taken for a name), and its length.
 */
export function describeValue(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const kinds = lines.map((line) => {
    const name = /^(?:export\s+)?([A-Z][A-Z0-9_]{1,40})\s*[=:]/.exec(line)?.[1];
    const prefix = KNOWN_PREFIXES.find((known) => line.startsWith(known));
    const kind = name ? `${name}=…` : prefix ? `${prefix}…` : 'other text';
    return `${kind} (${line.length} characters)`;
  });
  return `${lines.length} line${lines.length === 1 ? '' : 's'}: ${kinds.join('; ')}`;
}

export function prepare(env: Record<string, string | undefined>): {
  accountId: string | null;
  missingRequired: string[];
  missingOptional: string[];
  /** Secrets whose pasted value needed cleaning (secretValue): names only. */
  cleaned: string[];
  /** Secrets that are not one single value once cleaned (spaces, several lines): never used. */
  malformed: { name: string; shape: string }[];
  secrets: Record<string, string>;
} {
  const accountId = cloudflareAccountId(env.CLOUDFLARE_ACCOUNT_ID);
  const secrets: Record<string, string> = {};
  const cleaned: string[] = [];
  const malformed: { name: string; shape: string }[] = [];
  for (const name of WORKER_SECRETS) {
    const value = secretValue(name, env[name]);
    if (!value) continue;
    if (!/^\S+$/.test(value)) {
      malformed.push({ name, shape: describeValue(env[name] ?? '') });
      continue;
    }
    secrets[name] = value;
    if (value !== env[name]?.trim()) cleaned.push(name);
  }
  const present = (name: string) =>
    name === 'CLOUDFLARE_ACCOUNT_ID'
      ? accountId !== null
      : WORKER_SECRETS.includes(name)
        ? name in secrets
        : Boolean(env[name]?.trim());
  const required =
    env.WHOP_ENV?.trim() === 'production' ? [...REQUIRED, ...PRODUCTION_VARS] : REQUIRED;
  return {
    accountId,
    missingRequired: required.filter((name) => !present(name)),
    missingOptional: WORKER_SECRETS.filter(
      (name) => !present(name) && !malformed.some((bad) => bad.name === name),
    ),
    cleaned,
    malformed,
    secrets,
  };
}

function main() {
  const [secretsFile] = process.argv.slice(2);
  if (!secretsFile) throw new Error('usage: prepare.ts <secrets file>');
  const { accountId, missingRequired, missingOptional, cleaned, malformed, secrets } = prepare(
    process.env,
  );
  for (const name of missingOptional) {
    console.warn(`::warning::${name} is not set yet: the matching features stay off.`);
  }
  for (const name of cleaned) {
    console.info(`::notice::${name}: kept only the value (dropped a pasted "${name}=" or quotes).`);
  }
  for (const { name, shape } of malformed) {
    console.error(`::error::${name} is not one single value: ${shape}.`);
  }
  if (malformed.length > 0) {
    throw new Error(
      `store ${malformed.map(({ name }) => name).join(' and ')} again: only the value itself, on` +
        ' one line (apik_… for WHOP_API_KEY, ws_… for WHOP_WEBHOOK_SECRET).',
    );
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
