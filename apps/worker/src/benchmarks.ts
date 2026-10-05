import {
  BENCHMARK_MINIMUM,
  BENCHMARK_MIN_MEMBERS,
  BENCHMARK_MONTHS,
  COHORT_HORIZONS,
  NICHES,
  type BenchmarksView,
  type CohortHorizon,
  type Niche,
} from '@stayput/core';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * Anonymous benchmarks (SPEC Phase 6.10). The community's own retention comes from its weekly
 * analyses (cohort_stats); its niche's from stayput.benchmarks, which RLS shows only once 5
 * communities made a figure, and which a community sees only while it shares its own.
 */

export async function readBenchmarks(
  db: TransactionalDb,
  userId: string,
  companyId: string,
  now: Date,
): Promise<BenchmarksView | null> {
  return withUser(db, userId, async (tx) => {
    const [company] = await tx.query<{ niche: string; opted: boolean | null }>(
      `select c.niche, (s.options ->> 'benchmarks_opt_in')::boolean as opted
         from stayput.companies c
         left join stayput.company_settings s on s.company_id = c.id
        where c.id = $1`,
      [companyId],
    );
    if (!company) return null;
    const niche: Niche = (NICHES as readonly string[]).includes(company.niche)
      ? (company.niche as Niche)
      : 'other';
    const optedIn = company.opted === true;
    // The members who joined in the last 6 months, pooled, as refresh_benchmarks counts them.
    const [own] = await tx.query<
      Record<`left_${CohortHorizon}` | `eligible_${CohortHorizon}`, number>
    >(
      `select coalesce(sum(left_by_30), 0)::int as left_30,
              coalesce(sum(eligible_30), 0)::int as eligible_30,
              coalesce(sum(left_by_60), 0)::int as left_60,
              coalesce(sum(eligible_60), 0)::int as eligible_60,
              coalesce(sum(left_by_90), 0)::int as left_90,
              coalesce(sum(eligible_90), 0)::int as eligible_90
         from stayput.cohort_stats
        where company_id = $1
          and cohort_month >= (date_trunc('month', $2::timestamptz)
                               - make_interval(months => $3))::date`,
      [companyId, now.toISOString(), BENCHMARK_MONTHS],
    );
    // The niche's latest month the reader may see (RLS: 5 communities or more).
    const figures = optedIn
      ? await tx.query<{ metric: string; value: number; computed_at: Date | string }>(
          `select b.metric, b.value::float8 as value, b.computed_at
             from stayput.benchmarks b
            where b.niche = $1
              and b.period_month = (select max(period_month) from stayput.benchmarks
                                     where niche = $1)`,
          [niche],
        )
      : [];
    const valueOf = (days: CohortHorizon) =>
      figures.find((f) => f.metric === `retention_${days}`)?.value ?? null;
    return {
      optedIn,
      niche,
      minimum: BENCHMARK_MINIMUM,
      horizons: COHORT_HORIZONS.map((days) => {
        const eligible = own?.[`eligible_${days}`] ?? 0;
        const left = own?.[`left_${days}`] ?? 0;
        return {
          days,
          mine: eligible >= BENCHMARK_MIN_MEMBERS ? round4(1 - left / eligible) : null,
          niche: valueOf(days),
        };
      }),
      computedAt:
        figures.length > 0
          ? new Date(
              Math.max(...figures.map((f) => new Date(f.computed_at).getTime())),
            ).toISOString()
          : null,
    };
  });
}

/** Sharing on or off (requireCreator checked the team member with Whop). */
export async function saveBenchmarksSetting(
  db: Db,
  companyId: string,
  optedIn: boolean,
): Promise<void> {
  await db.query('select stayput.save_benchmarks_setting($1, $2)', [companyId, optedIn]);
}

/** Every week: the current month's figures of every niche, from the communities sharing. */
export async function refreshBenchmarks(db: Db, now: Date): Promise<number> {
  const [row] = await db.query<{ rows: number }>(
    'select stayput.refresh_benchmarks($1::timestamptz) as rows',
    [now.toISOString()],
  );
  return row?.rows ?? 0;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
