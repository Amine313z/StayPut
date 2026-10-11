import type { Db } from './db';
import type { Config } from './env';

/**
 * The private beta (INVITE_ONLY, decisions of 2026-10-10 and 2026-10-11): StayPut works for the
 * operator's community and the communities the founder invited (still invited, or subscribed),
 * and for no other. The routes shut the door (app.ts); the webhooks are acknowledged unkept; and
 * the cron does nothing that reaches anyone for a community the beta keeps out (shutInBeta).
 */

/**
 * Whether the private beta lets the company in: always without INVITE_ONLY; else the operator's
 * community and the communities the founder invited; and, with `opener`, those this user opened
 * StayPut in (the founder's own, for their webhooks and background work: their team stays shut
 * out of the routes).
 */
export async function openInBeta(
  db: Db,
  config: Config,
  companyId: string,
  opener: string | null,
): Promise<boolean> {
  if (!config.inviteOnly || companyId === config.operatorCompanyId) return true;
  const [row] = await db.query<{ open: boolean }>(
    `select exists (select 1 from stayput.founders
                     where company_id = $1 and status in ('invited', 'subscribed'))
         or exists (select 1 from stayput.company_admins
                     where company_id = $1 and user_id = $2) as open`,
    [companyId, opener],
  );
  return row?.open === true;
}

/**
 * The active communities StayPut has that the beta keeps out: recorded before the door was there,
 * or taken out of the registry since. The cron sends nothing for them (no action, no Monday
 * report) and reads nothing more from Whop (no synchronization); what StayPut has of them waits,
 * untouched, and goes on again if the founder invites them. Empty without INVITE_ONLY.
 */
export async function shutInBeta(db: Db, config: Config): Promise<ReadonlySet<string>> {
  if (!config.inviteOnly) return new Set();
  const rows = await db.query<{ id: string }>(
    `select c.id from stayput.companies c
      where c.status = 'active' and not c.is_demo and c.id is distinct from $1
        and not exists (select 1 from stayput.founders f
                         where f.company_id = c.id and f.status in ('invited', 'subscribed'))
        and not exists (select 1 from stayput.company_admins a
                         where a.company_id = c.id and a.user_id = $2)`,
    [config.operatorCompanyId, config.plans.adminUserId],
  );
  return new Set(rows.map((row) => row.id));
}
