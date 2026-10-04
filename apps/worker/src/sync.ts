import { WhopApiError, type QueryValue, type WhopClient } from '@stayput/whop';
import type { Db } from './db';
import { DiscordApiError, type DiscordClient } from './discord';
import { noteChannelNames } from './integrations';

/**
 * The synchronization with Whop (SPEC Phase 2, 2 to 4): each creator's lists read into the
 * database, the first time 90 days back (the backfill), then what is new. The Worker only moves
 * pages: Postgres parses them and keeps track of where each list stands (sync_page in
 * supabase/migrations/0005_data_collection.sql), so that a run stays under the free plan's
 * 10 ms of CPU. It also stays under its 50 subrequests: at most SYNC_REQUEST_BUDGET calls to Whop
 * (and Discord) per run, and what does not fit goes on at the next run, from the saved cursor.
 * The channels a creator chose on their Discord server are read the same way, last.
 */

/** One Whop list (or a Discord channel), read in passes from its top. */
export interface Stream {
  /** `sync_state.stream`; a scoped stream is `<name>:<channel, forum or course id>`. */
  name: string;
  /** What ingest_page stores. */
  kind: string;
  /** Where the pages come from: Whop, unless it says Discord. */
  source?: 'discord';
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
  /** While the creator watches (refreshDiscordAfterSeconds), read again no sooner than this. */
  liveSeconds?: number;
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
  {
    // The channels a creator follows on their Discord server (set_discord_channels creates one
    // stream each): the newest messages first, 100 a page, the next page before the last one.
    // Every 3 hours: a server has many channels, and a day's activity is what scores read.
    name: 'discord_messages',
    kind: 'discord_messages',
    source: 'discord',
    path: '/channels/{id}/messages',
    query: () => ({}),
    stop: 'oldest',
    everyHours: 3,
    backfillDays: 90,
    scoped: true,
  },
  {
    // Everyone on a connected Discord server (connect_discord_guild creates the stream, the
    // founder asked to see them all on 2026-10-01): its member list read to the end, 1000 a
    // page, every 6 hours and each minute while the creator watches; who the end did not meet
    // has left. Discord gives the list only to an application with the Server Members Intent
    // turned on: 403 otherwise, and the Sources tab says how to turn it on.
    name: 'discord_members',
    kind: 'discord_members',
    source: 'discord',
    path: '/guilds/{id}/members',
    query: () => ({}),
    stop: 'end',
    everyHours: 6,
    liveSeconds: 60,
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
/**
 * Whop profiles read per company and run at most, for the Discord account members linked on
 * Whop (link_member_discord): a large community is linked over a few runs.
 */
export const PROFILES_PER_RUN = 10;

export interface StreamState {
  stream: string;
  cursor: string | null;
  highWater: Date | null;
  backfillDone: boolean;
  lastPassAt: Date | null;
  lastCompletePassAt: Date | null;
  /** The last attempt failed (`403 …`: a permission the creator did not grant). */
  lastError: string | null;
}

export interface PassOptions {
  /**
   * Try again now the streams whose last attempt failed: the creator may just have granted a
   * permission (opening the dashboard, « Sync now »).
   */
  retryFailed?: boolean;
  /**
   * « Sync now »: a Discord channel not read for this many seconds is read now, whatever its
   * cadence. Nothing tells StayPut of a new Discord message (Whop and Telegram send theirs), so
   * a creator trying it out would otherwise wait up to 3 hours.
   */
  refreshDiscordAfterSeconds?: number;
  /** Only the Discord channels: the creator watches the activity (refreshDiscordNow). */
  onlyDiscord?: boolean;
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

/**
 * What to read of a stream now, or null when it is caught up and not due. A stream whose last
 * attempt failed is tried again within the hour, whatever its cadence.
 */
export function planPass(
  stream: Stream,
  state: StreamState | undefined,
  now: Date,
  options: PassOptions = {},
): PassPlan | null {
  if (state?.cursor) return { cursor: state.cursor, start: false, until: null, complete: false };
  const due = (since: Date | null | undefined, hours: number) =>
    !since || now.getTime() - since.getTime() >= hours * 3_600_000 - DUE_MARGIN_MS;
  const failed = Boolean(state?.lastError);
  const retryNow = failed && options.retryFailed === true;
  const refreshAfter =
    options.refreshDiscordAfterSeconds === undefined
      ? undefined
      : Math.max(options.refreshDiscordAfterSeconds, stream.liveSeconds ?? 0);
  const refreshNow =
    stream.source === 'discord' &&
    refreshAfter !== undefined &&
    (!state?.lastPassAt || now.getTime() - state.lastPassAt.getTime() >= refreshAfter * 1000);
  const every = failed ? Math.min(stream.everyHours, 1) : stream.everyHours;
  if (!retryNow && !refreshNow && !due(state?.lastPassAt, every)) return null;
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
  /** Discord's API with the bot's token, when the Discord module is configured. */
  discord?: DiscordClient | null;
  now: Date;
  budget: { left: number };
  /**
   * Set when Discord refused the bot's token (401) or asked to slow down (429): its channels
   * wait for the next run, Whop's lists go on.
   */
  discordPaused?: string | null;
}

export type StreamOutcome = 'caught_up' | 'more' | 'failed';

export interface CompanySync {
  companyId: string;
  calls: number;
  streams: Record<string, StreamOutcome>;
  /** Whop profiles read for the Discord account members linked. */
  profiles: number;
  /** Why the run stopped here: Whop refuses the key (401) or asks to slow down (429). */
  stopped: string | null;
}

/** Reads a company's lists, within the budget. The caller holds the company (claimSync). */
export async function syncCompany(
  ctx: SyncContext,
  companyId: string,
  options: PassOptions = {},
): Promise<CompanySync> {
  const result: CompanySync = { companyId, calls: 0, streams: {}, profiles: 0, stopped: null };
  let states = await loadStates(ctx.db, companyId);
  let listed = false;
  for (const stream of STREAMS) {
    if (stream.source === 'discord' && (!ctx.discord || ctx.discordPaused)) continue;
    if (options.onlyDiscord && stream.source !== 'discord') continue;
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
      const state = states.get(name);
      const read = await readStream(ctx, companyId, stream, name, scope, state, options);
      if (!read) continue;
      result.streams[name] = read.outcome;
      result.calls += read.calls;
      if (read.stop && stream.source === 'discord') {
        ctx.discordPaused = read.stop;
        break;
      }
      if (read.stop) {
        result.stopped = read.stop;
        return result;
      }
      if (LISTINGS.has(stream.kind) && read.calls > 0) listed = true;
    }
  }
  if (ctx.discord && !options.onlyDiscord) {
    const linking = await linkDiscordAccounts(ctx, companyId);
    result.calls += linking.calls;
    result.profiles = linking.calls;
    if (linking.stop) result.stopped = linking.stop;
    if (!ctx.discordPaused) await readChannelNames(ctx, ctx.discord, companyId);
  }
  return result;
}

/** A server's channel names are read again after this long (Integrations › Discord, 0033). */
export const CHANNEL_NAMES_MAX_AGE_HOURS = 24;

/**
 * The names of the company's servers' channels, once a day: Integrations › Discord names its
 * channels from them without asking Discord on the way. A server Discord does not answer for
 * keeps the names it had; the next run asks again.
 */
async function readChannelNames(
  ctx: SyncContext,
  discord: DiscordClient,
  companyId: string,
): Promise<void> {
  const guilds = await ctx.db.query<{ guild_id: string }>(
    `select guild_id from stayput.discord_guilds
      where company_id = $1
        and (channel_names_at is null
             or channel_names_at <= $2::timestamptz - make_interval(hours => $3))
      order by guild_id`,
    [companyId, ctx.now.toISOString(), CHANNEL_NAMES_MAX_AGE_HOURS],
  );
  for (const { guild_id: guildId } of guilds) {
    try {
      const channels = await discord.guildChannels(guildId);
      await noteChannelNames(ctx.db, companyId, guildId, channels, ctx.now);
    } catch (error) {
      console.warn(`The channels of Discord server ${guildId} were not read: ${describe(error)}`);
    }
  }
}

/**
 * The Discord account each member linked on Whop (their primary Discord, public to the apps of
 * their communities), for a company that connected a Discord server: never read members first,
 * then every week (members_to_link). A Whop user that does not exist is marked read.
 */
async function linkDiscordAccounts(
  ctx: SyncContext,
  companyId: string,
): Promise<{ calls: number; stop?: string }> {
  let calls = 0;
  const limit = Math.min(PROFILES_PER_RUN, ctx.budget.left);
  if (limit <= 0) return { calls };
  const now = ctx.now.toISOString();
  const users = await ctx.db.query<{ user_id: string }>(
    'select stayput.members_to_link($1, $2::timestamptz, $3) as user_id',
    [companyId, now, limit],
  );
  for (const { user_id: userId } of users) {
    if (ctx.budget.left <= 0) break;
    ctx.budget.left -= 1;
    calls += 1;
    let profile: string;
    try {
      profile = await ctx.whop.getRaw(`/users/${encodeURIComponent(userId)}`);
    } catch (error) {
      const status = error instanceof WhopApiError ? error.status : 0;
      if (status === 401) return { calls, stop: 'Whop refuses the key (401)' };
      if (status === 429) return { calls, stop: 'Whop asks to slow down (429)' };
      if (status === 400 || status === 404 || status === 422) {
        await ctx.db.query('select stayput.mark_discord_checked($1, $2, $3::timestamptz)', [
          companyId,
          userId,
          now,
        ]);
        continue;
      }
      // Whop is unavailable: the next run tries again.
      console.warn(`Whop profile ${userId} not read: ${describe(error)}`);
      break;
    }
    try {
      await ctx.db.query(
        'select stayput.link_member_discord($1, $2::text::jsonb, $3::timestamptz)',
        [companyId, profile, now],
      );
    } catch (error) {
      // A profile Postgres cannot read: skipped until next week rather than read every run.
      console.warn(`Whop profile ${userId} not stored: ${describe(error)}`);
      await ctx.db.query('select stayput.mark_discord_checked($1, $2, $3::timestamptz)', [
        companyId,
        userId,
        now,
      ]);
    }
  }
  return { calls };
}

async function readStream(
  ctx: SyncContext,
  companyId: string,
  stream: Stream,
  name: string,
  scope: string | null,
  state: StreamState | undefined,
  options: PassOptions,
): Promise<{ outcome: StreamOutcome; calls: number; stop?: string } | null> {
  const plan = planPass(stream, state, ctx.now, options);
  if (!plan) return null;
  let { cursor, start } = plan;
  let calls = 0;
  const roster = stream.kind === 'discord_members';
  for (;;) {
    if (ctx.budget.left <= 0) return { outcome: 'more', calls };
    ctx.budget.left -= 1;
    calls += 1;
    let page: string;
    try {
      page =
        stream.source === 'discord' && ctx.discord
          ? roster
            ? await ctx.discord.membersRaw(scope ?? '', cursor)
            : await ctx.discord.messagesRaw(scope ?? '', cursor)
          : await ctx.whop.listPageRaw(stream.path, stream.query(companyId, scope), {
              after: cursor,
            });
    } catch (error) {
      const status =
        error instanceof WhopApiError || error instanceof DiscordApiError ? error.status : 0;
      await recordError(ctx, companyId, name, status, describe(error));
      // These concern every company: the run stops (Whop), or leaves Discord for the next one.
      const who = stream.source === 'discord' ? 'Discord' : 'Whop';
      if (status === 401) return { outcome: 'failed', calls, stop: `${who} refuses the key (401)` };
      if (status === 429) {
        return { outcome: 'failed', calls, stop: `${who} asks to slow down (429)` };
      }
      return { outcome: 'failed', calls };
    }
    let next: string | null;
    try {
      // A new reading of a server's member list: who it meets is marked as it goes.
      if (roster && start) {
        await ctx.db.query('select stayput.discord_roster_start($1, $2)', [companyId, scope]);
      }
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
      // The end of the list: who the reading did not meet has left the server.
      if (roster && next === null) {
        await ctx.db.query('select stayput.discord_roster_end($1, $2, $3::timestamptz)', [
          companyId,
          scope,
          ctx.now.toISOString(),
        ]);
      }
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
    last_error: string | null;
  }>(
    `select stream, cursor, high_water, backfill_done, last_pass_at, last_complete_pass_at,
            last_error
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
        lastError: r.last_error,
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
  options: PassOptions = {},
): Promise<CompanySync | null> {
  const now = ctx.now.toISOString();
  const [claim] = await ctx.db.query<{ claimed: boolean }>(
    'select stayput.claim_sync($1, $2::timestamptz, $3, $4) as claimed',
    [companyId, now, SYNC_LEASE_SECONDS, minIntervalSeconds],
  );
  if (!claim?.claimed) return null;
  try {
    return await syncCompany(ctx, companyId, options);
  } finally {
    await ctx.db.query('select stayput.release_sync($1, $2::timestamptz)', [companyId, now]);
  }
}

/**
 * While the creator watches the activity, a Discord channel is read again after this long (the
 * founder, 2026-10-01: a new message should show within seconds).
 */
export const LIVE_DISCORD_REFRESH_SECONDS = 15;
/** Discord calls such a read makes at most: a channel or two in a page, usually. */
export const LIVE_DISCORD_BUDGET = 10;

/**
 * The company's Discord channels read now when not read for 15 seconds, while its creator watches
 * what StayPut sees (nothing tells StayPut of a Discord message). Only Discord, and the company's
 * last synchronization is left as it was: Whop's lists keep their cadence. Null when a run holds
 * the company.
 */
export async function refreshDiscordNow(
  ctx: SyncContext,
  companyId: string,
): Promise<CompanySync | null> {
  if (!ctx.discord) return null;
  const [claim] = await ctx.db.query<{ claimed: boolean }>(
    'select stayput.claim_lease($1, $2::timestamptz, $3) as claimed',
    [companyId, ctx.now.toISOString(), SYNC_LEASE_SECONDS],
  );
  if (!claim?.claimed) return null;
  try {
    return await syncCompany(ctx, companyId, {
      onlyDiscord: true,
      refreshDiscordAfterSeconds: LIVE_DISCORD_REFRESH_SECONDS,
    });
  } finally {
    await ctx.db.query('select stayput.release_lease($1)', [companyId]);
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
    result.profiles > 0 ? `${result.profiles} profile(s) read` : '',
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

/**
 * The community's name as Whop shows it (the company's `title`), and its logo: the members'
 * messages, cards and pages say the name, the dashboard shows both. Read when StayPut has no
 * name yet, or with a sync; kept as they were when Whop does not answer. `/companies/{id}`
 * (company:basic:read): its account, `/accounts/{id}`, answers 403 to an app key (checked live
 * by Inspect, 2 October).
 */
export async function refreshCompanyName(
  db: Db,
  whop: WhopClient,
  companyId: string,
): Promise<string | null> {
  try {
    const company = await whop.request<{ title?: unknown; logo?: unknown }>(
      'GET',
      `/companies/${encodeURIComponent(companyId)}`,
    );
    const title = typeof company.title === 'string' ? company.title.trim().slice(0, 200) : '';
    const logo = logoUrl(company.logo);
    if (!title) return null;
    await db.query(
      `update stayput.companies set name = $2, logo_url = $3
        where id = $1 and (name is distinct from $2 or logo_url is distinct from $3)`,
      [companyId, title, logo],
    );
    return title;
  } catch (error) {
    console.error('Company name not read:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Whop gives a logo as an attachment ({ url }) or a link; StayPut keeps an https one only. */
export function logoUrl(logo: unknown): string | null {
  const url =
    typeof logo === 'string'
      ? logo
      : typeof logo === 'object' &&
          logo !== null &&
          typeof (logo as { url?: unknown }).url === 'string'
        ? (logo as { url: string }).url
        : null;
  return url && /^https:\/\//.test(url) && url.length <= 2000 ? url : null;
}
