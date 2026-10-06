/**
 * Fake members for the sandbox (SPEC Phase 2, 6). Whop's API cannot create users (DECISIONS.md),
 * so the members are made in StayPut's database, attached to a sandbox company, with 60 days of
 * history and the profiles the next phases are tested on: active, declining, inactive, failed
 * payment, scheduled cancellation, a newcomer who started and one who did nothing yet (the
 * activation radar of Phase 3). They are written as Whop-shaped pages through
 * the same SQL functions as Whop's own data (ingest_page), so they look exactly like it.
 *
 * Every id starts with `seed` (`mber_seed01`, `user_seed01`…): they never collide with Whop's,
 * and `removeSeed` takes them all away.
 */

import type { RiskLevel, RiskReason } from '@stayput/core';
import { createTranslator } from '@stayput/i18n';
import { LEVEL_LABELS, reasonText } from '../../apps/web/src/risk-text';
import { analyzeCompany, scoreCompany } from '../../apps/worker/src/risk';

/** What the seed needs from a database: parameterised SQL in, rows out. */
export interface SeedDb {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export type Profile =
  | 'active'
  | 'declining'
  | 'inactive'
  | 'failed_payment'
  | 'scheduled_cancellation'
  | 'newcomer'
  | 'inactive_newcomer';

/** How many members of each profile (25 in all). */
export const PROFILES: readonly [Profile, number][] = [
  ['active', 8],
  ['declining', 5],
  ['inactive', 4],
  ['failed_payment', 3],
  ['scheduled_cancellation', 3],
  ['newcomer', 1],
  ['inactive_newcomer', 1],
];

const NAMES = [
  'Léa Moreau',
  'Hugo Bernard',
  'Inès Petit',
  'Lucas Robert',
  'Chloé Richard',
  'Nathan Durand',
  'Manon Dubois',
  'Yanis Lefebvre',
  'Camille Laurent',
  'Adam Simon',
  'Sarah Michel',
  'Louis Garcia',
  'Jade Martinez',
  'Gabriel Roux',
  'Emma Fournier',
  'Rayan Girard',
  'Lina Bonnet',
  'Noah Dupont',
  'Zoé Lambert',
  'Arthur Fontaine',
  'Alice Rousseau',
  'Mohamed Vincent',
  'Louise Muller',
  'Jules Leroy',
  'Nora Faure',
];

const DAY = 86_400_000;
const PRICE = 49;
/**
 * What every id of the fake members starts with: `seed` in the sandbox (`mber_seed01`…). Whop's
 * ids are unique across StayPut's database, so another set of fake members takes another tag.
 */
export const SEED_TAG = 'seed';

/** What the fake members of a tag share: their plan and product, chat, course and forum. */
function sharedIds(tag: string) {
  return {
    plan: `plan_${tag}monthly`,
    product: `prod_${tag}community`,
    channel: `chat_${tag}general`,
    course: `cors_${tag}start`,
    forum: `exp_${tag}forum`,
  };
}
export const SEED_PLAN = sharedIds(SEED_TAG).plan;
export const SEED_PRODUCT = sharedIds(SEED_TAG).product;

export interface SeedMember {
  index: number;
  profile: Profile;
  memberId: string;
  userId: string;
  name: string;
  joinedAt: Date;
}

/** The 25 members, the same every time (only the dates follow `now`). */
export function seedMembers(now: Date, tag = SEED_TAG): SeedMember[] {
  const members: SeedMember[] = [];
  for (const [profile, count] of PROFILES) {
    for (let k = 0; k < count; k += 1) {
      const index = members.length + 1;
      const id = `${tag}${String(index).padStart(2, '0')}`;
      const random = generator(index);
      const daysAgo =
        profile === 'newcomer'
          ? 5 + k
          : profile === 'inactive_newcomer'
            ? 4
            : 70 + Math.floor(random() * 200);
      members.push({
        index,
        profile,
        memberId: `mber_${id}`,
        userId: `user_${id}`,
        name: NAMES[index - 1] ?? `Member ${index}`,
        joinedAt: new Date(now.getTime() - daysAgo * DAY - Math.floor(random() * 8) * 3_600_000),
      });
    }
  }
  return members;
}

/** The course of the sandbox: 12 lessons, as a creator would title them. */
const LESSON_TITLES = [
  'Bienvenue et objectifs',
  'Les bases',
  'Construire sa routine',
  "Premier plan d'action",
  'Analyser ses résultats',
  'Éviter les erreurs courantes',
  'Passer au niveau supérieur',
  'Étude de cas',
  'Outils avancés',
  'Automatiser',
  'Mesurer ses progrès',
  'Bilan et suite',
];

function lessonOf(count: number, tag: string): { id: string; title: string } {
  const index = count % LESSON_TITLES.length;
  return { id: `lesn_${tag}${index + 1}`, title: `${index + 1}. ${LESSON_TITLES[index] ?? ''}` };
}

/** Messages a day `daysAgo` days back, on average, for each profile. */
function messageRate(profile: Profile, daysAgo: number): number {
  switch (profile) {
    case 'active':
      return 0.9;
    case 'declining':
      return daysAgo > 30 ? 1.1 : daysAgo > 14 ? 0.35 : 0.05;
    case 'inactive':
      return daysAgo > 21 ? 0.6 : 0;
    case 'failed_payment':
      return 0.5;
    case 'scheduled_cancellation':
      return daysAgo > 20 ? 0.7 : 0.15;
    case 'newcomer':
      return daysAgo === 4 ? 1 : 0;
    case 'inactive_newcomer':
      return 0;
  }
}

/** The pages to ingest, kind by kind, in the order the links need. */
export function seedPages(
  now: Date,
  tag = SEED_TAG,
): { kind: string; scope: string | null; data: unknown[] }[] {
  const members = seedMembers(now, tag);
  const shared = sharedIds(tag);
  const iso = (date: Date) => date.toISOString();
  const pages: { kind: string; scope: string | null; data: unknown[] }[] = [];

  pages.push({
    kind: 'plans',
    scope: null,
    data: [
      {
        id: shared.plan,
        product: { id: shared.product },
        plan_type: 'renewal',
        initial_price: PRICE,
        renewal_price: PRICE,
        currency: 'usd',
        billing_period: 30,
      },
    ],
  });

  pages.push({
    kind: 'members',
    scope: null,
    data: members.map((m) => ({
      id: m.memberId,
      status: 'joined',
      access_level: 'customer',
      joined_at: iso(m.joinedAt),
      created_at: iso(m.joinedAt),
      last_accessed_at: iso(lastSeen(m, now)),
      user: { id: m.userId, name: m.name, username: m.name.split(' ')[0]?.toLowerCase() },
    })),
  });

  const memberships: unknown[] = [];
  const payments: unknown[] = [];
  const owing = members.filter((m) => m.profile === 'failed_payment');
  // An active member whose renewal waits for the bank's 3D Secure check.
  const checking = members.find((m) => m.profile === 'active');
  for (const m of members) {
    // Monthly renewals since joining; the next one is the end of the current period.
    const periods = Math.floor((now.getTime() - m.joinedAt.getTime()) / (30 * DAY));
    const periodEnd = new Date(m.joinedAt.getTime() + (periods + 1) * 30 * DAY);
    const due = owing.includes(m)
      ? declinedPayment(owing.indexOf(m), now)
      : m === checking
        ? waitingPayment(now)
        : null;
    memberships.push({
      id: `mem_${m.memberId.slice(5)}`,
      user_id: m.userId,
      product_id: shared.product,
      plan_id: shared.plan,
      status: due?.substatus === 'failed' ? 'past_due' : 'active',
      cancel_at_period_end: m.profile === 'scheduled_cancellation',
      created_at: iso(m.joinedAt),
      current_period_end: iso(periodEnd),
    });
    for (let p = 0; p <= periods; p += 1) {
      const at = new Date(m.joinedAt.getTime() + p * 30 * DAY);
      payments.push({
        id: `pay_${m.memberId.slice(5)}p${p}`,
        membership_id: `mem_${m.memberId.slice(5)}`,
        member_id: m.memberId,
        created_at: iso(at),
        currency: 'usd',
        total: { amount: PRICE.toFixed(2), currency: 'usd' },
        status: 'paid',
        substatus: 'succeeded',
        paid_at: iso(at),
      });
    }
    if (due) {
      // A new payment at each run, its id naming the hour: Whop never changes when a payment was
      // created, so one already stored would keep its old date, too old for the triggers.
      payments.push({
        id: `${problemPrefix(m)}${Math.floor(now.getTime() / 3_600_000)}`,
        membership_id: `mem_${m.memberId.slice(5)}`,
        member_id: m.memberId,
        currency: 'usd',
        total: { amount: PRICE.toFixed(2), currency: 'usd' },
        ...due,
      });
    }
  }
  pages.push({ kind: 'memberships', scope: null, data: memberships });
  pages.push({ kind: 'payments', scope: null, data: payments });

  for (const m of members) {
    const random = generator(1000 + m.index);
    const messages: unknown[] = [];
    const reactions: unknown[] = [];
    const lessons: unknown[] = [];
    const posts: unknown[] = [];
    // Each member has a favourite hour (their "golden hour"), with some spread around it.
    const hour = 8 + Math.floor(random() * 13);
    const firstDay = Math.min(60, Math.floor((now.getTime() - m.joinedAt.getTime()) / DAY));
    for (let daysAgo = firstDay; daysAgo >= 0; daysAgo -= 1) {
      const rate = messageRate(m.profile, daysAgo);
      const count = Math.floor(rate + random());
      for (let n = 0; n < count; n += 1) {
        const at = moment(now, daysAgo, hour, random);
        if (at > now) continue;
        const id = `${m.memberId.slice(5)}d${daysAgo}n${n}`;
        messages.push({
          id: `msg_${id}`,
          created_at: iso(at),
          message_type: 'regular',
          user: { id: m.userId },
        });
        if (random() < 0.6) {
          reactions.push({
            id: `reac_${id}`,
            created_at: iso(new Date(at.getTime() + 600_000)),
            resource_id: `msg_${id}`,
            user: { id: m.userId },
          });
        }
        if (random() < 0.15) {
          lessons.push({
            id: `crlsi_${id}`,
            completed: true,
            created_at: iso(at),
            lesson: lessonOf(lessons.length, tag),
            user: { id: m.userId },
          });
        }
        if (random() < 0.05) {
          posts.push({
            id: `post_${id}`,
            created_at: iso(at),
            parent_id: null,
            user: { id: m.userId },
          });
        }
      }
    }
    pages.push({ kind: 'messages', scope: shared.channel, data: messages });
    pages.push({ kind: 'reactions', scope: null, data: reactions });
    pages.push({ kind: 'lesson_interactions', scope: shared.course, data: lessons });
    pages.push({ kind: 'forum_posts', scope: shared.forum, data: posts });
  }
  return pages;
}

/** The id of a member's payment problem, but for the hour of the run: `pay_seed18x…`. */
const problemPrefix = (m: SeedMember) => `pay_${m.memberId.slice(5)}x`;

const hoursAgo = (now: Date, hours: number) =>
  new Date(now.getTime() - hours * 3_600_000).toISOString();

/**
 * The declined renewal of a member with a failed payment, recent enough for each trigger of SPEC
 * Phase 4 to show: declined 30 hours ago and left to StayPut (a notice, and a retry 24 hours
 * after the decline), declined 10 hours ago with Whop's own retry planned, and declined 5 hours
 * ago for good (a notice only, both).
 */
function declinedPayment(k: number, now: Date): Record<string, unknown> {
  const declined = {
    status: 'open',
    substatus: 'failed',
    failure_message: 'Your card was declined.',
    paid_at: null,
  };
  switch (k % 3) {
    case 0:
      return {
        ...declined,
        created_at: hoursAgo(now, 30),
        retryable: true,
        next_payment_attempt_at: null,
      };
    case 1:
      return {
        ...declined,
        created_at: hoursAgo(now, 10),
        retryable: true,
        next_payment_attempt_at: new Date(now.getTime() + 2 * DAY).toISOString(),
      };
    default:
      return {
        ...declined,
        created_at: hoursAgo(now, 5),
        retryable: false,
        next_payment_attempt_at: null,
      };
  }
}

/** A renewal waiting 2 hours for the bank's 3D Secure check: the notice with its link. */
function waitingPayment(now: Date): Record<string, unknown> {
  return {
    status: 'open',
    substatus: 'requires_action',
    retryable: false,
    recovery_url: 'https://sandbox.whop.com/',
    created_at: hoursAgo(now, 2),
    paid_at: null,
  };
}

/** When the member was last seen in the community, as Whop would report it. */
function lastSeen(m: SeedMember, now: Date): Date {
  // Opened the community once, right after joining, and never came back.
  if (m.profile === 'inactive_newcomer') return new Date(m.joinedAt.getTime() + 600_000);
  const days =
    m.profile === 'inactive'
      ? 22 + (m.index % 9)
      : m.profile === 'declining'
        ? 6 + (m.index % 5)
        : m.profile === 'newcomer'
          ? 4
          : m.index % 3;
  return new Date(now.getTime() - days * DAY - 3_600_000);
}

function moment(now: Date, daysAgo: number, hour: number, random: () => number): Date {
  const day = new Date(now.getTime() - daysAgo * DAY);
  day.setUTCHours(Math.min(23, Math.max(0, hour + Math.round((random() - 0.5) * 4))));
  day.setUTCMinutes(Math.floor(random() * 60), 0, 0);
  return day;
}

/** A small deterministic random generator (mulberry32): the same members every run. */
function generator(seed: number): () => number {
  let state = seed * 2654435761;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Writes the fake members into `companyId`, then recomputes its statistics. */
export async function runSeed(db: SeedDb, companyId: string, now: Date, tag = SEED_TAG) {
  // The payment problems of an earlier run give way to this run's.
  await db.query(
    `delete from stayput.payments where company_id = $1 and id like $3
        and id <> all (string_to_array($2, ','))`,
    [
      companyId,
      seedMembers(now, tag)
        .map((m) => `${problemPrefix(m)}${Math.floor(now.getTime() / 3_600_000)}`)
        .join(','),
      `pay\\_${tag}%x%`,
    ],
  );
  let items = 0;
  for (const page of seedPages(now, tag)) {
    if (page.data.length === 0) continue;
    await db.query('select stayput.ingest_page($1, $2, $3, $4::text::jsonb)', [
      companyId,
      page.kind,
      page.scope,
      JSON.stringify({ data: page.data, page_info: { end_cursor: null, has_next_page: false } }),
    ]);
    items += page.data.length;
  }
  await db.query('select stayput.refresh_stats($1::timestamptz, $2)', [
    now.toISOString(),
    companyId,
  ]);
  return { members: seedMembers(now, tag).length, items };
}

/**
 * The actions the members' state calls for (SPEC Phase 4), planned at once rather than at the
 * Worker's next hourly run: in manual mode they wait for the creator's approval, in test mode
 * they are only simulated. Returns how many were planned.
 */
export async function planActionsNow(db: SeedDb, companyId: string, now: Date): Promise<number> {
  const [row] = await db.query<{ planned: number }>(
    `select stayput.plan_actions($1, $2::timestamptz)
              + stayput.plan_alumni_followups($1, $2::timestamptz) as planned`,
    [companyId, now.toISOString()],
  );
  return Number(row?.planned ?? 0);
}

/** Takes every fake member away (their activity, statistics, memberships and payments too). */
export async function removeSeed(db: SeedDb, companyId: string, now: Date) {
  const count = async (sql: string) =>
    (
      await db.query<{ n: number }>(
        `with gone as (${sql} returning 1) select count(*)::int as n from gone`,
        [companyId],
      )
    )[0]?.n ?? 0;
  const payments = await count(
    `delete from stayput.payments where company_id = $1 and id like 'pay\\_seed%'`,
  );
  const memberships = await count(
    `delete from stayput.memberships where company_id = $1 and id like 'mem\\_seed%'`,
  );
  const members = await count(
    `delete from stayput.members where company_id = $1 and id like 'mber\\_seed%'`,
  );
  await count(
    `delete from stayput.pending_activity where company_id = $1 and user_id like 'user\\_seed%'`,
  );
  await count(`delete from stayput.plans where company_id = $1 and id like 'plan\\_seed%'`);
  await db.query('select stayput.mark_stats_dirty($1, $2::timestamptz)', [
    companyId,
    new Date(now.getTime() - 90 * DAY).toISOString(),
  ]);
  await db.query('select stayput.refresh_stats($1::timestamptz, $2)', [
    now.toISOString(),
    companyId,
  ]);
  return { members, memberships, payments };
}

const PROFILE_NAMES: Record<Profile, string> = {
  active: 'active',
  declining: 'declining',
  inactive: 'inactive',
  failed_payment: 'failed payment',
  scheduled_cancellation: 'scheduled cancellation',
  newcomer: 'newcomer',
  inactive_newcomer: 'newcomer, inactive',
};

/**
 * Every score and the weekly analyses of the company, computed now with the rules of this code
 * (the Worker only computes what is due: a score after an hour, the analyses after a week).
 * Returns how many members were scored.
 */
export async function rescoreNow(db: SeedDb, companyId: string, now: Date): Promise<number> {
  await db.query(
    `update stayput.member_risk set computed_at = $2::timestamptz - interval '1 hour'
      where company_id = $1`,
    [companyId, now.toISOString()],
  );
  const scored = await scoreCompany(db, companyId, now, 5_000);
  await analyzeCompany(db, companyId, now);
  return scored;
}

/**
 * SPEC Phase 3, « show me the sandbox members sorted by score, with their reasons »: the scores
 * are computed again first, then the fake members come as a Markdown table, the reasons worded
 * in French as the dashboard shows them.
 */
export async function riskReport(db: SeedDb, companyId: string, now: Date): Promise<string[]> {
  const scored = await rescoreNow(db, companyId, now);
  const rows = await db.query<{
    id: string;
    name: string | null;
    score: number;
    level: RiskLevel;
    reasons: RiskReason[] | string;
    inactive_newcomer: boolean;
  }>(
    `select m.id, m.display_name as name, k.score, k.level, k.reasons, k.inactive_newcomer
       from stayput.member_risk k
       join stayput.members m on m.company_id = k.company_id and m.id = k.member_id
      where k.company_id = $1 and m.id like 'mber\\_seed%'
      order by k.score desc, m.display_name`,
    [companyId],
  );
  const fr = createTranslator('fr');
  const profileOf = new Map(seedMembers(now).map((m) => [m.memberId, m.profile]));
  const cell = (text: string) => text.replaceAll('|', '/');
  return [
    `Fake members of ${companyId} by risk score (${scored} scores computed now):`,
    '',
    '| Score | Level | Member | Profile | Reasons |',
    '| ---: | --- | --- | --- | --- |',
    ...rows.map((r) => {
      const reasons = (
        typeof r.reasons === 'string' ? (JSON.parse(r.reasons) as RiskReason[]) : r.reasons
      )
        .map((reason) => reasonText(reason, fr))
        .filter((text): text is string => text !== null);
      if (r.inactive_newcomer) reasons.push(fr.t('risk.newcomer'));
      const profile = profileOf.get(r.id);
      const columns = [
        String(r.score),
        fr.t(LEVEL_LABELS[r.level]),
        cell(r.name ?? r.id),
        profile ? PROFILE_NAMES[profile] : '?',
        cell(reasons.join(' ; ') || '—'),
      ];
      return `| ${columns.join(' | ')} |`;
    }),
  ];
}
