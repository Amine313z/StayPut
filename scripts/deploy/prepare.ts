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
 * The optional modules (Discord, Telegram): uploaded when set, silently off otherwise. Adding
 * Discord's bot to a server also needs the application's client secret.
 */
export const MODULE_SECRETS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET', 'TELEGRAM_BOT_TOKEN'];

/**
 * WHOP_ENV and WHOP_APP_ID default to wrangler.toml (the sandbox app); variables of the same name
 * replace them. Production needs its own app: WHOP_ENV=production alone would check production
 * tokens against the sandbox app.
 */
export const PRODUCTION_VARS = ['WHOP_APP_ID'];

/**
 * Where a deployment goes (the Deploy workflow's input): the sandbox Worker « stayput », or the
 * production Worker « stayput-app » (docs/production.md).
 */
export const DEPLOY_TARGETS = ['sandbox', 'production'] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/**
 * What production holds under its own name, `PRODUCTION_<name>` (the workflow reads those for
 * production): its database, its Whop app, its own Telegram bot (a bot has one webhook) and the
 * operator's community there. A missing one stops the deployment: it is never replaced by the
 * sandbox's value of the same name, as a GitHub environment would do. Cloudflare and Discord are
 * shared.
 */
export const PRODUCTION_OWN = [
  'SUPABASE_DB_URL',
  'WHOP_API_KEY',
  'WHOP_WEBHOOK_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'WHOP_APP_ID',
  'OPERATOR_COMPANY_ID',
];

/** Production cannot run without Whop: its key, its webhook secret, its operator community. */
export const PRODUCTION_REQUIRED = ['WHOP_API_KEY', 'WHOP_WEBHOOK_SECRET', 'OPERATOR_COMPANY_ID'];

/** The name a setting is stored under for this target, as the messages should say it. */
export function settingName(name: string, target: string | undefined): string {
  return target?.trim() === 'production' && PRODUCTION_OWN.includes(name)
    ? `PRODUCTION_${name}`
    : name;
}

/**
 * Whether the target and Whop's environment agree: production with the sandbox's app, or the
 * sandbox Worker with production's, would serve one community's data from the other's settings.
 */
export function targetProblem(target: string | undefined, whopEnv: string | undefined) {
  const where = target?.trim() || 'sandbox';
  const env = whopEnv?.trim() || 'sandbox';
  if (!(DEPLOY_TARGETS as readonly string[]).includes(where)) {
    return `unknown deployment target "${where}" (sandbox or production)`;
  }
  if (where === 'production' && env !== 'production') {
    return 'the production deployment needs WHOP_ENV=production';
  }
  if (where === 'sandbox' && env === 'production') {
    return 'the sandbox deployment runs with WHOP_ENV=production: deploy to production instead';
  }
  return null;
}

/**
 * The 32-character account id, whether the secret holds the id alone or a dashboard address
 * that contains it (`https://dash.cloudflare.com/<id>/workers/…`, an easy paste mistake).
 */
export function cloudflareAccountId(raw: string | undefined): string | null {
  return raw?.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i)?.[0].toLowerCase() ?? null;
}

/** `NAME=…` (or `NAME = …`, `NAME: …`, `export NAME=…`) with an upper-case variable NAME. */
const ASSIGNMENT = /^(?:export\s+)?([A-Z][A-Z0-9_]{1,40})\s*[=:]\s*(.*)$/;

/**
 * A Worker secret as the Worker needs it. Whop shows the app's variables as a `.env` block
 * (`WHOP_API_KEY=apik_…`, then `NEXT_PUBLIC_WHOP_APP_ID=app_…`), easy to paste whole or in
 * part: the value is this NAME's line of the block, or else the one line that assigns no other
 * variable; surrounding quotes are dropped. Anything else is returned as is (then refused as
 * not one single value). Variable names are upper case, so a key is never read as a name.
 */
export function secretValue(name: string, raw: string | undefined): string {
  const lines = (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const assignments = lines.map((line) => ASSIGNMENT.exec(line));
  const own = assignments.find((found) => found?.[1] === name);
  const others = lines.filter((_, index) => assignments[index] === null);
  const value = own
    ? (own[2] ?? '').trim()
    : others.length === 1
      ? (others[0] ?? '')
      : lines.join('\n');
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted ? (quoted[2] ?? '').trim() : value;
}

/** Known beginnings of Whop values, safe to print: they are formats, not secrets. */
const KNOWN_PREFIXES = ['apik_', 'ws_', 'whsec_', 'app_', 'biz_', 'hook_', 'https://'];

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
    const name = ASSIGNMENT.exec(line)?.[1];
    const prefix = KNOWN_PREFIXES.find((known) => line.startsWith(known));
    const kind = name ? `${name}=…` : prefix ? `${prefix}…` : 'other text';
    return `${kind} (${line.length} characters)`;
  });
  return `${lines.length} line${lines.length === 1 ? '' : 's'}: ${kinds.join('; ')}`;
}

/** Whop ids the Worker reads as they are: a pasted address or `NAME=` line would be ignored. */
const ID_FORMATS: Record<string, RegExp> = {
  WHOP_APP_ID: /^app_[A-Za-z0-9]+$/,
  OPERATOR_COMPANY_ID: /^biz_[A-Za-z0-9]+$/,
};

export function prepare(env: Record<string, string | undefined>): {
  /** Where this deployment goes, and why it must not, if it must not. */
  target: string;
  targetProblem: string | null;
  accountId: string | null;
  /** Settings named as stored: `PRODUCTION_…` for production's own (PRODUCTION_OWN). */
  missingRequired: string[];
  missingOptional: string[];
  /** Modules on (every secret of the module set) or off, for the logs. */
  modules: { discord: boolean; telegram: boolean };
  /** Secrets whose pasted value needed cleaning (secretValue): names only, as stored. */
  cleaned: string[];
  /**
   * Secrets that are not one single value once cleaned (spaces, several lines): never used.
   * Named as stored.
   */
  malformed: { name: string; shape: string }[];
  /** Under the names the Worker reads. */
  secrets: Record<string, string>;
} {
  const target = env.STAYPUT_TARGET?.trim() || 'sandbox';
  const production = target === 'production';
  const accountId = cloudflareAccountId(env.CLOUDFLARE_ACCOUNT_ID);
  const secrets: Record<string, string> = {};
  const cleaned: string[] = [];
  const malformed: { name: string; shape: string }[] = [];
  for (const name of [...WORKER_SECRETS, ...MODULE_SECRETS]) {
    const value = secretValue(name, env[name]);
    if (!value) continue;
    if (!/^\S+$/.test(value)) {
      malformed.push({ name, shape: describeValue(env[name] ?? '') });
      continue;
    }
    secrets[name] = value;
    if (value !== env[name]?.trim()) cleaned.push(name);
  }
  const isMalformed = (name: string) => malformed.some((bad) => bad.name === name);
  const present = (name: string) => {
    if (name === 'CLOUDFLARE_ACCOUNT_ID') return accountId !== null;
    if (WORKER_SECRETS.includes(name)) return name in secrets;
    const value = env[name]?.trim() ?? '';
    return ID_FORMATS[name]?.test(value) ?? value !== '';
  };
  const required = [
    ...REQUIRED,
    ...(production || env.WHOP_ENV?.trim() === 'production' ? PRODUCTION_VARS : []),
    ...(production ? PRODUCTION_REQUIRED : []),
  ];
  const stored = (name: string) => settingName(name, target);
  return {
    target,
    targetProblem: targetProblem(env.STAYPUT_TARGET, env.WHOP_ENV),
    accountId,
    missingRequired: required.filter((name) => !present(name) && !isMalformed(name)).map(stored),
    missingOptional: WORKER_SECRETS.filter(
      (name) => !required.includes(name) && !present(name) && !isMalformed(name),
    ).map(stored),
    modules: {
      discord: 'DISCORD_BOT_TOKEN' in secrets && 'DISCORD_CLIENT_SECRET' in secrets,
      telegram: 'TELEGRAM_BOT_TOKEN' in secrets,
    },
    cleaned: cleaned.map(stored),
    malformed: malformed.map(({ name, shape }) => ({ name: stored(name), shape })),
    secrets,
  };
}

function main() {
  const [secretsFile] = process.argv.slice(2);
  if (!secretsFile) throw new Error('usage: prepare.ts <secrets file>');
  const {
    target,
    targetProblem: problem,
    accountId,
    missingRequired,
    missingOptional,
    modules,
    cleaned,
    malformed,
    secrets,
  } = prepare(process.env);
  if (problem) throw new Error(problem);
  console.info(`Deploying to ${target}.`);
  for (const name of missingOptional) {
    console.warn(`::warning::${name} is not set yet: the matching features stay off.`);
  }
  console.info(
    `Discord module: ${modules.discord ? 'on' : 'off'}; Telegram module: ${
      modules.telegram ? 'on' : 'off'
    }.`,
  );
  for (const name of cleaned) {
    console.info(
      `::notice::${name}: kept only the value (dropped other pasted lines, a "NAME=" or quotes).`,
    );
  }
  for (const { name, shape } of malformed) {
    console.error(`::error::${name} is not one single value: ${shape}.`);
  }
  if (malformed.length > 0) {
    throw new Error(
      `store ${malformed.map(({ name }) => name).join(' and ')} again: only the value itself, on` +
        ' one line (apik_… for WHOP_API_KEY, ws_… for WHOP_WEBHOOK_SECRET, the bot token itself' +
        ' for DISCORD_BOT_TOKEN and TELEGRAM_BOT_TOKEN).',
    );
  }
  if (missingRequired.length > 0) {
    throw new Error(
      `missing or unreadable settings: ${missingRequired.join(', ')}` +
        ' (CLOUDFLARE_ACCOUNT_ID must contain the 32-character account id, WHOP_APP_ID an app_…' +
        ' id, OPERATOR_COMPANY_ID a biz_… id; production: docs/production.md)',
    );
  }
  // The next steps (Hyperdrive, wrangler) read the cleaned id from their environment.
  if (process.env.GITHUB_ENV && accountId) {
    appendFileSync(process.env.GITHUB_ENV, `CLOUDFLARE_ACCOUNT_ID=${accountId}\n`);
  }
  writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
  console.info(`Worker secrets to upload: ${Object.keys(secrets).join(', ') || 'none'}.`);
  for (const [name, value] of Object.entries(secrets)) {
    console.info(`  ${name}: ${describeValue(value)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
