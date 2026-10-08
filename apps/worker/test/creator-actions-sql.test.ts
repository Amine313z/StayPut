import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionMessage, messageValues, prepareActions, renderActionMessage } from '../src/actions';
import { decideCreatorOffer, readRetention, retentionView } from '../src/retention';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * Migration 0027, the creator's own actions from the dashboard: « Message » (approved by the
 * click, through the guardrails), « Pause » and « Offer » (0046: a discount given and announced
 * in the support chat, a pause proposed there and applied by the creator after the member's yes).
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
      id: string;
      type: string;
      status: string;
      trigger: string;
      subject_id: string | null;
      content: Record<string, unknown>;
      approved_by: string | null;
    }>(
      `select id, type, status, trigger, subject_id, content, approved_by from stayput.actions
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

describe('« Pause » and « Offer » in the support chat: no member space (0046)', () => {
  const make = (club: { c: string }, who: string, kind: string, at = NOW) =>
    t.db
      .query<{ made: Record<string, unknown> }>(
        'select stayput.create_creator_offer($1, $2, $3, $4, $5::timestamptz) as made',
        [club.c, who, kind, 'user_Owner', at.toISOString()],
      )
      .then(([row]) => row?.made);
  const apply = (club: { c: string }, offerId: unknown, at = NOW) =>
    t.db
      .query<{ applied: Record<string, unknown> }>(
        'select stayput.apply_creator_offer($1, $2::uuid, $3, $4::timestamptz) as applied',
        [club.c, offerId, 'user_Owner', at.toISOString()],
      )
      .then(([row]) => row?.applied);
  const offer = (id: unknown) =>
    t.db
      .query<{ outcome: string; decided_at: Date | null; action_id: string | null }>(
        'select outcome, decided_at, action_id from stayput.creator_offers where id = $1::uuid',
        [id],
      )
      .then(([row]) => row);

  it('makes the offer in the creator’s numbers, one at a time, and refuses who cannot have one', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const made = await make(club, lea.id, 'pause_offer');
    expect(made).toMatchObject({ kind: 'pause_offer', terms: { days: 30 }, applied: false });
    // Its message goes through the guardrails, about the membership it is for.
    expect(await club.actions(lea.id)).toMatchObject([
      {
        type: 'creator_offer',
        status: 'approved',
        subject_id: lea.membership,
        content: { offerId: made?.offerId, kind: 'pause_offer', terms: { days: 30 }, apply: false },
      },
    ]);
    expect(await make(club, lea.id, 'promo_offer')).toEqual({ error: 'offer_open' });

    const calm = await club.member('Calm', { dnc: true });
    expect(await make(club, calm.id, 'promo_offer')).toEqual({ error: 'do_not_contact' });
    const free = await club.member('Free', { membership: false });
    expect(await make(club, free.id, 'promo_offer')).toEqual({ error: 'no_membership' });
    expect(await make(club, lea.id, 'extend_offer')).toEqual({ error: 'invalid_kind' });
  });

  it('gives a discount at once: accepted when made, applied when its message leaves', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const made = await make(club, lea.id, 'promo_offer');
    expect(made).toMatchObject({
      kind: 'promo_offer',
      terms: { percentOff: 20, months: 3 },
      applied: true,
    });
    const [action] = await club.actions(lea.id);
    expect(action).toMatchObject({
      type: 'creator_offer',
      subject_id: lea.membership,
      content: { kind: 'promo_offer', apply: true },
    });
    // Nothing for the member to accept: given, its message carrying it.
    expect(await offer(made?.offerId)).toMatchObject({
      outcome: 'accepted',
      decided_at: NOW,
      action_id: action?.id,
    });
    // A second discount waits for the week to pass.
    expect(await make(club, lea.id, 'promo_offer')).toEqual({ error: 'offer_open' });
    expect(
      await make(club, lea.id, 'promo_offer', new Date(NOW.getTime() + 8 * DAY)),
    ).toMatchObject({ applied: true });
  });

  it('applies a pause only when the creator says the member answered yes, within the week', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const made = await make(club, lea.id, 'pause_offer');
    expect(await offer(made?.offerId)).toMatchObject({ outcome: 'open', action_id: null });

    const applied = await apply(club, made?.offerId);
    expect(applied).toEqual({ outcome: 'accepted', actionId: expect.any(String) as string });
    // The pause on the membership, kept: the member said yes to staying.
    expect((await club.actions(lea.id)).find((a) => a.type === 'pause_offer')).toMatchObject({
      status: 'approved',
      trigger: 'creator_offer',
      subject_id: lea.membership,
      content: { days: 30, keep: true },
    });
    expect(await offer(made?.offerId)).toMatchObject({
      outcome: 'accepted',
      action_id: applied?.actionId,
    });
    expect(await apply(club, made?.offerId)).toEqual({ error: 'already_decided' });

    // A week later, the proposal is over; another community's offer is not found.
    const noe = await club.member('Noe');
    const late = await make(club, noe.id, 'pause_offer');
    expect(await apply(club, late?.offerId, new Date(NOW.getTime() + 8 * DAY))).toEqual({
      error: 'expired',
    });
    const other = await community();
    expect(await apply(other, late?.offerId)).toEqual({ error: 'not_found' });
  });

  it('still records a member’s own answer to a pause, never in test mode', async () => {
    const club = await community();
    const lea = await club.member('Lea');
    const declined = await make(club, lea.id, 'pause_offer');
    const row = await readRetention(t.db, club.c, lea.user, NOW);
    expect(
      await decideCreatorOffer(t.db, club.c, lea.user, row, String(declined?.offerId), false, NOW),
    ).toEqual({ actionId: null });
    expect((await club.actions(lea.id)).some((a) => a.type === 'pause_offer')).toBe(false);

    const quiet = await community({ dryRun: true });
    const zoe = await quiet.member('Zoe');
    await make(quiet, zoe.id, 'pause_offer');
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
    // Proposed: the member answers in the chat.
    expect(renderActionMessage('creator_offer', 'fr', {}, values)).toEqual({
      title: 'Quelque chose pour toi de Le Club',
      body: 'Salut Léa, une pause de 30 jours t’aiderait ? Ton abonnement t’attendrait. Réponds à ce message cette semaine et on la met en place.',
    });
    const english = messageValues(
      'creator_offer',
      'en',
      {},
      { kind: 'promo_offer', terms: { percentOff: 20, months: 3 } },
    );
    // Given: already on the membership when the member reads it.
    expect(renderActionMessage('creator_offer', 'en', {}, english).body).toBe(
      'Hi, here is 20% off for 3 months, already applied to your next payments: nothing to do.',
    );
    expect(typeof actionMessage).toBe('function');
  });
});
