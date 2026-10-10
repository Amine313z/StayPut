import {
  alumniReturnRate,
  type AlumniProblem,
  type AlumniReturn,
  type AlumniStep,
  type AlumniView,
} from '@stayput/core';
import { WHOP_CHECKOUT_BASE_URL, WhopApiError, type WhopClient, type WhopEnv } from '@stayput/whop';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * The Alumni offer (SPEC 5.9): a former member stays in touch for free, in a hidden product whose
 * free hidden variant they enter by its link (Whop's invitation answers 403 to this account:
 * docs/whop-api-verification.md, section 8). No StayPut experience in it (2026-10-10): members
 * have no StayPut space, and the follow-ups go in the support chat like every message. StayPut
 * creates it for the creator, step by step; each step has its own idempotency key, and what is
 * done is kept, so trying again finishes the rest. An offer made before keeps its experience.
 */

/** The permission each step needs (docs/whop-api-verification.md, section 10). */
const PERMISSIONS: Readonly<Record<AlumniStep, string>> = {
  product: 'access_pass:create',
  variant: 'plan:create',
};

/** What the product says on Whop's checkout page, in the members' language. */
const DESCRIPTIONS = {
  fr: 'Restez en contact gratuitement : les actualités de la communauté et des offres de retour.',
  en: 'Stay in touch for free: the community’s news and comeback offers.',
} as const;

interface OfferRow {
  name: string;
  product_id: string | null;
  plan_id: string | null;
  url: string | null;
  experience_id: string | null;
  completed_at: Date | string | null;
}

/** `alumni_view` (0039): the offer, the counts, and the money by currency, the largest first. */
interface AlumniViewRow {
  offer: {
    name: string;
    url: string | null;
    createdAt: string;
    completedAt: string | null;
  } | null;
  entered: number | string;
  left: number | string;
  returned: number | string;
  recovered: { currency: string; amount: number | string }[];
}

export async function readAlumni(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<AlumniView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: AlumniViewRow | null }>('select stayput.alumni_view($1) as view', [companyId]),
  );
  const view = row?.view;
  if (!view) return null;
  const counts = {
    entered: Number(view.entered),
    left: Number(view.left),
    returned: Number(view.returned),
  };
  // The money by currency, the largest first: the main one is shown, the others flagged.
  const [main, ...others] = view.recovered;
  return {
    offer: view.offer
      ? {
          name: view.offer.name,
          url: view.offer.url,
          createdAt: new Date(view.offer.createdAt).toISOString(),
          completedAt: view.offer.completedAt
            ? new Date(view.offer.completedAt).toISOString()
            : null,
        }
      : null,
    ...counts,
    returnRate: alumniReturnRate(counts),
    recovered: main
      ? {
          amount: Math.round(Number(main.amount) * 100) / 100,
          currency: main.currency,
          otherCurrencies: others.length > 0,
        }
      : null,
  };
}

/**
 * Creates the company's Alumni offer on Whop, or finishes creating it: a hidden product and its
 * free hidden variant (one-time, price 0), whose link is the way in. Returns the step that
 * stopped, with the permission Whop lacked; null once the offer is ready.
 */
export async function createAlumniOffer(
  db: Db,
  whop: WhopClient,
  input: { companyId: string; userId: string; name: string },
  now: Date,
): Promise<AlumniProblem | null> {
  const { companyId } = input;
  const [existing] = await db.query<OfferRow>(
    `select name, product_id, plan_id, url, experience_id, completed_at
       from stayput.alumni_offers where company_id = $1`,
    [companyId],
  );
  let offer: OfferRow | undefined = existing;
  const name = offer?.name ?? input.name;
  const save = async (step: Record<string, unknown>) => {
    [offer] = await db.query<OfferRow>(
      `select name, product_id, plan_id, url, experience_id, completed_at
         from stayput.save_alumni_offer($1, $2, $3, $4::text::jsonb, $5::timestamptz)`,
      [companyId, name, input.userId, JSON.stringify(step), now.toISOString()],
    );
  };
  const key = (step: AlumniStep) => `stayput-alumni-${companyId}-${step}`;
  const [company] = await db.query<{ locale: string }>(
    'select locale from stayput.companies where id = $1',
    [companyId],
  );
  const description = DESCRIPTIONS[company?.locale === 'fr' ? 'fr' : 'en'];

  let step: AlumniStep = 'product';
  try {
    if (!offer?.product_id) {
      const product = await whop.request<{ id?: unknown }>('POST', '/products', {
        body: { account_id: companyId, title: name, description, visibility: 'hidden' },
        idempotencyKey: key(step),
      });
      await save({ productId: idOf(product.id, 'prod_') });
    }
    step = 'variant';
    if (!offer?.plan_id) {
      const variant = await whop.request<{ id?: unknown; purchase_url?: unknown }>(
        'POST',
        '/variants',
        {
          body: {
            account_id: companyId,
            product_id: offer?.product_id,
            title: name,
            plan_type: 'one_time',
            initial_price: 0,
            visibility: 'hidden',
          },
          idempotencyKey: key(step),
        },
      );
      const url = typeof variant.purchase_url === 'string' ? variant.purchase_url : '';
      if (!url.startsWith('https://')) throw new Error('Whop gave the variant no link');
      await save({ planId: idOf(variant.id, 'plan_'), url });
    }
    // Ready once its link exists (an offer stopped before at the experience of the old flow
    // included).
    if (!offer?.completed_at) await save({ completed: true });
    return null;
  } catch (error) {
    console.error(`Alumni offer of ${companyId}, step ${step}:`, describe(error));
    return {
      step,
      permission: error instanceof WhopApiError && error.status === 403 ? PERMISSIONS[step] : null,
    };
  }
}

/** What stayput.member_alumni returns. */
interface MemberAlumniRow {
  code: string | null;
  expiresAt: string | null;
  percentOff: number | null;
  months: number | null;
  planId: string | null;
}

/**
 * The Alumni as the member view needs it, in one query: the offer's link once it is ready (shown
 * to a member who leaves), and for a former member in the Alumni, their return code and the
 * checkout of the plan they left.
 */
export async function alumniOfMember(
  db: Db,
  companyId: string,
  userId: string,
  now: Date,
  env: WhopEnv,
): Promise<{ url: string | null; alumni: AlumniReturn | null }> {
  const [row] = await db.query<{ url: string | null; alumni: MemberAlumniRow | null }>(
    `select (select o.url from stayput.alumni_offers o
              where o.company_id = $1 and o.completed_at is not null) as url,
            stayput.member_alumni($1, $2, $3::timestamptz) as alumni`,
    [companyId, userId, now.toISOString()],
  );
  const alumni = row?.alumni;
  return {
    url: row?.url ?? null,
    alumni: alumni
      ? {
          code:
            alumni.code && alumni.expiresAt
              ? {
                  code: alumni.code,
                  percentOff: Number(alumni.percentOff),
                  months: Number(alumni.months),
                  expiresAt: new Date(alumni.expiresAt).toISOString(),
                }
              : null,
          returnUrl: alumni.planId ? `${WHOP_CHECKOUT_BASE_URL[env]}${alumni.planId}` : null,
        }
      : null,
  };
}

function idOf(value: unknown, prefix: string): string {
  if (
    typeof value === 'string' &&
    value.startsWith(prefix) &&
    /^[a-z]+_[A-Za-z0-9]+$/.test(value)
  ) {
    return value;
  }
  throw new Error(`Whop gave no ${prefix}… id`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
