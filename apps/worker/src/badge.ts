import { BADGE_MIN_MEMBERS, BADGE_MONTHS, type BadgeLocale, type BadgeView } from '@stayput/core';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * The « Verified retention » badge (SPEC Phase 6.11): the share of the members who joined in the
 * last 12 months still there after 90 days, from the weekly analyses (cohort_stats). The team
 * reads and sets it under RLS; the public routes (/badge/:id.svg, /verify/:id) read only what a
 * community chose to show.
 */

export interface VerifiedRetention {
  /** Null while fewer than BADGE_MIN_MEMBERS are old enough. */
  retention: number | null;
  members: number;
  /** When the weekly analyses last counted them; null before. */
  computedAt: string | null;
}

/** The figure, as the badge and its page show it. */
export async function verifiedRetention(
  db: Db,
  companyId: string,
  now: Date,
): Promise<VerifiedRetention> {
  const [row] = await db.query<{
    members: number;
    left_90: number;
    computed_at: Date | string | null;
  }>(
    `select coalesce(sum(eligible_90), 0)::int as members,
            coalesce(sum(left_by_90), 0)::int as left_90, max(computed_at) as computed_at
       from stayput.cohort_stats
      where company_id = $1
        and cohort_month >= (date_trunc('month', $2::timestamptz)
                             - make_interval(months => $3))::date`,
    [companyId, now.toISOString(), BADGE_MONTHS],
  );
  const members = row?.members ?? 0;
  return {
    retention:
      members >= BADGE_MIN_MEMBERS
        ? Math.round((1 - (row?.left_90 ?? 0) / members) * 10_000) / 10_000
        : null,
    members,
    computedAt: row?.computed_at ? new Date(row.computed_at).toISOString() : null,
  };
}

/** Settings › General, the badge: on or off, its figure, its addresses on this Worker. */
export async function readBadge(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
  origin: string,
): Promise<BadgeView | null> {
  return withUser(db, userId, async (tx) => {
    const [company] = await tx.query<{ locale: string; enabled: boolean | null }>(
      `select c.locale, (s.options ->> 'public_badge')::boolean as enabled
         from stayput.companies c
         left join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    );
    if (!company) return null;
    const figure = await verifiedRetention(tx, companyId, now);
    return {
      enabled: company.enabled === true,
      retention: figure.retention,
      members: figure.members,
      locale: badgeLocale(company.locale),
      badgeUrl: `${origin}/badge/${companyId}.svg`,
      verifyUrl: `${origin}/verify/${companyId}`,
    };
  });
}

/** The badge on or off (requireCreator checked the team member with Whop). */
export async function saveBadgeSetting(db: Db, companyId: string, enabled: boolean) {
  await db.query('select stayput.save_badge_setting($1, $2)', [companyId, enabled]);
}

export interface PublicBadge extends VerifiedRetention {
  retention: number;
  name: string | null;
  locale: BadgeLocale;
}

/**
 * What the public may see: a community still using StayPut, its badge on, with a figure. Null
 * otherwise, whichever the reason (never says which).
 */
export async function readPublicBadge(
  db: Db,
  companyId: string,
  now: Date,
): Promise<PublicBadge | null> {
  const [company] = await db.query<{ name: string | null; locale: string }>(
    `select c.name, c.locale
       from stayput.companies c
       join stayput.company_settings s on s.company_id = c.id
      where c.id = $1 and c.status = 'active' and not c.is_demo
        and coalesce((s.options ->> 'public_badge')::boolean, false)`,
    [companyId],
  );
  if (!company) return null;
  const figure = await verifiedRetention(db, companyId, now);
  if (figure.retention === null) return null;
  return {
    ...figure,
    retention: figure.retention,
    name: company.name,
    locale: badgeLocale(company.locale),
  };
}

const badgeLocale = (locale: string): BadgeLocale => (locale === 'fr' ? 'fr' : 'en');
