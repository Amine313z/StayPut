import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionMessage, messageValues, prepareActions, renderActionMessage } from '../src/actions';
import { decideCreatorOffer, readRetention, retentionView } from '../src/retention';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0027, the creator's own actions from the dashboard: « Message » (approved by the
 * click, through the guardrails), « Pause » and « Offer » (accepted by the member in their
 * space, the only way their membership is touched).
 */

const NOW = new Date('2026-10-15T08:00:00Z');
const DAY = 86_400_000;
const days = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

let n = 0;

async function community(options: { dryRun?: boolean } = {}) {
  n += 1;
  const c = `biz_Act${n}`;
  await t.db.query(
    `insert into stayput.companies (id, name, timezone, locale, mode)
     values ($1, 'Le Club', 'Europe/Paris', 'fr', 'manual')`,
    [c],
  );
  await t.db.query(`insert into stayput.company_settings (company_id, dry_run) values ($1, $2)`, [
    c,
    !!options.dryRun,
  ]);
  const member = async (
    name: string,
    over: { status?: string; admin?: boolean; dnc?: boolean; membership?: boolean } = {},
  ) => {
    const id = `mber_${name}${n}`;
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, display_name, joined_at, status,
                                    access_level, do_not_contact)
       values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)`,
      [
        id,
        c,
        `user_${name}${n}`,
        name,
        days(-60),
        over.status ?? 'joined',
        over.admin ? 'admin' : null,
        !!over.dnc,
      ],
    );
    if (over.membership !== false) {
      await t.db.query(
        `insert into stayput.memberships (id, company_id, member_id, user_id, product_id, plan_id,
                                          price, currency, billing_period_days, status,
                                          current_period_end)
         values ($1, $2, $3, $4, 'prod_Club', 'plan_Month', 49, 'eur', 30, 'active',
                 $5::timestamptz)`,
        [`mem_${name}${n}`, c, id, `user_${name}${n}`, days(20)],
      );
    }
    return { id, user: `user_${name}${n}`, membership: `mem_${name}${n}` };
  };
  const actions = (memberId: string) =>
    t.db.query<{
      type: string;
      status: string;
      trigger: string;
      subject_id: string | null;
      content: Record<string, unknown>;
      approved_by: string | null;
    }>(
      `select type, status, trigger, subject_id, content, approved_by from stayput.actions
        where company_id = $1 and member_id = $2 order by created_at, type`,
      [c, memberId],
    );
  return { c, member, actions };
}

describe('« Message »: the creator’s word, approved by the click', () => {
  it('reaches members only, once a day, never the team or the « never contact » list', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const owner = await club.member('Owner', { admin: true });
    const calm = await club.member('Calm', { dnc: true });
    const gone = await club.member('Gone', { status: 'left' });
    const send = () =>
      t.db.query<{ queued: number }>(
        'select stayput.creator_messages($1, $2, $3, $4::timestamptz) as queued',
        [club.c, [lea.id, owner.id, calm.id, gone.id].join(','), 'user_Owner1', NOW.toISOString()],
      );
    expect((await send())[0]?.queued).toBe(1);
    expect(await club.actions(lea.id)).toMatchObject([
      {
        type: 'creator_message',
        status: 'approved',
        trigger: 'creator',
        approved_by: 'user_Owner1',
      },
    ]);
    // A second click the same day changes nothing.
    expect((await send())[0]?.queued).toBe(0);
  });

  it('goes through the guardrails: a member reached in the last 5 days waits', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    await t.db.query(
      `insert into stayput.actions (company_id, member_id, type, status, trigger, message_kind,
                                    send_at, sent_at)
       values ($1, $2, 'welcome_message', 'sent', 'activation_radar', 'relance',
               $3::timestamptz, $3::timestamptz)`,
      [club.c, lea.id, days(-2)],
    );
    await t.db.query('select stayput.creator_messages($1, $2, $3, $4::timestamptz)', [
      club.c,
      lea.id,
      'user_Owner',
      NOW.toISOString(),
    ]);
    const prepared = await prepareActions(t.db, club.c, NOW);
    expect(prepared.blocked).toBe(1);
    const rows = await club.actions(lea.id);
    expect(rows.find((a) => a.type === 'creator_message')?.status).toBe('blocked_by_guardrail');
  });
});

describe('« Pause » and « Offer »: the member accepts in their space', () => {
  it('makes the offer in the creator’s numbers, one open at a time, and tells the member', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const make = (kind: string, who = lea.id) =>
      t.db.query<{ made: Record<string, unknown> }>(
        'select stayput.create_creator_offer($1, $2, $3, $4, $5::timestamptz) as made',
        [club.c, who, kind, 'user_Owner', NOW.toISOString()],
      );
    const [made] = await make('pause_offer');
    expect(made?.made).toMatchObject({ kind: 'pause_offer', terms: { days: 30 } });
    expect(await club.actions(lea.id)).toMatchObject([
      {
        type: 'creator_offer',
        status: 'approved',
        subject_id: made?.made.offerId,
        content: { kind: 'pause_offer', terms: { days: 30 } },
      },
    ]);
    expect((await make('promo_offer'))[0]?.made).toEqual({ error: 'offer_open' });

    const calm = await club.member('Calm', { dnc: true });
    expect((await make('promo_offer', calm.id))[0]?.made).toEqual({ error: 'do_not_contact' });
    const free = await club.member('Free', { membership: false });
    expect((await make('promo_offer', free.id))[0]?.made).toEqual({ error: 'no_membership' });
    expect((await make('extend_offer'))[0]?.made).toEqual({ error: 'invalid_kind' });
  });

  it('applies a pause only once the member accepts it, keeping their membership', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const [made] = await t.db.query<{ made: { offerId: string } }>(
      'select stayput.create_creator_offer($1, $2, $3, $4, $5::timestamptz) as made',
      [club.c, lea.id, 'pause_offer', 'user_Owner', NOW.toISOString()],
    );
    const offerId = made!.made.offerId;
    const row = await readRetention(t.db, club.c, lea.user, NOW);
    const view = retentionView(row, { preview: false, whopAppId: null });
    expect(view.creatorOffer).toEqual({
      id: offerId,
      kind: 'pause_offer',
      terms: { days: 30 },
      expiresAt: days(7),
      outcome: 'open',
      result: null,
    });
    // Another member cannot answer it.
    const max = await club.member('Max');
    const theirs = await readRetention(t.db, club.c, max.user, NOW);
    expect(await decideCreatorOffer(t.db, club.c, max.user, theirs, offerId, true, NOW)).toBeNull();

    const decided = await decideCreatorOffer(t.db, club.c, lea.user, row, offerId, true, NOW);
    expect(decided?.actionId).toMatch(/^[0-9a-f-]{36}$/);
    const applied = (await club.actions(lea.id)).find((a) => a.type === 'pause_offer');
    expect(applied).toMatchObject({
      status: 'approved',
      trigger: 'creator_offer',
      subject_id: lea.membership,
      content: { days: 30, keep: true },
    });
    const after = retentionView(await readRetention(t.db, club.c, lea.user, NOW), {
      preview: false,
      whopAppId: null,
    });
    expect(after.creatorOffer).toMatchObject({
      outcome: 'accepted',
      result: { status: 'waiting' },
    });
  });

  it('puts an accepted discount on a membership that continues (0034)', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const [made] = await t.db.query<{ made: { offerId: string } }>(
      'select stayput.create_creator_offer($1, $2, $3, $4, $5::timestamptz) as made',
      [club.c, lea.id, 'promo_offer', 'user_Owner', NOW.toISOString()],
    );
    const row = await readRetention(t.db, club.c, lea.user, NOW);
    const decided = await decideCreatorOffer(
      t.db,
      club.c,
      lea.user,
      row,
      made!.made.offerId,
      true,
      NOW,
    );
    expect(decided?.actionId).toMatch(/^[0-9a-f-]{36}$/);
    // Accepting a discount on the membership is staying, as accepting a pause: the Worker
    // withdraws a cancellation if one is scheduled, after the discount is on.
    expect((await club.actions(lea.id)).find((a) => a.type === 'promo_offer')).toMatchObject({
      status: 'approved',
      trigger: 'creator_offer',
      content: { percentOff: 20, months: 3, keep: true },
    });
  });

  it('records a refusal, and nothing once the week has passed or in test mode', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const make = async (who: string) => {
      const [made] = await t.db.query<{ made: { offerId: string } }>(
        'select stayput.create_creator_offer($1, $2, $3, $4, $5::timestamptz) as made',
        [club.c, who, 'promo_offer', 'user_Owner', NOW.toISOString()],
      );
      return made!.made.offerId;
    };
    const declined = await make(lea.id);
    const row = await readRetention(t.db, club.c, lea.user, NOW);
    expect(await decideCreatorOffer(t.db, club.c, lea.user, row, declined, false, NOW)).toEqual({
      actionId: null,
    });
    expect((await club.actions(lea.id)).some((a) => a.type === 'promo_offer')).toBe(false);

    const noe = await club.member('Noe');
    const late = await make(noe.id);
    const eightDays = new Date(NOW.getTime() + 8 * DAY);
    const old = await readRetention(t.db, club.c, noe.user, eightDays);
    expect(await decideCreatorOffer(t.db, club.c, noe.user, old, late, true, eightDays)).toBeNull();

    const quiet = await community({ dryRun: true });
    const zoe = await quiet.member('Zoe');
    await t.db.query('select stayput.create_creator_offer($1, $2, $3, $4, $5::timestamptz)', [
      quiet.c,
      zoe.id,
      'pause_offer',
      'user_Owner',
      NOW.toISOString(),
    ]);
    // In test mode nothing reaches members: an offer they could accept would promise nothing.
    const hidden = retentionView(await readRetention(t.db, quiet.c, zoe.user, NOW), {
      preview: false,
      whopAppId: null,
    });
    expect(hidden.creatorOffer).toBeNull();
  });

  it('tells the member the offer in their language', () => {
    const values = messageValues(
      'creator_offer',
      'fr',
      { first_name: 'Léa', creator_name: 'Le Club' },
      { kind: 'pause_offer', terms: { days: 30 } },
    );
    expect(renderActionMessage('creator_offer', 'fr', {}, values)).toEqual({
      title: 'Quelque chose pour toi de Le Club',
      body: 'Salut Léa, voici une pause de 30 jours : ton abonnement t’attend. Ouvre ton espace pour l’accepter : l’offre reste valable 7 jours.',
    });
    const english = messageValues(
      'creator_offer',
      'en',
      {},
      { kind: 'promo_offer', terms: { percentOff: 20, months: 3 } },
    );
    expect(renderActionMessage('creator_offer', 'en', {}, english).body).toBe(
      'Hi, here is 20% off for 3 months. Open your space to accept it: the offer stays open 7 days.',
    );
    expect(typeof actionMessage).toBe('function');
  });
});
