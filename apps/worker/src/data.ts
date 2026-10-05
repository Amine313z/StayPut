import type { DataExport, TeamView } from '@stayput/core';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * Settings › General (SPEC Phase 6.12): who on the team uses StayPut, and the community's data,
 * exported or deleted at its team's request.
 */

/**
 * Every table with a community's rows, in the export: read under RLS as the team member, so
 * only that community's. A new table with a `company_id` goes here, or in NOT_EXPORTED with its
 * reason: data.test.ts fails otherwise.
 */
export const EXPORTED_TABLES = [
  'company_settings',
  'members',
  'memberships',
  'payments',
  'activity_events',
  'member_stats_daily',
  'activity_hours',
  'member_risk',
  'risk_scores',
  'cohort_stats',
  'lesson_dropoff_stats',
  'actions',
  'saves',
  'exit_surveys',
  'creator_offers',
  'alumni_offers',
  'alumni_members',
  'weekly_reports',
  'platform_accounts',
  'platform_presence',
  'discord_guilds',
  'telegram_chats',
  'telegram_topics',
  'goals',
  'results',
  'proofs',
  'milestones',
  'member_badges',
  'buddy_pairs',
  'rescue_challenges',
  'rescue_challenge_participants',
  'plans',
  'billing',
  'audit_log',
  'sync_state',
] as const;

/** The tables with a `company_id` the export leaves out, and why. */
export const NOT_EXPORTED: Readonly<Record<string, string>> = {
  company_admins: 'who on the team opened StayPut: in the export as `team`',
  company_sync: 'the Worker’s own bookkeeping of its passes',
  pending_activity: 'messages waiting a few minutes for their member, never kept',
  webhook_events: 'Whop’s raw deliveries, kept a few days for replays',
};

/** Rows exported per table at most: beyond, the table says so (`truncated`). */
export const EXPORT_ROW_LIMIT = 100_000;

export async function exportCompanyData(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<DataExport | null> {
  return withUser(db, userId, async (tx) => {
    const [company] = await tx.query<Record<string, unknown>>(
      'select * from stayput.companies where id = $1',
      [companyId],
    );
    if (!company) return null;
    const tables: DataExport['tables'] = {};
    for (const table of EXPORTED_TABLES) {
      const rows = await tx.query<Record<string, unknown>>(
        `select * from stayput.${table} where company_id = $1 limit $2`,
        [companyId, EXPORT_ROW_LIMIT + 1],
      );
      tables[table] = {
        rows: rows.slice(0, EXPORT_ROW_LIMIT),
        truncated: rows.length > EXPORT_ROW_LIMIT,
      };
    }
    const team = await teamOf(tx, companyId);
    return { exportedAt: now.toISOString(), company, team: team.members, tables };
  });
}

/** The Whop team: its admins Whop lists among the members, and who opened StayPut, when last. */
export async function readTeam(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<TeamView> {
  return withUser(db, userId, (tx) => teamOf(tx, companyId));
}

async function teamOf(tx: Db, companyId: string): Promise<TeamView> {
  const rows = await tx.query<{
    user_id: string;
    name: string | null;
    username: string | null;
    opened_at: Date | string | null;
  }>(
    `with opened as (select user_id, opened_at from stayput.team_access($1)),
          admins as (
            select m.user_id, m.display_name, m.username from stayput.members m
             where m.company_id = $1 and m.access_level = 'admin')
     select coalesce(a.user_id, o.user_id) as user_id, a.display_name as name, a.username,
            o.opened_at
       from admins a
       full join opened o on o.user_id = a.user_id
      order by o.opened_at desc nulls last, a.display_name, 1`,
    [companyId],
  );
  return {
    members: rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      username: r.username,
      openedAt: r.opened_at === null ? null : new Date(r.opened_at).toISOString(),
    })),
  };
}

/**
 * Everything StayPut keeps about the community, deleted (requireCreator checked the team member
 * with Whop, the request repeated the community's id). True when there was something to delete.
 */
export async function deleteCompanyData(db: Db, companyId: string): Promise<boolean> {
  const [row] = await db.query<{ deleted: boolean }>(
    'select stayput.delete_company_data($1) as deleted',
    [companyId],
  );
  return row?.deleted === true;
}
