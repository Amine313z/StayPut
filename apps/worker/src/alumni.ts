import type { AlumniProblem, AlumniStep, AlumniView } from '@stayput/core';
import { WhopApiError, type WhopClient } from '@stayput/whop';
import { withUser, type Db, type TransactionalDb } from './db';

/**
 * The Alumni offer (SPEC 5.9): a former member stays in touch for free, in a hidden product whose
 * free hidden variant they enter by its link (Whop's invitation answers 403 to this account:
 * docs/whop-api-verification.md, section 8), with a StayPut experience through which the
 * follow-ups go. StayPut creates it for the creator, step by step; each step has its own
 * idempotency key, and what is done is kept, so trying again finishes the rest.
 */

/** The permission each step needs (docs/whop-api-verification.md, section 10). */
const PERMISSIONS: Readonly<Record<AlumniStep, string>> = {
  product: 'access_pass:create',
  variant: 'plan:create',
  experience: 'experience:create',
  attach: 'experience:attach',
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

export async function readAlumni(
  db: TransactionalDb,
  userId: string,
  companyId: string,
): Promise<AlumniView | null> {
  const [row] = await withUser(db, userId, (tx) =>
    tx.query<{ view: AlumniView | null }>('select stayput.alumni_view($1) as view', [companyId]),
  );
  const view = row?.view;
  if (!view) return null;
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
    entered: Number(view.entered),
    left: Number(view.left),
    returned: Number(view.returned),
  };
}

/**
 * Creates the company's Alumni offer on Whop, or finishes creating it: a hidden product, its free
 * hidden variant (one-time, price 0), a StayPut experience, attached to the product. Returns the
 * step that stopped, with the permission Whop lacked; null once the offer is ready.
 */
export async function createAlumniOffer(
  db: Db,
  whop: WhopClient,
  input: { companyId: string; userId: string; appId: string; name: string },
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
    step = 'experience';
    if (!offer?.experience_id) {
      const experience = await whop.request<{ id?: unknown }>('POST', '/experiences', {
        body: { account_id: companyId, app_id: input.appId, name },
        idempotencyKey: key(step),
      });
      await save({ experienceId: idOf(experience.id, 'exp_') });
    }
    step = 'attach';
    if (!offer?.completed_at) {
      await whop.request(
        'POST',
        `/experiences/${encodeURIComponent(offer?.experience_id ?? '')}/attach`,
        { body: { product_id: offer?.product_id }, idempotencyKey: key(step) },
      );
      await save({ completed: true });
    }
    return null;
  } catch (error) {
    console.error(`Alumni offer of ${companyId}, step ${step}:`, describe(error));
    return {
      step,
      permission: error instanceof WhopApiError && error.status === 403 ? PERMISSIONS[step] : null,
    };
  }
}

/** The Alumni offer's link, once the offer is ready: shown to a member who leaves. */
export async function alumniUrl(db: Db, companyId: string): Promise<string | null> {
  const [row] = await db.query<{ url: string | null }>(
    `select url from stayput.alumni_offers where company_id = $1 and completed_at is not null`,
    [companyId],
  );
  return row?.url ?? null;
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
