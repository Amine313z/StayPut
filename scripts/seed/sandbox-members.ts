/**
 * Fake members for the sandbox (SPEC Phase 2, 6). Whop's API cannot create users (DECISIONS.md),
 * so the members are made in StayPut's database, attached to a sandbox company, with 60 days of
 * history and the profiles the next phases are tested on: active, declining, inactive, failed
 * payment, scheduled cancellation, and newcomers. They are written as Whop-shaped pages through
 * the same SQL functions as Whop's own data (ingest_page), so they look exactly like it.
 *
 * Every id starts with `seed` (`mber_seed01`, `user_seed01`…): they never collide with Whop's,
 * and `removeSeed` takes them all away.
 */

/** What the seed needs from a database: parameterised SQL in, rows out. */
export interface SeedDb {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

export type Profile =
  'active' | 'declining' | 'inactive' | 'failed_payment' | 'scheduled_cancellation' | 'newcomer';

/** How many members of each profile (25 in all). */
export const PROFILES: readonly [Profile, number][] = [
  ['active', 8],
  ['declining', 5],
  ['inactive', 4],
  ['failed_payment', 3],
  ['scheduled_cancellation', 3],
  ['newcomer', 2],
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
export const SEED_PLAN = 'plan_seedmonthly';
export const SEED_PRODUCT = 'prod_seedcommunity';
const CHANNEL = 'chat_seedgeneral';
const COURSE = 'cors_seedstart';
const FORUM = 'exp_seedforum';

export interface SeedMember {
  index: number;
  profile: Profile;
  memberId: string;
  userId: string;
  name: string;
  joinedAt: Date;
}

/** The 25 members, the same every time (only the dates follow `now`). */
export function seedMembers(now: Date): SeedMember[] {
  const members: SeedMember[] = [];
  for (const [profile, count] of PROFILES) {
    for (let k = 0; k < count; k += 1) {
      const index = members.length + 1;
      const tag = `seed${String(index).padStart(2, '0')}`;
      const random = generator(index);
      const daysAgo = profile === 'newcomer' ? 5 + k : 70 + Math.floor(random() * 200);
      members.push({
        index,
        profile,
        memberId: `mber_${tag}`,
        userId: `user_${tag}`,
        name: NAMES[index - 1] ?? `Member ${index}`,
        joinedAt: new Date(now.getTime() - daysAgo * DAY - Math.floor(random() * 8) * 3_600_000),
      });
    }
  }
  return members;
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
  }
}

/** The pages to ingest, kind by kind, in the order the links need. */
export function seedPages(now: Date): { kind: string; scope: string | null; data: unknown[] }[] {
  const members = seedMembers(now);
  const iso = (date: Date) => date.toISOString();
  const pages: { kind: string; scope: string | null; data: unknown[] }[] = [];

  pages.push({
    kind: 'plans',
    scope: null,
    data: [
      {
        id: SEED_PLAN,
        product: { id: SEED_PRODUCT },
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
  for (const m of members) {
    // Monthly renewals since joining; the next one is the end of the current period.
    const periods = Math.floor((now.getTime() - m.joinedAt.getTime()) / (30 * DAY));
    const periodEnd = new Date(m.joinedAt.getTime() + (periods + 1) * 30 * DAY);
    const failed = m.profile === 'failed_payment';
    memberships.push({
      id: `mem_${m.memberId.slice(5)}`,
      user_id: m.userId,
      product_id: SEED_PRODUCT,
      plan_id: SEED_PLAN,
      status: failed ? 'past_due' : 'active',
      cancel_at_period_end: m.profile === 'scheduled_cancellation',
      created_at: iso(m.joinedAt),
      current_period_end: iso(periodEnd),
    });
    for (let p = 0; p <= periods; p += 1) {
      const at = new Date(m.joinedAt.getTime() + p * 30 * DAY);
      const last = p === periods;
      payments.push({
        id: `pay_${m.memberId.slice(5)}p${p}`,
        membership_id: `mem_${m.memberId.slice(5)}`,
        member_id: m.memberId,
        created_at: iso(at),
        currency: 'usd',
        total: { amount: PRICE.toFixed(2), currency: 'usd' },
        ...(last && failed
          ? {
              status: 'open',
              substatus: 'failed',
              failure_message: 'Your card was declined.',
              retryable: true,
              next_payment_attempt_at: iso(new Date(now.getTime() + 2 * DAY)),
              paid_at: null,
            }
          : { status: 'paid', substatus: 'succeeded', paid_at: iso(at) }),
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
            lesson: { id: `lesn_seed${(lessons.length % 12) + 1}`, title: null },
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
    pages.push({ kind: 'messages', scope: CHANNEL, data: messages });
    pages.push({ kind: 'reactions', scope: null, data: reactions });
    pages.push({ kind: 'lesson_interactions', scope: COURSE, data: lessons });
    pages.push({ kind: 'forum_posts', scope: FORUM, data: posts });
  }
  return pages;
}

/** When the member was last seen in the community, as Whop would report it. */
function lastSeen(m: SeedMember, now: Date): Date {
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
export async function runSeed(db: SeedDb, companyId: string, now: Date) {
  let items = 0;
  for (const page of seedPages(now)) {
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
  return { members: seedMembers(now).length, items };
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
