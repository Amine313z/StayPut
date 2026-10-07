/**
 * Deployment step (.github/workflows/deploy.yml): the Worker's cron triggers as Cloudflare holds
 * them once it is published, compared with wrangler.toml's. On 2026-10-07 Cloudflare refused
 * production's (its free plan allows 5 per account, all Workers together, and the sandbox's
 * Worker held 3) and the deployment passed all the same: no job would have run on schedule
 * (DECISIONS.md). Also counts the cron triggers of all the account's Workers, as a number only:
 * this repository's logs are public, so no other Worker is named. Never prints the token.
 *
 *   tsx scripts/deploy/check-crons.ts apps/worker/wrangler.toml
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the 32-character id prepare.ts keeps);
 * the Worker is « stayput-app » for production (STAYPUT_TARGET), wrangler.toml's name otherwise.
 */
import { appendFileSync, readFileSync } from 'node:fs';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface Finding {
  /** ok: right; error: stops the deployment; warning: to look at; note: nothing to do. */
  level: 'ok' | 'error' | 'warning' | 'note';
  text: string;
}

/** Cloudflare's free plan: cron triggers per account, all its Workers together. */
export const FREE_PLAN_CRONS = 5;

/** Production's Worker: deploy.yml publishes it under this name, beside the sandbox's. */
export const PRODUCTION_WORKER = 'stayput-app';

const API = 'https://api.cloudflare.com/client/v4';

/** The `crons` of wrangler.toml's `[triggers]`. */
export function tomlCrons(toml: string): string[] {
  const list = /^crons\s*=\s*\[(.*)\]\s*$/m.exec(toml)?.[1] ?? '';
  return list
    .split(',')
    .map((cron) => normalCron(cron.replace(/"/g, '')))
    .filter(Boolean);
}

/** The Worker a deployment publishes: production's own, wrangler.toml's `name` otherwise. */
export function workerName(target: string | undefined, toml: string): string {
  if (target?.trim() === 'production') return PRODUCTION_WORKER;
  const name = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (!name) throw new Error('wrangler.toml names no Worker');
  return name;
}

function normalCron(cron: string): string {
  return cron.trim().replace(/\s+/g, ' ');
}

/** A GET on Cloudflare's API: its `result`, or why there is none. */
async function askCloudflare(
  path: string,
  token: string,
  inject: { fetch?: Fetch },
): Promise<{ result: unknown } | { error: string }> {
  const send: Fetch = inject.fetch ?? ((url, init) => fetch(url, init));
  try {
    const response = await send(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      result?: unknown;
      errors?: { code?: number; message?: string }[];
    } | null;
    if (!response.ok || !body?.success) {
      const first = body?.errors?.[0];
      const why = first ? `: ${first.code ?? ''} ${first.message ?? ''}`.trimEnd() : '';
      return { error: `Cloudflare answered HTTP ${response.status}${why}` };
    }
    return { result: body.result };
  } catch (error) {
    const why = error instanceof Error ? error.message : 'no answer';
    return { error: `Cloudflare could not be reached (${why})` };
  }
}

/** One Worker's cron triggers as Cloudflare holds them. */
export async function readCrons(
  account: string,
  token: string,
  worker: string,
  inject: { fetch?: Fetch } = {},
): Promise<{ crons: string[] } | { error: string }> {
  const answer = await askCloudflare(
    `/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/schedules`,
    token,
    inject,
  );
  if ('error' in answer) return answer;
  const schedules = (answer.result as { schedules?: { cron?: unknown }[] } | null)?.schedules;
  if (!Array.isArray(schedules)) return { error: 'Cloudflare listed no schedules' };
  return {
    crons: schedules
      .map((schedule) => (typeof schedule.cron === 'string' ? normalCron(schedule.cron) : ''))
      .filter(Boolean),
  };
}

/** How many cron triggers the account's Workers hold, all together. */
export async function accountCrons(
  account: string,
  token: string,
  inject: { fetch?: Fetch } = {},
): Promise<{ total: number } | { error: string }> {
  const answer = await askCloudflare(`/accounts/${account}/workers/scripts`, token, inject);
  if ('error' in answer) return answer;
  if (!Array.isArray(answer.result)) return { error: 'Cloudflare listed no Workers' };
  let total = 0;
  for (const script of answer.result as { id?: unknown }[]) {
    if (typeof script.id !== 'string') continue;
    const read = await readCrons(account, token, script.id, inject);
    if ('error' in read) return read;
    total += read.crons.length;
  }
  return { total };
}

/** What the deployment says of the Worker's triggers, and of the account's. */
export function cronFindings(
  worker: string,
  expected: readonly string[],
  held: { crons: string[] } | { error: string },
  account: { total: number } | { error: string },
): Finding[] {
  const findings: Finding[] = [];
  const limit =
    `Cloudflare's free plan allows ${FREE_PLAN_CRONS} cron triggers per account, all Workers` +
    ' together (dashboard: Workers & Pages → a Worker → Settings).';
  if (expected.length === 0) {
    findings.push({ level: 'error', text: 'wrangler.toml declares no cron trigger.' });
  } else if ('error' in held) {
    findings.push({
      level: 'error',
      text: `Could not read the cron triggers of ${worker}: ${held.error}.`,
    });
  } else if (
    [...held.crons].sort().join('\n') === [...expected].map(normalCron).sort().join('\n')
  ) {
    findings.push({
      level: 'ok',
      text: `Cloudflare runs ${worker} on ${held.crons.join(', ')}, as wrangler.toml says.`,
    });
  } else {
    findings.push({
      level: 'error',
      text:
        `Cloudflare holds ${held.crons.length > 0 ? held.crons.join(', ') : 'no cron trigger'}` +
        ` for ${worker}, wrangler.toml asks ${expected.join(', ')}: no scheduled job runs until` +
        ` they match. ${limit}`,
    });
  }
  if ('error' in account) {
    findings.push({
      level: 'note',
      text: `The account's cron triggers were not counted: ${account.error}.`,
    });
  } else {
    const full = account.total >= FREE_PLAN_CRONS;
    const triggers = account.total === 1 ? 'trigger' : 'triggers';
    findings.push({
      level: full ? 'warning' : 'note',
      text:
        `The account's Workers hold ${account.total} cron ${triggers} in all, of the free` +
        ` plan's ${FREE_PLAN_CRONS}${full ? ': one more would be refused.' : '.'}`,
    });
  }
  return findings;
}

const MARKS: Readonly<Record<Finding['level'], string>> = {
  ok: '✅',
  error: '❌',
  warning: '⚠️',
  note: 'ℹ️',
};

async function main() {
  const [tomlPath] = process.argv.slice(2);
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!tomlPath || !token || !account) {
    throw new Error(
      'usage: CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… check-crons.ts <wrangler.toml>',
    );
  }
  if (!/^[0-9a-f]{32}$/.test(account)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is not the 32-character account id');
  }
  const toml = readFileSync(tomlPath, 'utf8');
  const worker = workerName(process.env.STAYPUT_TARGET, toml);
  const findings = cronFindings(
    worker,
    tomlCrons(toml),
    await readCrons(account, token, worker),
    await accountCrons(account, token),
  );
  const summary = [`### The Worker's cron triggers on Cloudflare (${worker})`, ''];
  for (const { level, text: line } of findings) {
    console.info(
      level === 'error' ? `::error::${line}` : level === 'warning' ? `::warning::${line}` : line,
    );
    summary.push(`- ${MARKS[level]} ${line}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
  if (findings.some((finding) => finding.level === 'error')) {
    throw new Error(
      `The cron triggers of ${worker} are not the ones StayPut needs (listed above).`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
