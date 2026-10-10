/**
 * Inspect (.github/workflows/inspect.yml): what the deployed Worker logged over the last hours,
 * read from Cloudflare's Workers Observability (wrangler.toml, [observability]). Says, for the
 * requests: how many per route, their answers, how long they took, and the ones that took long,
 * failed or never finished (the browser gave up: Cloudflare's outcome « canceled »); for the log
 * lines: each warning and error, counted. This repository's logs are public: every id (a
 * community's, a member's, a Discord server's…), e-mail address, long number and query string is
 * masked before anything is printed, and no request body or header is ever read.
 *
 *   tsx scripts/ops/worker-logs.ts apps/worker/wrangler.toml [hours]
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; STAYPUT_TARGET picks the Worker
 * (production's « stayput-app », wrangler.toml's name otherwise). Never prints the token.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { workerName } from '../deploy/check-crons';
import { cloudflareAccountId } from '../deploy/prepare';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const API = 'https://api.cloudflare.com/client/v4';
/** A request that took longer than this is listed one by one. */
export const SLOW_MS = 5_000;

/** Ids, e-mail addresses, long numbers and tokens of `text` masked: nothing private stays. */
export function mask(text: string): string {
  return (
    text
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      // Whop's ids (biz_, user_, mber_, mem_, exp_, prod_, plan_, pay_, chat_…): the kind stays.
      .replace(/\b([a-z]{2,8})_[A-Za-z0-9]{6,}\b/g, '$1_…')
      // JWTs and other long opaque strings.
      .replace(/\b[A-Za-z0-9_-]{32,}(?:\.[A-Za-z0-9_-]+){0,2}\b/g, '<token>')
      // Discord's and Telegram's ids, phone numbers.
      .replace(/-?\b\d{6,}\b/g, '<n>')
  );
}

/** A request's path, masked, without its query string: one line per route. */
export function routeOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split('?')[0] ?? url;
  }
  return mask(path);
}

/** One request the Worker answered, as the report reads it. */
export interface Invocation {
  at: number;
  method: string;
  route: string;
  status: number | null;
  outcome: string;
  wallMs: number | null;
}

/** One log line of the Worker (console.warn, console.error…), masked. */
export interface LogLine {
  at: number;
  level: string;
  message: string;
}

interface RawEvent {
  timestamp?: unknown;
  source?: unknown;
  $metadata?: Record<string, unknown>;
  $workers?: Record<string, unknown>;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The events Cloudflare gave, split into requests and log lines. */
export function readEvents(events: readonly RawEvent[]): {
  invocations: Invocation[];
  lines: LogLine[];
} {
  const invocations: Invocation[] = [];
  const lines: LogLine[] = [];
  for (const event of events) {
    const at = num(event.timestamp) ?? 0;
    const workers = event.$workers ?? {};
    const metadata = event.$metadata ?? {};
    const detail = (workers.event ?? {}) as {
      request?: { url?: unknown; method?: unknown };
      response?: { status?: unknown };
    };
    const outcome = text(workers.outcome);
    const level = text(metadata.level)?.toLowerCase() ?? '';
    // The invocation's own record: an outcome and the request it answered.
    if (outcome && workers.eventType === 'fetch' && detail.request) {
      invocations.push({
        at,
        method: text(detail.request.method) ?? '?',
        route: routeOf(text(detail.request.url) ?? text(metadata.url) ?? '?'),
        status: num(detail.response?.status),
        outcome,
        wallMs: num(workers.wallTimeMs),
      });
      continue;
    }
    if (level === 'error' || level === 'warn' || level === 'warning' || metadata.error) {
      const message =
        text(metadata.message) ??
        text(metadata.error) ??
        (typeof event.source === 'string' ? event.source : JSON.stringify(event.source ?? ''));
      lines.push({ at, level: level || 'error', message: mask(message).slice(0, 240) });
    }
  }
  return { invocations, lines };
}

const quantile = (sorted: readonly number[], q: number) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
const minute = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/** The report, in Markdown: routes, the requests to look at, the warnings and errors. */
export function report(
  worker: string,
  hours: number,
  { invocations, lines }: { invocations: Invocation[]; lines: LogLine[] },
): string {
  const out: string[] = [`### What ${worker} logged over the last ${hours} hours`, ''];
  if (invocations.length === 0 && lines.length === 0) {
    out.push('Nothing: no request reached the Worker and it logged nothing.');
    return out.join('\n');
  }
  // Per route: count, answers, outcomes, time taken.
  const routes = new Map<string, Invocation[]>();
  for (const call of invocations) {
    const key = `${call.method} ${call.route}`;
    routes.set(key, [...(routes.get(key) ?? []), call]);
  }
  out.push(
    '| Request | Count | Answers | Outcomes | Median | Slowest |',
    '|---|---|---|---|---|---|',
  );
  for (const [key, calls] of [...routes].sort((a, b) => b[1].length - a[1].length)) {
    const tally = (values: string[]) =>
      [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())]
        .map(([v, n]) => `${v}×${n}`)
        .join(' ');
    const times = calls.flatMap((c) => (c.wallMs === null ? [] : [c.wallMs])).sort((a, b) => a - b);
    const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v)} ms`);
    out.push(
      `| \`${key}\` | ${calls.length} | ${tally(calls.map((c) => String(c.status ?? 'none')))} | ` +
        `${tally(calls.map((c) => c.outcome))} | ${ms(quantile(times, 0.5))} | ` +
        `${ms(times.at(-1) ?? null)} |`,
    );
  }
  // The requests to look at, one by one.
  const odd = invocations
    .filter(
      (c) =>
        c.outcome !== 'ok' ||
        c.status === null ||
        c.status >= 500 ||
        (c.wallMs !== null && c.wallMs > SLOW_MS),
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, 60);
  out.push('', `#### Slow (> ${SLOW_MS / 1000} s), failed or unfinished requests: ${odd.length}`);
  for (const c of odd) {
    out.push(
      `- ${minute(c.at)} UTC \`${c.method} ${c.route}\` → ${c.status ?? 'no answer'}, ` +
        `${c.outcome}, ${c.wallMs === null ? '?' : `${Math.round(c.wallMs)} ms`}`,
    );
  }
  // Warnings and errors, the same message counted once.
  const messages = new Map<string, { level: string; count: number; last: number }>();
  for (const line of lines) {
    const seen = messages.get(line.message);
    messages.set(line.message, {
      level: line.level,
      count: (seen?.count ?? 0) + 1,
      last: Math.max(seen?.last ?? 0, line.at),
    });
  }
  out.push('', `#### Warnings and errors: ${lines.length}`);
  for (const [message, seen] of [...messages].sort((a, b) => b[1].last - a[1].last).slice(0, 40)) {
    out.push(`- ${seen.level} ×${seen.count} (last ${minute(seen.last)} UTC): \`${message}\``);
  }
  return out.join('\n');
}

type Filter = Record<string, unknown>;

/** The Worker's invocations (its HTTP requests), then its warnings and errors. */
const QUERIES: readonly { name: string; filters: (worker: string) => Filter[] }[] = [
  {
    name: 'requests',
    filters: (worker) => [
      { key: '$metadata.service', operation: 'eq', type: 'string', value: worker },
      { key: '$workers.eventType', operation: 'eq', type: 'string', value: 'fetch' },
    ],
  },
  {
    name: 'warnings',
    filters: (worker) => [
      { key: '$metadata.service', operation: 'eq', type: 'string', value: worker },
      {
        kind: 'group',
        filterCombination: 'or',
        filters: ['error', 'warn'].map((level) => ({
          key: '$metadata.level',
          operation: 'eq',
          type: 'string',
          value: level,
        })),
      },
    ],
  },
];

/** Events per page, and pages read at most per query. */
export const PAGE_SIZE = 100;
export const MAX_PAGES = 20;

/**
 * Cloudflare's events for `worker` over the last `hours` (its requests, its warnings and
 * errors, page by page), or why there are none. `truncated` when a query had more than
 * MAX_PAGES pages.
 */
export async function readLogs(
  account: string,
  token: string,
  worker: string,
  hours: number,
  now: Date,
  inject: { fetch?: Fetch } = {},
): Promise<{ events: RawEvent[]; truncated: boolean } | { error: string }> {
  const send: Fetch = inject.fetch ?? ((url, init) => fetch(url, init));
  const to = now.getTime();
  const events: RawEvent[] = [];
  let truncated = false;
  for (const query of QUERIES) {
    let offset: string | undefined;
    for (let page = 0; ; page += 1) {
      if (page === MAX_PAGES) {
        truncated = true;
        break;
      }
      const body = {
        queryId: `stayput-inspect-${query.name}`,
        timeframe: { from: to - hours * 3_600_000, to },
        view: 'events',
        limit: PAGE_SIZE,
        ...(offset ? { offset, offsetDirection: 'next' } : {}),
        parameters: { datasets: ['cloudflare-workers'], filters: query.filters(worker) },
      };
      const answer = await askCloudflare(send, account, token, body);
      if ('error' in answer) return answer;
      events.push(...answer.events);
      const last = answer.events.at(-1)?.$metadata?.id;
      if (answer.events.length < PAGE_SIZE || typeof last !== 'string') break;
      offset = last;
    }
  }
  return { events, truncated };
}

async function askCloudflare(
  send: Fetch,
  account: string,
  token: string,
  body: unknown,
): Promise<{ events: RawEvent[] } | { error: string }> {
  try {
    const response = await send(
      `${API}/accounts/${account}/workers/observability/telemetry/query`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const answer = (await response.json().catch(() => null)) as {
      success?: boolean;
      result?: { events?: { events?: RawEvent[] } };
      errors?: { code?: number; message?: string }[];
    } | null;
    if (!response.ok || !answer?.success) {
      const first = answer?.errors?.[0];
      const why = first ? `: ${first.code ?? ''} ${mask(first.message ?? '')}`.trimEnd() : '';
      return { error: `Cloudflare answered HTTP ${response.status}${why}` };
    }
    return { events: answer.result?.events?.events ?? [] };
  } catch (error) {
    const why = error instanceof Error ? error.message : 'no answer';
    return { error: `Cloudflare could not be reached (${why})` };
  }
}

async function main(): Promise<void> {
  const [tomlPath, hoursArg] = process.argv.slice(2);
  if (!tomlPath) throw new Error('usage: tsx scripts/ops/worker-logs.ts <wrangler.toml> [hours]');
  const hours = Number(hoursArg ?? 48) || 48;
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const account = cloudflareAccountId(process.env.CLOUDFLARE_ACCOUNT_ID);
  if (!token || !account)
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed.');
  if (process.env.GITHUB_ACTIONS) console.info(`::add-mask::${account}`);
  const worker = workerName(process.env.STAYPUT_TARGET, readFileSync(tomlPath, 'utf8'));
  const read = await readLogs(account, token, worker, hours, new Date());
  const text =
    'error' in read
      ? `### What ${worker} logged\n\nNot read: ${read.error}. The token may lack the ` +
        '« Workers Observability: Read » permission (Cloudflare → My Profile → API Tokens).'
      : report(worker, hours, readEvents(read.events)) +
        (read.truncated
          ? `\n\nOnly the latest ${PAGE_SIZE * MAX_PAGES} events of each kind were read.`
          : '');
  console.info(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  if ('error' in read) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
