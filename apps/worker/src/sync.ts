import { WhopApiError, type QueryValue, type WhopClient } from '@stayput/whop';
import type { Db } from './db';

/**
 * The synchronization with Whop (SPEC Phase 2, 2 to 4): each creator's lists read into the
 * database, the first time 90 days back (the backfill), then what is new. The Worker only moves
 * pages: Postgres parses them and keeps track of where each list stands (sync_page in
 * supabase/migrations/0005_data_collection.sql), so that a run stays under the free plan's
 * 10 ms of CPU. It also stays under its 50 subrequests: at most SYNC_REQUEST_BUDGET calls to Whop
 * per run, and what does not fit goes on at the next run, from the saved cursor.
 */

/** One Whop list, read in passes from its top. */
export interface Stream {
  /** `sync_state.stream`; a scoped stream is `<name>:<channel, forum or course id>`. */
  name: string;
  /** What ingest_page stores. */
  kind: string;
  path: string;
  query(companyId: string, scope: string | null): Record<string, QueryValue>;
  /**
   * How a pass sees it has caught up: `oldest` for a list sorted newest first (the page reaches
   * what an earlier pass read), `newest` for a list only roughly so, pinned items first (the
   * whole page is older), `end` for a list in no useful order (read to the end).
   */
  stop: 'oldest' | 'newest' | 'end';
  /** A new pass at most this often. */
  everyHours: number;
  /** For `oldest` and `newest`: a pass reading the whole list at least this often. */
  completeEveryHours?: number;
  /** How far back the first pass reads; the whole list when absent. */
  backfillDays?: number;
  /** One stream per id a listing found (`chat_channels` → `messages:<channel id>`). */
  scoped?: boolean;
}

const account = (companyId: string) => ({ account_id: companyId });
const newestFirst = { order: 'created_at', direction: 'desc' } as const;

/**
 * Every stream, in the order a run reads them: what the money depends on first, then activity.
 * Webhooks bring changes in real time (memberships, payments, lessons…); the passes fill the
 * history and catch what a webhook missed.
 */
export const STREAMS: readonly Stream[] = [
  {
    name: 'plans',
    kind: 'plans',
    path: '/variants',
    query: account,
    stop: 'end',
    everyHours: 24,
  },
  {
    name: 'members',
    kind: 'members',
    path: '/members',
    query: (c) => ({ ...account(c), ...newestFirst }),
    stop: 'oldest',
    everyHours: 1,
    completeEveryHours: 24,
  },
  {
    name: 'memberships',
    kind: 'memberships',
    path: '/memberships',
    query: (c) => ({ ...account(c), ...newestFirst }),
    stop: 'oldest',
    everyHours: 1,
    completeEveryHours: 24,
  },
  {
    name: 'payments',
    kind: 'payments',
    path: '/payments',
    query: (c) => ({ ...account(c), ...newestFirst }),
    stop: 'oldest',
    everyHours: 1,
    backfillDays: 90,
  },
  {
    name: 'support_channels',
    kind: 'support_channels',
    path: '/support_channels',
    query: account,
    stop: 'end',
    everyHours: 1,
  },
  {
    name: 'chat_channels',
    kind: 'chat_channels',
    path: '/chat_channels',
    query: account,
    stop: 'end',
    everyHours: 24,
  },
  { name: 'forums', kind: 'forums', path: '/forums', query: account, stop: 'end', everyHours: 24 },
  {
    name: 'courses',
    kind: 'courses',
    path: '/courses',
    query: account,
    stop: 'end',
    everyHours: 24,
  },
  {
    name: 'messages',
    kind: 'messages',
    path: '/messages',
    query: (_, channel) => ({ channel_id: channel, direction: 'desc' }),
    stop: 'oldest',
    everyHours: 1,
    backfillDays: 90,
    scoped: true,
  },
  {
    // Whop documents no order for forum posts: pinned posts first, then the newest, is assumed,
    // and a complete pass every day catches up if that is wrong.
    name: 'forum_posts',
    kind: 'forum_posts',
    path: '/forum_posts',
    query: (_, experience) => ({ experience_id: experience }),
    stop: 'newest',
    everyHours: 1,
    completeEveryHours: 24,
    backfillDays: 90,
    scoped: true,
  },
  {
    // Completed lessons arrive by webhook (course_lesson_interaction.completed): the daily pass
    // brings the history and what a webhook missed.
    name: 'lesson_interactions',
    kind: 'lesson_interactions',
    path: '/course_lesson_interactions',
    query: (_, course) => ({ course_id: course, completed: true }),
    stop: 'end',
    everyHours: 24,
    scoped: true,
  },
];

/** Listings whose items open scoped streams. */
const LISTINGS = new Set(['chat_channels', 'forums', 'courses']);

/** Whop calls per run: the free plan allows 50 subrequests, the database takes a few. */
export const SYNC_REQUEST_BUDGET = 40;
/** A run holds a company this long at most: one that dies frees it then. */
export const SYNC_LEASE_SECONDS = 5 * 60;
/** A company that is caught up is read again after this long. */
export const SYNC_INTERVAL_SECONDS = 50 * 60;
/** A pass due within this margin runs now rather than at the next run, 10 minutes later. */
const DUE_MARGIN_MS = 5 * 60_000;

export interface StreamState {
  stream: string;
  cursor: string | null;
  highWater: Date | null;
  backfillDone: boolean;
  lastPassAt: Date | null;
  lastCompletePassAt: Date | null;
}

export interface PassPlan {
  /** Whop's cursor to resume from; null to start from the top of the list. */
  cursor: string | null;
  /** Opens a new pass (the next fields then describe it; a resumed pass keeps its own). */
  start: boolean;
  /** Reads back to items of this time; null: to the end of the list. */
  until: Date | null;
  /** Reads the whole list (or the backfill window). */
  complete: boolean;
}

/** What to read of a stream now, or null when it is caught up and not due. */
export function planPass(
  stream: Stream,
  state: StreamState | undefined,
  now: Date,
): PassPlan | null {
  if (state?.cursor) return { cursor: state.cursor, start: false, until: null, complete: false };
  const due = (since: Date | null | undefined, hours: number) =>
    !since || now.getTime() - since.getTime() >= hours * 3_600_000 - DUE_MARGIN_MS;
  if (!due(state?.lastPassAt, stream.everyHours)) return null;
  const complete =
    stream.stop === 'end' ||
    !state?.backfillDone ||
    (stream.completeEveryHours !== undefined &&
      due(state.lastCompletePassAt, stream.completeEveryHours));
  let until: Date | null = null;
  if (stream.stop !== 'end') {
    if (!complete) until = state?.highWater ?? null;
    else if (stream.backfillDays)
      until = new Date(now.getTime() - stream.backfillDays * 86_400_000);
  }
  return { cursor: null, start: true, until, complete };
}

export interface SyncContext {
  db: Db;
  /** A client that never retries: each call is one subrequest, counted in `budget`. */
  whop: WhopClient;
  now: Date;
  budget: { left: number };
}

export type StreamOutcome = 'caught_up' | 'more' | 'failed';

export interface CompanySync {
  companyId: string;
  calls: number;
  streams: Record<string, StreamOutcome>;
  /** Why the run stopped here: Whop refuses the key (401) or asks to slow down (429). */
  stopped: string | null;
}

/** Reads a company's lists, within the budget. The caller holds the company (claimSync). */
export async function syncCompany(ctx: SyncContext, companyId: string): Promise<CompanySync> {
  const result: CompanySync = { companyId, calls: 0, streams: {}, stopped: null };
  let states = await loadStates(ctx.db, companyId);
  let listed = false;
  for (const stream of STREAMS) {
    if (stream.scoped && listed) {
      // Channels, forums or courses were just listed: their streams exist now.
      states = await loadStates(ctx.db, companyId);
      listed = false;
    }
    const names = stream.scoped
      ? [...states.keys()].filter((name) => name.startsWith(`${stream.name}:`)).sort()
      : [stream.name];
    for (const name of names) {
      if (ctx.budget.left <= 0) return result;
      const scope = stream.scoped ? name.slice(stream.name.length + 1) : null;
      const read = await readStream(ctx, companyId, stream, name, scope, states.get(name));
      if (!read) continue;
      result.streams[name] = read.outcome;
      result.calls += read.calls;
      if (read.stop) {
        result.stopped = read.stop;
        return result;
      }
      if (LISTINGS.has(stream.kind) && read.calls > 0) listed = true;
    }
  }
  return result;
}

async function readStream(
  ctx: SyncContext,
  companyId: string,
  stream: Stream,
  name: string,
  scope: string | null,
  state: StreamState | undefined,
): Promise<{ outcome: StreamOutcome; calls: number; stop?: string } | null> {
  const plan = planPass(stream, state, ctx.now);
  if (!plan) return null;
  let { cursor, start } = plan;
  let calls = 0;
  for (;;) {
    if (ctx.budget.left <= 0) return { outcome: 'more', calls };
    ctx.budget.left -= 1;
    calls += 1;
    let page: string;
    try {
      page = await ctx.whop.listPageRaw(stream.path, stream.query(companyId, scope), {
        after: cursor,
      });
    } catch (error) {
      const status = error instanceof WhopApiError ? error.status : 0;
      await recordError(ctx, companyId, name, status, describe(error));
      // These concern every company: the run stops.
      if (status === 401) return { outcome: 'failed', calls, stop: 'Whop refuses the key (401)' };
      if (status === 429) return { outcome: 'failed', calls, stop: 'Whop asks to slow down (429)' };
      return { outcome: 'failed', calls };
    }
    let next: string | null;
    try {
      const [row] = await ctx.db.query<{ next: string | null }>(
        `select stayput.sync_page($1, $2, $3, $4, $5::text::jsonb, $6::timestamptz, $7,
                                  $8::timestamptz, $9, $10) as next`,
        [
          companyId,
          name,
          stream.kind,
          scope,
          page,
          ctx.now.toISOString(),
          start,
          start ? (plan.until?.toISOString() ?? null) : null,
          start && plan.complete,
          stream.stop,
        ],
      );
      next = row?.next ?? null;
    } catch (error) {
      // The page could not be stored (Whop sent something unexpected): the next run retries it.
      await recordError(ctx, companyId, name, 0, `database: ${describe(error)}`);
      return { outcome: 'failed', calls };
    }
    if (next === null) return { outcome: 'caught_up', calls };
    cursor = next;
    start = false;
  }
}

async function loadStates(db: Db, companyId: string): Promise<Map<string, StreamState>> {
  const rows = await db.query<{
    stream: string;
    cursor: string | null;
    high_water: Date | string | null;
    backfill_done: boolean;
    last_pass_at: Date | string | null;
    last_complete_pass_at: Date | string | null;
  }>(
    `select stream, cursor, high_water, backfill_done, last_pass_at, last_complete_pass_at
       from stayput.sync_state where company_id = $1`,
    [companyId],
  );
  return new Map(
    rows.map((r) => [
      r.stream,
      {
        stream: r.stream,
        cursor: r.cursor,
        highWater: toDate(r.high_water),
        backfillDone: r.backfill_done,
        lastPassAt: toDate(r.last_pass_at),
        lastCompletePassAt: toDate(r.last_complete_pass_at),
      },
    ]),
  );
}

async function recordError(
  ctx: SyncContext,
  companyId: string,
  stream: string,
  status: number,
  message: string,
) {
  await ctx.db.query('select stayput.sync_error($1, $2, $3::timestamptz, $4, $5)', [
    companyId,
    stream,
    ctx.now.toISOString(),
    status,
    message,
  ]);
}

/**
 * Takes the company, reads it, gives it back. Null when another run holds it, or when it was
 * read less than `minIntervalSeconds` ago.
 */
export async function syncIfFree(
  ctx: SyncContext,
  companyId: string,
  minIntervalSeconds: number,
): Promise<CompanySync | null> {
  const now = ctx.now.toISOString();
  const [claim] = await ctx.db.query<{ claimed: boolean }>(
    'select stayput.claim_sync($1, $2::timestamptz, $3, $4) as claimed',
    [companyId, now, SYNC_LEASE_SECONDS, minIntervalSeconds],
  );
  if (!claim?.claimed) return null;
  try {
    return await syncCompany(ctx, companyId);
  } finally {
    await ctx.db.query('select stayput.release_sync($1, $2::timestamptz)', [companyId, now]);
  }
}

/** The cron's run: the companies that waited longest, while the budget lasts. */
export async function syncDueCompanies(ctx: SyncContext, limit = 10): Promise<CompanySync[]> {
  const due = await ctx.db.query<{ id: string }>(
    'select stayput.companies_to_sync($1::timestamptz, $2, $3) as id',
    [ctx.now.toISOString(), SYNC_INTERVAL_SECONDS, limit],
  );
  const results: CompanySync[] = [];
  for (const { id } of due) {
    if (ctx.budget.left <= 0) break;
    const result = await syncIfFree(ctx, id, 0);
    if (!result) continue;
    results.push(result);
    if (result.stopped) break;
  }
  return results;
}

/** One line per company for the logs: calls, and the streams not caught up. */
export function summarize(result: CompanySync): string {
  const behind = Object.entries(result.streams)
    .filter(([, outcome]) => outcome !== 'caught_up')
    .map(([name, outcome]) => `${name} ${outcome}`);
  return [
    `Sync ${result.companyId}: ${result.calls} call(s)`,
    behind.length > 0 ? behind.join(', ') : 'caught up',
    result.stopped ? `stopped: ${result.stopped}` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
