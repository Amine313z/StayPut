/**
 * The money loop, end to end, on fake members (the functional tests after the security audit):
 * a community in automatic mode with 25 fake members (sandbox-members.ts, its own ids), and the
 * Worker's own hourly jobs (cron.ts, SCHEDULE) run hour after hour against a Whop that only keeps
 * what it is asked. StayPut must score every member, write to those whose payment failed, retry
 * the payment it may retry, send the departure survey, hold each check-in for its member's hour,
 * leave the « never contact » list alone; then Whop answers (payments paid, an offer accepted
 * and the cancellation withdrawn), and the money must be counted once, on the dashboard and in
 * the Monday report.
 *
 * apps/worker/test/scenarios.test.ts runs it on an in-memory database; `seed-sandbox.ts
 * scenarios` on the sandbox's own database, inside one transaction rolled back at the end:
 * nothing stays, and nothing reaches Whop.
 */
import { DEFAULT_GUARDRAILS } from '@stayput/core';
import type { WhopClient } from '@stayput/whop';
import { executeAction, prepareActions } from '../../apps/worker/src/actions';
import { SCHEDULE, runScheduled } from '../../apps/worker/src/cron';
import { readDashboard } from '../../apps/worker/src/dashboard';
import type { ClosableDb, TransactionalDb } from '../../apps/worker/src/db';
import { readConfig } from '../../apps/worker/src/env';
import { answerSurvey, decideOffer, readRetention } from '../../apps/worker/src/retention';
import { runSeed, seedMembers, type Profile } from './sandbox-members';

/** The community of the scenarios, and its fake members' tag: never the sandbox's own. */
export const SCENARIO_COMPANY = 'biz_ScenarioRun1';
export const SCENARIO_TAG = 'scen';
const OWNER = 'user_ScenarioOwner';
const ZONE = 'Europe/Paris';
const HOUR = 3_600_000;

export interface Verdict {
  check: string;
  ok: boolean;
  seen: string;
}

export interface WhopCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/** Whop as StayPut calls it: every call kept and answered, nothing sent anywhere. */
export function recordingWhop(): { whop: WhopClient; calls: WhopCall[] } {
  const calls: WhopCall[] = [];
  const answer = (method: string, path: string, body: Record<string, unknown>): unknown => {
    // The support chat with a member: Whop opens it (or gives the one there is).
    if (method === 'POST' && path === '/support_channels') {
      return { id: `supp_${String(body.user_id)}` };
    }
    if (path === '/permissions') {
      return { data: [{ action: 'company:basic:read', granted: true }] };
    }
    if (method === 'POST' && path === '/promo_codes')
      return { id: `promo_Scenario${calls.length}` };
    const membership = /^\/memberships\/(mem_[A-Za-z0-9]+)$/.exec(path)?.[1];
    if (method === 'GET' && membership) {
      return { id: membership, manage_url: 'https://whop.com/' };
    }
    return {};
  };
  const whop = {
    env: 'sandbox',
    request(method: string, path: string, options?: { body?: unknown }) {
      const body = (options?.body ?? {}) as Record<string, unknown>;
      calls.push({ method, path, body });
      return Promise.resolve(answer(method, path, body));
    },
  } as unknown as WhopClient;
  return { whop, calls };
}

const localParts = (time: number) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE,
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(time))
      .map((part) => [part.type, part.value]),
  );

/** The last 11:00 in Paris at or before `now`: the loop starts outside the quiet hours. */
export function scenarioStart(now: Date): Date {
  const hour = Number(localParts(now.getTime()).hour);
  return new Date(Math.floor(now.getTime() / HOUR) * HOUR - ((hour - 11 + 24) % 24) * HOUR);
}

/** The first Monday, 9:00 in Paris, after `after`: when the Monday report goes. */
function nextMondayMorning(after: Date): Date {
  let time = Math.ceil(after.getTime() / HOUR) * HOUR;
  for (let i = 0; i < 9 * 24; i += 1, time += HOUR) {
    const parts = localParts(time);
    if (parts.weekday === 'Mon' && parts.hour === '09') return new Date(time);
  }
  throw new Error('no Monday in nine days');
}

interface ActionRow {
  id: string;
  member_id: string;
  type: string;
  status: string;
  message_kind: string;
}

export async function runScenarios(db: TransactionalDb, now: Date): Promise<Verdict[]> {
  const C = SCENARIO_COMPANY;
  const verdicts: Verdict[] = [];
  const check = (name: string, ok: boolean, seen: string) =>
    verdicts.push({ check: name, ok, seen });
  const t0 = scenarioStart(now);
  const at = (hours: number) => new Date(t0.getTime() + hours * HOUR);
  const iso = (date: Date) => date.toISOString();
  const { whop, calls } = recordingWhop();
  const config = readConfig({
    WHOP_ENV: 'sandbox',
    WHOP_APP_ID: 'app_ScenarioRun1',
    WHOP_API_KEY: 'scenario',
  });
  const closable: ClosableDb = {
    query: (text, params) => db.query(text, params),
    transaction: (work) => db.transaction(work),
    close: () => Promise.resolve(),
  };
  const hourly = (when: Date) =>
    runScheduled('hourly', SCHEDULE, { config, db: closable, whop, syncWhop: whop, now: when });
  const actionsOf = () =>
    db.query<ActionRow>(
      `select id::text, member_id, type, status, message_kind from stayput.actions
        where company_id = $1`,
      [C],
    );
  /** A delivery from Whop, stored then filed as the webhook route does. */
  const deliver = async (id: string, type: string, data: Record<string, unknown>, when: Date) => {
    await db.query(
      `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
       values ($1, $2, $3, $4::text::jsonb, $5::timestamptz)`,
      [id, C, type, JSON.stringify({ type, company_id: C, data }), iso(when)],
    );
    const [row] = await db.query<{ status: string }>(
      'select stayput.process_webhook_event($1, $2::timestamptz) as status',
      [id, iso(when)],
    );
    return row?.status ?? 'missing';
  };

  // 1. A community in automatic mode, test mode off, and its 25 fake members.
  await db.query('select stayput.ensure_company($1, $2::timestamptz)', [C, iso(t0)]);
  await db.query(
    `update stayput.companies set name = 'Scenario Club', timezone = $2, locale = 'en',
            mode = 'auto', experience_id = 'exp_ScenarioRun1'
      where id = $1`,
    [C, ZONE],
  );
  await db.query(
    `insert into stayput.company_settings (company_id, dry_run) values ($1, false)
     on conflict (company_id) do update set dry_run = false`,
    [C],
  );
  // RLS checks the team's access against the database's own clock (is_company_admin).
  await db.query(
    `insert into stayput.company_admins (company_id, user_id, verified_at) values ($1, $2, now())
     on conflict (company_id, user_id) do update set verified_at = now()`,
    [C, OWNER],
  );
  await runSeed(db, C, t0, SCENARIO_TAG);
  const members = seedMembers(t0, SCENARIO_TAG);
  const ofProfile = (profile: Profile) => members.filter((m) => m.profile === profile);
  const owing = ofProfile('failed_payment');
  const leaving = ofProfile('scheduled_cancellation');
  const [quiet, ...inactive] = ofProfile('inactive');
  const [checking] = ofProfile('active');
  const [idle] = ofProfile('inactive_newcomer');
  if (!quiet || !checking || !idle || owing.length < 2 || leaving.length < 1) {
    throw new Error('the fake members are not the expected ones');
  }
  await db.query('select stayput.set_do_not_contact($1, $2, true)', [C, quiet.memberId]);

  // 2. The first hour: scores, then the actions, sent through Whop.
  const first = await hourly(t0);
  check(
    'Every hourly job ran (risk, actions, saves, Monday report, upkeep)',
    first.failed.length === 0,
    `${first.ran.length} ran, ${first.failed.length} failed`,
  );
  const [scored] = await db.query<{ n: number }>(
    'select count(*)::int as n from stayput.member_risk where company_id = $1',
    [C],
  );
  check(
    'Every fake member scored',
    scored?.n === members.length,
    `${scored?.n ?? 0}/${members.length}`,
  );
  const [atRisk] = await db.query<{ n: number }>(
    `select count(*)::int as n from stayput.member_risk
      where company_id = $1 and member_id = any(string_to_array($2, ','))
        and level in ('high', 'scheduled_departure')`,
    [C, [...owing, ...leaving].map((m) => m.memberId).join(',')],
  );
  check(
    'Failed payments and scheduled cancellations at the top of the risk list',
    atRisk?.n === owing.length + leaving.length,
    `${atRisk?.n ?? 0}/${owing.length + leaving.length}`,
  );

  let actions = await actionsOf();
  const done = (memberId: string, type: string, statuses = ['sent']) =>
    actions.some((a) => a.member_id === memberId && a.type === type && statuses.includes(a.status));
  // A message in the member's support chat with the community (they have no StayPut space).
  const notified = (userId: string) =>
    calls.some(
      (c) =>
        c.method === 'POST' && c.path === '/messages' && c.body.channel_id === `supp_${userId}`,
    );
  const noticed = owing.filter(
    (m) => done(m.memberId, 'payment_failed_notice') && notified(m.userId),
  );
  check(
    'Failed payment: a notice sent through Whop to each member',
    noticed.length === owing.length,
    `${noticed.length}/${owing.length}`,
  );
  const retries = calls.filter(
    (c) => c.method === 'POST' && /^\/payments\/pay_[A-Za-z0-9]+\/retry$/.test(c.path),
  );
  const [left] = owing;
  check(
    'Failed payment: the one Whop leaves to StayPut retried, once',
    retries.length === 1 && retries[0]!.path.includes(left!.memberId.slice(5)),
    `${retries.length} retry`,
  );
  check(
    'Payment waiting for the bank (3-D Secure): a notice with its link',
    done(checking.memberId, 'payment_action_notice') && notified(checking.userId),
    done(checking.memberId, 'payment_action_notice') ? 'sent' : 'not sent',
  );
  const surveyed = leaving.filter((m) => done(m.memberId, 'exit_survey') && notified(m.userId));
  check(
    'Cancellation scheduled: the departure survey sent to each member',
    surveyed.length === leaving.length,
    `${surveyed.length}/${leaving.length}`,
  );
  const held = inactive.filter((m) => done(m.memberId, 'high_risk_message', ['scheduled', 'sent']));
  check(
    'Inactive: a check-in for each, held for the hour they are usually there',
    held.length === inactive.length,
    `${held.length}/${inactive.length}`,
  );
  const towardQuiet = actions.filter((a) => a.member_id === quiet.memberId);
  check(
    '« Never contact »: nothing for the member on the list',
    !towardQuiet.some((a) => ['scheduled', 'sent'].includes(a.status)) && !notified(quiet.userId),
    towardQuiet.map((a) => `${a.type} ${a.status}`).join(', ') || 'no action',
  );
  check(
    'Newcomer who did nothing yet: a welcome nudge',
    done(idle.memberId, 'welcome_message') && notified(idle.userId),
    done(idle.memberId, 'welcome_message') ? 'sent' : 'not sent',
  );
  const perMember = new Map<string, number>();
  for (const a of actions) {
    if (a.message_kind === 'relance' && ['scheduled', 'sent'].includes(a.status)) {
      perMember.set(a.member_id, (perMember.get(a.member_id) ?? 0) + 1);
    }
  }
  const most = Math.max(0, ...perMember.values());
  check(
    `At most ${DEFAULT_GUARDRAILS.maxMessagesPer5Days} check-in per member in 5 days`,
    most <= DEFAULT_GUARDRAILS.maxMessagesPer5Days,
    `${most} at most`,
  );
  check(
    'Test mode off: nothing merely simulated',
    !actions.some((a) => a.status === 'simulated'),
    `${actions.filter((a) => a.status === 'simulated').length} simulated`,
  );

  // 3. Whop answers: the retried payment comes in; the second one too, at Whop's own retry.
  const filed: string[] = [];
  for (const [k, member] of owing.slice(0, 2).entries()) {
    const [payment] = await db.query<{ id: string; membership_id: string; created: string }>(
      `select id, membership_id, whop_created_at::text as created from stayput.payments
        where company_id = $1 and member_id = $2 and paid_at is null`,
      [C, member.memberId],
    );
    if (!payment) continue;
    const paidAt = at(0.5 + k * 0.25);
    filed.push(
      await deliver(
        `msg_ScenarioPaid${k + 1}`,
        'payment.succeeded',
        {
          id: payment.id,
          membership_id: payment.membership_id,
          member_id: member.memberId,
          currency: 'usd',
          total: { amount: '49.00', currency: 'usd' },
          status: 'paid',
          substatus: 'succeeded',
          created_at: new Date(payment.created).toISOString(),
          paid_at: iso(paidAt),
        },
        paidAt,
      ),
    );
  }
  check(
    'Whop’s deliveries of the payments paid, filed',
    filed.length === 2 && filed.every((status) => status === 'processed'),
    filed.join(', ') || 'none',
  );

  // A member who scheduled their cancellation answers the survey (« too expensive ») and accepts
  // the offer, consenting to keep their membership: StayPut applies it through Whop at once.
  const [stayer] = leaving;
  const answeredAt = at(0.6);
  const answered = await answerSurvey(
    db,
    C,
    await readRetention(db, C, stayer!.userId, answeredAt),
    'too_expensive',
    answeredAt,
  );
  const acceptedAt = at(0.7);
  const decided = answered
    ? await decideOffer(
        db,
        C,
        await readRetention(db, C, stayer!.userId, acceptedAt),
        { accept: true, keep: true },
        acceptedAt,
      )
    : null;
  const offerId = decided && decided !== 'invalid' ? decided.actionId : null;
  if (offerId) {
    await prepareActions(db, C, acceptedAt, { memberSpace: false });
    await executeAction(db, whop, offerId, acceptedAt);
  }
  actions = await actionsOf();
  const offer = actions.find((a) => a.id === offerId);
  const membershipId = `mem_${stayer!.memberId.slice(5)}`;
  const withdrawn = calls.some(
    (c) =>
      c.method === 'PATCH' &&
      c.path === `/memberships/${membershipId}` &&
      c.body.cancel_at_period_end === false,
  );
  check(
    'Survey answered « too expensive »: the offer accepted, the cancellation withdrawn on Whop',
    offer?.status === 'sent' && withdrawn,
    offer ? `${offer.type} ${offer.status}` : 'no offer',
  );

  // 4. The next hour: the money the payments brought back, counted once, on the dashboard.
  const second = await hourly(at(2));
  check(
    'The next hour’s jobs ran',
    second.failed.length === 0,
    `${second.ran.length} ran, ${second.failed.length} failed`,
  );
  const saves = () =>
    db.query<{ save_type: string; amount: string; member_id: string }>(
      `select save_type, amount::text, member_id from stayput.saves where company_id = $1
        order by saved_at`,
      [C],
    );
  const recovered = (await saves()).filter((s) => s.save_type === 'payment_recovered');
  check(
    'Payments recovered: each counted as a save of its amount',
    recovered.length === 2 && recovered.every((s) => Number(s.amount) === 49),
    recovered.map((s) => `$${Number(s.amount)}`).join(' + ') || 'none',
  );
  await hourly(at(3));
  check(
    'A save is never counted twice',
    (await saves()).filter((s) => s.save_type === 'payment_recovered').length === 2,
    `${(await saves()).length} save(s) after one more hour`,
  );
  const dashboard = await readDashboard(db, OWNER, C, at(3));
  check(
    'The dashboard: the money saved this month',
    (dashboard?.saved.thisMonth.direct ?? 0) >= 98,
    `$${dashboard?.saved.thisMonth.direct ?? 0} in ${dashboard?.saved.thisMonth.saves ?? 0} save(s)`,
  );

  // 5. Monday, 9:00: the report of the week, to the team on Whop.
  const monday = nextMondayMorning(at(3));
  await hourly(monday);
  const report = calls.find(
    (c) => c.method === 'POST' && c.path === '/notifications' && c.body.account_id === C,
  );
  const [kept] = await db.query<{ direct: string | null }>(
    `select report -> 'saved' ->> 'direct' as direct from stayput.weekly_reports
      where company_id = $1 and sent_at is not null order by week_start desc limit 1`,
    [C],
  );
  check(
    'Monday report: sent to the team on Whop, with the money saved',
    report !== undefined && Number(kept?.direct ?? 0) >= 98,
    `$${Number(kept?.direct ?? 0)} saved in the week`,
  );

  // 6. The renewal of the member who stayed comes in: the cancellation undone is counted.
  const [period] = await db.query<{ ends: string | null }>(
    'select current_period_end::text as ends from stayput.memberships where id = $1',
    [membershipId],
  );
  const renewal = new Date(
    Math.max(new Date(period?.ends ?? iso(at(24))).getTime(), at(4).getTime()) + HOUR,
  );
  await deliver(
    'msg_ScenarioRenewal',
    'payment.succeeded',
    {
      id: `pay_${stayer!.memberId.slice(5)}renewal`,
      membership_id: membershipId,
      member_id: stayer!.memberId,
      currency: 'usd',
      total: { amount: '39.20', currency: 'usd' },
      status: 'paid',
      substatus: 'succeeded',
      created_at: iso(renewal),
      paid_at: iso(renewal),
    },
    renewal,
  );
  await hourly(new Date(renewal.getTime() + HOUR));
  const reverted = (await saves()).filter((s) => s.save_type === 'cancellation_reverted');
  check(
    'Cancellation withdrawn: the renewal that followed counted as saved',
    reverted.length === 1 && reverted[0]!.member_id === stayer!.memberId,
    reverted.map((s) => `$${Number(s.amount)}`).join(' + ') || 'none',
  );
  const failedRuns = await db.query<{ n: number }>(
    `select count(*)::int as n from stayput.error_log where company_id = $1`,
    [C],
  );
  check(
    'No error recorded for the community',
    (failedRuns[0]?.n ?? 0) === 0,
    `${failedRuns[0]?.n ?? 0} error(s)`,
  );
  return verdicts;
}

/** The verdicts as a Markdown table, for the run's summary. */
export function verdictTable(title: string, verdicts: readonly Verdict[]): string[] {
  return [
    `### ${title}`,
    '',
    '| | Check | Seen |',
    '| --- | --- | --- |',
    ...verdicts.map((v) => `| ${v.ok ? '✅' : '❌'} | ${v.check} | ${v.seen} |`),
    '',
    `${verdicts.filter((v) => v.ok).length} of ${verdicts.length} checks passed.`,
  ];
}
